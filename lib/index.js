import path from 'node:path';
import os from 'node:os';
import { GhostStore } from './core.js';
import { registerGhostRpc } from './transport.js';
import { createUninstaller, readUninstallPending } from './uninstall.js';

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
  const dshHome = config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dataDir = path.resolve(config.dataDir || process.env.GHOST_DATA_DIR ||
    path.join(dshHome, 'ghost'));
  let store;
  let bootError;
  let frozenState;
  let suspended = false;
  let uninstaller;
  let lastUninstallError = '';
  let lastCaptureError = '';
  let captured = 0;
  let disposed = false;
  const queries = new Map();
  const disposers = [];
  const memoryDisposers = [];
  try {
    // Never recreate an identity/database while a confirmed wipe is pending.
    const pending = readUninstallPending(dataDir);
    if (pending) {
      suspended = true;
      frozenState = { ghostId: pending.ghostId, branchId: pending.branchId, version: pending.version };
    } else store = new GhostStore({ dataDir });
  }
  catch (error) { bootError = error; }

  const diagnostic = () => ({
    ghostId: '', branchId: '', version: 0, name: 'Ghost', identity: '',
    traits: { curiosity: 0.5, initiative: 0.5, caution: 0.5 }, goals: [],
    settings: { enabled: false, captureEnabled: false, captureAssistant: false,
      allowedSessions: [], contextBudgetBytes: 6000, topK: 5 },
    counts: { events: 0, changes: 0 }, lastCheckpoint: null,
    health: { ok: false, readOnly: true, error: bootError?.message || 'Ghost 未启动' },
  });
  const stopGhost = async () => {
    suspended = true;
    queries.clear();
    if (store) { frozenState = store.status(); store.close(); store = null; }
    for (const dispose of memoryDisposers.splice(0).reverse()) {
      try { if (typeof dispose === 'function') await dispose(); } catch { /* base chat continues */ }
    }
  };
  try {
    uninstaller = createUninstaller({ dataDir, dshHome, desktopExecutable: config.desktopExecutable || process.execPath,
      ...config.uninstallOptions, getState: () => store ? store.status() : frozenState || diagnostic(), stopGhost });
  } catch (error) {
    lastUninstallError = error.message;
    uninstaller = { pending: suspended, describe: () => ({ available: false, pending: suspended, reason: error.message }),
      plan() { throw error; }, confirm() { throw error; }, resume() { throw error; } };
  }
  const status = () => {
    const current = store ? store.status() : { ...diagnostic(), ...frozenState };
    if (suspended) {
      current.settings = { ...current.settings, enabled: false, captureEnabled: false };
      if (uninstaller.pending) current.health = { ok: true, readOnly: true, error: null };
    }
    return { ...current, running: !suspended && current.settings.enabled && current.settings.captureEnabled,
      uninstall: { ...uninstaller.describe(), ...(lastUninstallError ? { error: lastUninstallError } : {}) },
      bridge: { capturedThisRun: captured, lastCaptureError, runtime: process.version } };
  };
  const close = async () => {
    if (disposed) return;
    disposed = true;
    await stopGhost();
    for (const dispose of disposers.reverse()) {
      try { if (typeof dispose === 'function') await dispose(); } catch { /* best effort cleanup */ }
    }
  };
  const endpoints = new Set(['status', 'start', 'stop', 'configure', 'search', 'checkpoint', 'verify', 'export',
    'uninstallplan', 'uninstallconfirm', 'uninstallretry']);
  const handler = async (endpoint, payload, signal) => {
    if (disposed || signal?.aborted) return failed('CANCELLED', '请求已取消');
    const action = endpoint;
    if (!endpoints.has(action)) return failed('NOT_FOUND', '未知的 Ghost 操作');
    try {
      if (payload === null || payload === undefined) payload = {};
      if (typeof payload !== 'object' || Array.isArray(payload)) return failed('INVALID_REQUEST', '请求须为对象');
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 65536) return failed('REQUEST_TOO_LARGE', '请求超过 64 KiB');
      if (action === 'status') return { ok: true, value: status() };
      if (action === 'uninstallplan') return { ok: true, value: uninstaller.plan() };
      if (action === 'uninstallconfirm' || action === 'uninstallretry') {
        const value = await (action === 'uninstallconfirm' ? uninstaller.confirm(payload) : uninstaller.resume());
        lastUninstallError = value.launchError || '';
        return { ok: true, value };
      }
      if (uninstaller.pending || suspended) return failed('UNINSTALL_PENDING', 'Ghost 已停用，等待正常退出 DSH 后完成卸载');
      if (!store) return failed('UNAVAILABLE', diagnostic().health.error);
      let value;
      if (action === 'start' || action === 'stop') {
        if (Object.keys(payload).length) return failed('INVALID_REQUEST', '启动与关闭不接受其他设置');
        store.configure({ settings: action === 'start'
          ? { enabled: true, captureEnabled: true, captureAssistant: true, allowedSessions: [], contextBudgetBytes: 6000, topK: 8 }
          : { enabled: false, captureEnabled: false } }, store.status().version);
        value = status();
      } else if (action === 'configure') {
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
      else if (action === 'export') value = store.exportCore();
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
    if (!store || disposed || suspended || !sessionId) return false;
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
  memoryDisposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent?.session?.header?.origin === 'subagent') return;
    if (message?.source?.kind !== 'user') return;
    try { rememberQuery(agent?.id, visibleText(message)); } catch { /* base chat continues */ }
  }));
  memoryDisposers.push(ctx.on('session/event', (session, event) => {
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
  memoryDisposers.push(ctx.systemPrompt.variable('ghost_context', assembly => {
    try {
      const sessionId = assembly?.agent?.id;
      if (assembly?.agent?.session?.header?.origin === 'subagent') return '';
      if (!allowed(sessionId)) return '';
      return store.compose(queries.get(sessionId) || '');
    } catch { return ''; }
  }));
  memoryDisposers.push(ctx.systemPrompt.context({ name: 'ghost:memory', order: 130, text: '{{ghost_context}}' }));
  if (uninstaller.pending) {
    void Promise.resolve().then(() => uninstaller.resume()).then(result => {
      lastUninstallError = result.launchError || '';
    }).catch(error => { lastUninstallError = error.message; });
  }

  } catch (error) {
    void close();
    throw error;
  }
}
