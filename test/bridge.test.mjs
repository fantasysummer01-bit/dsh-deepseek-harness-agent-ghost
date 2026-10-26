import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, visibleEvent, visibleText } from '../lib/index.js';
import { GhostStore } from '../lib/core.js';
import { invokeRoute } from '../scripts/testing/rpc-probe.mjs';

test('captures only explicitly sourced visible human/model text', () => {
  const session = { id: 's1' };
  const message = { source: { kind: 'user' }, content: [{ type: 'text', text: '公园里有猫' }, { type: 'image', data: 'private' }] };
  const base = { seq: 7, time: Date.now(), surfaceOp: 'append', type: 'user/message', data: message };
  assert.equal(visibleEvent(session, base).text, '公园里有猫');
  for (const kind of ['plugin', 'tool', 'context', undefined]) {
    assert.equal(visibleEvent(session, { ...base, data: { ...message, source: { kind } } }), null);
  }
  assert.equal(visibleEvent(session, { ...base, surfaceOp: 'replace' }), null);
  assert.equal(visibleEvent(session, { ...base, surfaceOp: undefined }), null);
  assert.equal(visibleEvent(session, { ...base, type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'thinking', text: 'secret' }, { type: 'text', text: '可见答复' }] } } }).text, '可见答复');
  assert.equal(visibleEvent({ id: 'child', header: { origin: 'subagent' } }, base), null);
  assert.equal(visibleText({ content: [{ type: 'tool-call', arguments: 'secret' }] }), '');
});

test('native RPC, consent, evidence context, optimistic save and unload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-'));
  const events = new Map();
  let handler, provider, context, cleanup;
  let removed = 0;
  const ctx = {
    connection: { requestRejection() { return undefined; } },
    webServer: { register(route) {
      assert.equal(route.path, '/ghost'); assert.equal(route.kind, 'prefix');
      handler = route; return () => { removed++; };
    } },
    on(event, callback) { events.set(event, callback); return () => { events.delete(event); }; },
    systemPrompt: {
      variable(name, fn) { assert.equal(name, 'ghost_context'); provider = fn; return () => {}; },
      context(spec) { context = spec; return () => {}; },
    },
    effect(fn) { cleanup = fn(); },
  };
  try {
    apply(ctx, { dataDir: dir });
    const call = (action, value = {}) => invokeRoute(handler, action, value);
    let status = (await call('status')).value;
    assert.equal(status.settings.captureEnabled, false);
    assert.equal(context.text, '{{ghost_context}}');
    const session = { id: 's1' };
    const event = { seq: 1, time: Date.now(), surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '昨天在公园看到猫' }] } };
    events.get('session/event')(session, event);
    assert.equal((await call('status')).value.counts.events, 0);
    const saved = await call('configure', { expectedVersion: status.version, patch: { name: 'Ghost 测试', settings: { captureEnabled: true } } });
    assert.equal(saved.ok, true);
    status = saved.value;
    events.get('agent/inbox/claimed')({ agent: { id: 's1' }, message: event.data });
    events.get('session/event')(session, event);
    assert.equal((await call('status')).value.counts.events, 1);
    const evidence = await call('search', { query: '公园' });
    assert.equal(evidence.ok, true); assert.equal(evidence.value.length, 1);
    assert.match(provider({ agent: { id: 's1' } }), /公园/);
    assert.equal(provider({}), '');
    assert.equal(provider({ agent: { id: 's1', session: { header: { origin: 'subagent' } } } }), '');
    const stale = await call('configure', { expectedVersion: 0, patch: { name: 'stale' } });
    assert.equal(stale.ok, false); assert.equal(stale.error.code, 'VERSION_CONFLICT');
    assert.equal((await call('nonexistent')).error.code, 'NOT_FOUND');
    assert.equal((await call('configure', 'invalid')).error.code, 'INVALID_REQUEST');
    assert.equal((await call('checkpoint')).ok, true);
    assert.equal((await call('verify')).ok, true);
    assert.equal((await call('export')).ok, true);
    await cleanup();
    assert.equal(removed, 1); assert.equal(events.size, 0);
  } finally { if (cleanup) await cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed host registration releases the writer lease for the next load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-registration-'));
  try {
    assert.throws(() => apply({
      effect() {},
      webServer: { register() { throw new Error('channel already owned'); } },
    }, { dataDir: dir }), /channel already owned/);
    const store = new GhostStore({ dataDir: dir });
    assert.equal(store.status().health.ok, true);
    store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
