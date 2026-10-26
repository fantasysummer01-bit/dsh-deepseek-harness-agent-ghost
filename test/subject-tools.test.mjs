import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSubjectTools } from '../lib/subject-tools.js';

function fixture() {
  const tools = new Map(), calls = [];
  let running = true, available = true, version = 7;
  const view = sessionId => ({ ghostId: 'one-ghost', subjectVersion: version,
    channel: sessionId === 'known-chat' ? { sessionId, ownerGhostId: 'one-ghost' } : null, tasks: [] });
  const store = {
    status: () => ({ health: { ok: true, readOnly: false }, settings: { enabled: running, captureEnabled: running } }),
    subjectView(options) { calls.push(['read', options]); return view(options.sessionId); },
    subjectCommand(command, options) {
      if (command.expectedSubjectVersion !== version) throw Object.assign(new Error('stale state'), { code: 'SUBJECT_VERSION_CONFLICT' });
      calls.push(['write', command, options]); version++; return view(options.sessionId);
    },
  };
  const ctx = { tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } };
  const dispose = registerSubjectTools(ctx, { getStore: () => available ? store : null, allowed: () => running });
  const exec = { agent: { id: 'agent-carrier', session: { id: 'known-chat' } }, signal: new AbortController().signal };
  return { tools, calls, exec, dispose, setRunning: value => { running = value; }, setAvailable: value => { available = value; } };
}
const command = patch => ({ action: 'create', title: 'Finish the report', evidenceIds: ['saved-human-event'], expectedSubjectVersion: 7, ...patch });

test('Ghost tools expose explicit schemas and use the trusted execution session', () => {
  const f = fixture();
  const state = f.tools.get('ghost_state');
  const result = state.execute({ query: 'report' }, f.exec);
  assert.equal(result.ghostId, 'one-ghost');
  assert.deepEqual(f.calls.at(-1), ['read', { sessionId: 'known-chat', query: 'report' }]);
  assert.deepEqual(state.output.render({}, result), [{ type: 'text', text: JSON.stringify(result) }]);
  assert.equal(state.isConcurrencySafe(), true);
  assert.equal(f.tools.get('ghost_task').isConcurrencySafe(), false);
  assert.equal(state.parameters.additionalProperties, false);
});

test('model task writes preserve evidence and optimistic version, without promoting completion claims', () => {
  const f = fixture(), task = f.tools.get('ghost_task');
  const proposed = command({ action: 'update', taskId: 'task-one', status: 'completed', note: 'Model says it is done' });
  const result = task.execute(proposed, f.exec);
  assert.equal(result.subjectVersion, 8);
  assert.deepEqual(f.calls.at(-1), ['write', proposed, { sessionId: 'known-chat' }]);
  assert.throws(() => task.execute(proposed, f.exec), { code: 'SUBJECT_VERSION_CONFLICT' });
  // The adapter never adds an actor, verified flag or external execution claim.
  assert.equal('verified' in f.calls.find(row => row[0] === 'write')[1], false);
});

test('missing or foreign sessions and subagents cannot access Ghost tools', () => {
  const f = fixture(), state = f.tools.get('ghost_state');
  for (const exec of [{}, { agent: {} }, { agent: { id: 'known-chat' } },
    { agent: { session: { id: 'foreign-chat' } } },
    { agent: { session: { id: 'known-chat', header: { origin: 'subagent' } } } }]) {
    assert.throws(() => state.execute({}, exec), { code: 'UNKNOWN_CHANNEL' });
  }
  assert.equal(f.calls.some(row => row[0] === 'write'), false);
});

test('shutdown, uninstall and aborted calls use live availability instead of a stale store', async () => {
  const f = fixture(), task = f.tools.get('ghost_task');
  f.setRunning(false); assert.throws(() => task.execute(command(), f.exec), { code: 'GHOST_UNAVAILABLE' });
  f.setRunning(true); f.setAvailable(false); assert.throws(() => task.execute(command(), f.exec), { code: 'GHOST_UNAVAILABLE' });
  f.setAvailable(true);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => task.execute(command(), { ...f.exec, signal: controller.signal }), { code: 'CANCELLED' });
  await f.dispose(); await f.dispose(); assert.equal(f.tools.size, 0);
  assert.throws(() => task.execute(command(), f.exec), { code: 'CANCELLED' });
});

test('tools reject authority fields, oversized input and unsupported task transitions before a write', () => {
  const f = fixture(), task = f.tools.get('ghost_task');
  for (const patch of [{ actor: 'user' }, { verified: true }, { sessionId: 'other' }, { settings: { enabled: true } },
    { expectedSubjectVersion: undefined }, { expectedSubjectVersion: -1 }, { evidenceIds: [] },
    { evidenceIds: ['duplicate', 'duplicate'] }, { evidenceIds: Array.from({ length: 9 }, (_, n) => 'e-' + n) },
    { note: 'x'.repeat(321) }, { title: 'x'.repeat(161) }, { action: 'execute' },
    { action: 'update', taskId: undefined }, { status: 'verified' }, { action: 'report', taskId: 't', note: undefined }]) {
    assert.throws(() => task.execute(command(patch), f.exec), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => f.tools.get('ghost_state').execute({ query: 'x'.repeat(201) }, f.exec), { code: 'INVALID_REQUEST' });
  assert.throws(() => f.tools.get('ghost_state').execute({ sessionId: 'other' }, f.exec), { code: 'INVALID_REQUEST' });
  assert.equal(f.calls.some(row => row[0] === 'write'), false);
});

test('a failed second registration cleans up the first tool', async () => {
  const registrations = new Set();
  const ctx = { tools: { register(definition) {
    if (definition.name === 'ghost_task') throw new Error('already registered');
    registrations.add(definition.name); return () => registrations.delete(definition.name);
  } } };
  assert.throws(() => registerSubjectTools(ctx, { getStore() {}, allowed() {} }), /already registered/);
  assert.equal(registrations.size, 0);
});
