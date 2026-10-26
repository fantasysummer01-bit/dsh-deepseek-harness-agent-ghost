import path from 'node:path';
import os from 'node:os';
import { GhostStore } from './core.js';
import { registerGhostRpc } from './transport.js';

export const name = 'dsh-ghost';
export const inject = ['connection', 'webServer', 'sessions', 'systemPrompt'];

// Only visible text, never reasoning, tool calls, images or injected context.
export function visibleText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

export function visibleEvent(session, event) {
  if (!session || typeof session.id !== 'string' || !Number.isSafeInteger(event?.seq)) return null;
  if (event.surfaceOp !== 'append') return null;
  if (session.header?.origin === 'subagent') return null;
  const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
  if (!role) return null;
  const message = role === 'user' ? event.data : event.data?.message;
  if (message?.source?.kind !== (role === 'user' ? 'user' : 'model')) return null;
  const text = visibleText(message);
  if (!text.trim()) return null;
  const time = new Date(event.time);
  if (!Number.isFinite(time.getTime())) return null;
  return {
    eventId: `dsh:${session.id}:${event.seq}:${event.type}`,
    sessionId: session.id, role, text,
    source: role === 'user' ? 'dsh:user' : 'dsh:model',
    timestamp: time.toISOString(),
  };
}

function failed(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

export function apply(ctx, config = {}) {
  const dataDir = path.resolve(config.dataDir || process.env.GHOST_DATA_DIR ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ghost'));
  let store;
  let bootError;
  let lastCaptureError = '';
  let captured = 0;
  let disposed = false;
  const queries = new Map();
  const disposers = [];
  try { store = new GhostStore({ dataDir }); }
  catch (error) { bootError = error; }

  const diagnostic = () => ({
    ghostId: '', branchId: '', version: 0, name: 'Ghost', identity: '',
    traits: { curiosity: 0.5, initiative: 0.5, caution: 0.5 }, goals: [],
    settings: { enabled: false, captureEnabled: false, captureAssistant: false,
      allowedSessions: [], contextBudgetBytes: 6000, topK: 5 },
    counts: { events: 0, changes: 0 }, lastCheckpoint: null,
    health: { ok: false, readOnly: true, error: bootError?.message || 'Ghost 未启动' },
  });
  const status = () => ({ ...(store ? store.status() : diagnostic()),
    bridge: { capturedThisRun: captured, lastCaptureError, runtime: process.version } });
  const close = async () => {
    if (disposed) return;
    disposed = true;
    queries.clear();
    store?.close();
    for (const dispose of disposers.reverse()) {
      try { if (typeof dispose === 'function') await dispose(); } catch { /* best effort cleanup */ }
    }
  };
  const endpoints = new Set(['status', 'configure', 'search', 'checkpoint', 'verify', 'export']);
  const handler = async (endpoint, payload, signal) => {
    if (disposed || signal?.aborted) return failed('CANCELLED', '请求已取消');
    const action = endpoint;
    if (!endpoints.has(action)) return failed('NOT_FOUND', '未知的 Ghost 操作');
    try {
      if (payload === null || payload === undefined) payload = {};
      if (typeof payload !== 'object' || Array.isArray(payload)) return failed('INVALID_REQUEST', '请求须为对象');
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 65536) return failed('REQUEST_TOO_LARGE', '请求超过 64 KiB');
      if (action === 'status') return { ok: true, value: status() };
      if (!store) return failed('UNAVAILABLE', diagnostic().health.error);
      let value;
      if (action === 'configure') {
        store.configure(payload.patch, payload.expectedVersion);
        value = status();
      } else if (action === 'search') {
        if (typeof payload.query !== 'string' || payload.query.length > 200) return failed('INVALID_REQUEST', '检索词长度须在 0–200 之间');
        value = store.recall(payload.query);
      } else if (action === 'checkpoint') {
        value = store.checkpoint();
        const report = store.verify();
        if (!report.ok) return failed('VERIFICATION_FAILED', report.error || '检查点校验失败');
      }
      else if (action === 'verify') value = store.verify();
      else if (action === 'export') value = store.exportData();
      return { ok: true, value };
    } catch (error) {
      return failed(error.code || 'GHOST_ERROR', error.message || 'Ghost 操作失败');
    }
  };

  // Connection owns trust/authentication and IPC; the wrapper preserves its RPC envelope.
  try {
  ctx.effect(() => close);
  disposers.push(registerGhostRpc(ctx, handler));

  const allowed = sessionId => {
    if (!store || disposed || !sessionId) return false;
    const state = store.status();
    return state.health.ok && state.settings.enabled &&
      (!state.settings.allowedSessions.length || state.settings.allowedSessions.includes(sessionId));
  };
  const rememberQuery = (sessionId, text) => {
    if (!allowed(sessionId) || !text.trim()) return;
    queries.delete(sessionId);
    queries.set(sessionId, text.slice(0, 2000));
    while (queries.size > 64) queries.delete(queries.keys().next().value);
  };
  // claim is emitted before prompt assembly. This caches only the current query;
  // evidence is captured exclusively from the committed session/event stream.
  disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent?.session?.header?.origin === 'subagent') return;
    if (message?.source?.kind !== 'user') return;
    try { rememberQuery(agent?.id, visibleText(message)); } catch { /* base chat continues */ }
  }));
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      const item = visibleEvent(session, event);
      if (!item || !allowed(item.sessionId)) return;
      if (item.role === 'user') rememberQuery(item.sessionId, item.text);
      const state = store.status();
      if (!state.settings.captureEnabled || (item.role === 'assistant' && !state.settings.captureAssistant)) return;
      const result = store.ingest(item);
      if (result.accepted && !result.duplicate) captured++;
      lastCaptureError = '';
    } catch (error) {
      lastCaptureError = String(error.code || 'CAPTURE_FAILED') + ': ' + error.message;
      // Do not print private messages or abort the host's already committed turn.
    }
  }));

  // Interpolate once through a variable: arbitrary {{...}} inside evidence is
  // data, never another template invocation on older DSH releases.
  disposers.push(ctx.systemPrompt.variable('ghost_context', assembly => {
    try {
      const sessionId = assembly?.agent?.id;
      if (assembly?.agent?.session?.header?.origin === 'subagent') return '';
      if (!allowed(sessionId)) return '';
      return store.compose(queries.get(sessionId) || '');
    } catch { return ''; }
  }));
  disposers.push(ctx.systemPrompt.context({ name: 'ghost:memory', order: 130, text: '{{ghost_context}}' }));

  } catch (error) {
    void close();
    throw error;
  }
}
