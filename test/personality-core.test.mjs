import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GhostStore, canonical } from '../lib/core.js';
import { deriveSelfUnderstanding as legacy } from '../lib/identity-growth-v1.js';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const at = n => new Date(Date.UTC(2026, 8, 1 + n, 12)).toISOString();
const event = (n, text, extra = {}) => ({ eventId: 'p-' + n, sessionId: 'one-conversation',
  role: 'user', source: 'dsh:user', timestamp: at(n), text, ...extra });

// Produce real v1 snapshots/changes using the frozen old derivation. Only the
// empty synthetic genesis is adjusted before any evidence has been written.
class LegacyStore extends GhostStore {
  _initialize() {
    super._initialize();
    const row = this.db.prepare('SELECT * FROM ledger WHERE seq=1').get();
    const payload = JSON.parse(row.payload);
    payload.state.selfUnderstanding = legacy([]);
    const encoded = canonical(payload);
    const hash = digest({ version: row.version, kind: row.kind, payload: encoded, prevHash: row.prev_hash,
      createdAt: row.created_at, lastEventSeq: row.last_event_seq });
    this.db.prepare('UPDATE ledger SET payload=?,hash=? WHERE seq=1').run(encoded, hash);
    this.db.prepare('UPDATE state SET json=? WHERE singleton=1').run(canonical(payload.state));
    this._state = payload.state;
  }
  _refreshSelfUnderstanding() {
    if (!this._state.settings.enabled) return false;
    const next = legacy(this._allEvents(), this._state.selfUnderstanding);
    if (canonical(next) === canonical(this._state.selfUnderstanding)) return false;
    this._append('identity_growth', { ...this._state, version: this._state.version + 1, selfUnderstanding: next },
      { derivation: 'long_term_chat_rules_v1', evidenceIds: next.evidenceIds });
    return true;
  }
}

function fixture(t, Type = GhostStore) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-personality-core-'));
  const dataDir = path.join(root, 'data'), stores = [];
  const open = (Constructor = GhostStore) => { const store = new Constructor({ dataDir }); stores.push(store); return store; };
  t.after(() => { for (const store of stores.reverse()) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store: open(Type), open, dataDir };
}
const enable = store => store.configure({ settings: { enabled: true, captureEnabled: true } }, store.status().version);

test('one conversation develops a sourced personality across time and resumes without further drift', t => {
  const { store, open } = fixture(t); enable(store);
  for (let n = 0; n < 3; n++) store.ingest(event(n, '我们又来聊编程。请回答简洁一点，语气温和。'));
  const state = store.status();
  assert.equal(state.selfUnderstanding.ruleVersion, 2);
  assert.equal(state.selfUnderstanding.status, 'established');
  assert.equal(state.selfUnderstanding.sessionCount, 1);
  assert.ok(state.selfUnderstanding.episodeCount >= 3);
  assert.ok(state.selfUnderstanding.topics.some(item => item.key === 'programming'));
  assert.equal(store.verify().ok, true);
  store.checkpoint(); const before = store.exportData(); store.close();
  const restored = open();
  assert.equal(restored.status().ghostId, state.ghostId);
  assert.deepEqual(restored.status().selfUnderstanding, state.selfUnderstanding);
  assert.deepEqual(restored.exportData().ledger, before.ledger);
});

test('v1 audit and checkpoint survive migration without suddenly erasing valid old personality', t => {
  const { store, open } = fixture(t, LegacyStore); enable(store);
  for (let n = 0; n < 3; n++) store.ingest(event(n, '以后叫你小影。请回答简洁一点。我们聊猫。',
    { sessionId: 'old-window-' + n, timestamp: at(0) }));
  store.checkpoint(); const old = store.exportData(), id = store.status().ghostId;
  assert.equal(old.state.selfUnderstanding.displayName, '小影'); store.close();
  const migrated = open(), next = migrated.exportData();
  assert.equal(migrated.verify().ok, true);
  assert.equal(migrated.status().ghostId, id);
  assert.equal(migrated.status().selfUnderstanding.ruleVersion, 2);
  assert.equal(migrated.status().selfUnderstanding.displayName, '小影');
  assert.ok(migrated.status().selfUnderstanding.topics.some(item => item.key === 'cats'));
  assert.deepEqual(next.ledger.slice(0, old.ledger.length), old.ledger);
  assert.deepEqual(next.checkpoints, old.checkpoints);
  assert.equal(JSON.parse(next.ledger.at(-1).payload).derivation, 'long_term_chat_rules_v2');
  assert.deepEqual(next.state.traits, old.state.traits);
  assert.deepEqual(next.state.settings, old.state.settings);
  const stable = migrated.status().selfUnderstanding; migrated.close();
  assert.deepEqual(open().status().selfUnderstanding, stable);
});

test('disabled v1 state stays unchanged until start; migration is appended only once', t => {
  const { store, open } = fixture(t, LegacyStore); enable(store);
  for (let n = 0; n < 3; n++) store.ingest(event(n, '我们聊音乐。'));
  store.configure({ settings: { enabled: false, captureEnabled: false } }, store.status().version);
  const old = store.exportData(); store.close();
  const stopped = open();
  assert.equal(stopped.status().selfUnderstanding.ruleVersion, 1);
  assert.deepEqual(stopped.exportData().ledger, old.ledger);
  enable(stopped);
  assert.equal(stopped.status().selfUnderstanding.ruleVersion, 2);
  const version = stopped.status().version; stopped.close();
  assert.equal(open().status().version, version);
});

test('v2 learning remains atomic with source capture and never changes approved traits or settings', t => {
  const { store } = fixture(t); enable(store);
  store.ingest(event(0, '请多提问题，保持好奇。'));
  store.ingest(event(1, '请多提问题，保持好奇。'));
  const before = store.exportData();
  store.db.exec("CREATE TEMP TRIGGER fail_personality BEFORE INSERT ON ledger WHEN NEW.kind='identity_growth' BEGIN SELECT RAISE(ABORT,'personality failure'); END");
  assert.throws(() => store.ingest(event(2, '请多提问题，保持好奇。')), /personality failure/);
  const after = store.exportData();
  assert.deepEqual(after.events, before.events); assert.deepEqual(after.ledger, before.ledger);
  assert.deepEqual(after.state, before.state); assert.equal(store.verify().ok, true);
});

test('a mismatched rule version is refused even when the changed local checksum is recomputed', t => {
  const { store } = fixture(t); enable(store);
  for (let n = 0; n < 3; n++) store.ingest(event(n, '我们聊园艺。请回答简洁。'));
  const row = store.db.prepare("SELECT * FROM ledger WHERE kind='identity_growth' ORDER BY seq DESC LIMIT 1").get();
  const payload = JSON.parse(row.payload); payload.state.selfUnderstanding.ruleVersion = 1;
  const encoded = canonical(payload);
  const hash = digest({ version: row.version, kind: row.kind, payload: encoded, prevHash: row.prev_hash,
    createdAt: row.created_at, lastEventSeq: row.last_event_seq });
  store.db.prepare('UPDATE ledger SET payload=?,hash=? WHERE seq=?').run(encoded, hash, row.seq);
  const report = store.verify(); assert.equal(report.ok, false); assert.match(report.error, /CORRUPT_IDENTITY/);
});

test('learned behavior reaches the model context without altering approved traits or permissions', t => {
  const { store, open } = fixture(t); enable(store);
  const approved = store.status();
  for (let n = 0; n < 4; n++) store.ingest(event(n, '请先验证再回答。请更主动提建议。请多提问题，保持好奇。'));
  const learned = store.status().selfUnderstanding.behavioralTraits;
  assert.ok(learned.values.caution > 0.5); assert.ok(learned.values.initiative > 0.5);
  assert.ok(learned.evidence.curiosity.length >= 3);
  assert.deepEqual(store.status().traits, approved.traits);
  assert.deepEqual(store.status().settings, approved.settings);
  const context = store.compose('', { sessionId: 'one-conversation' });
  assert.match(context, /learnedBehavioralTraits/); assert.match(context, /"grantsExecutionPermission":false/);
  assert.ok(Buffer.byteLength(context, 'utf8') <= approved.settings.contextBudgetBytes);
  const version = store.status().version; store.close();
  const restored = open(); assert.equal(restored.status().version, version);
  assert.deepEqual(restored.status().selfUnderstanding.behavioralTraits, learned);
});

test('failed personality migration preserves the entire old audit instead of partially upgrading', t => {
  const { store, open } = fixture(t, LegacyStore); enable(store);
  for (let n = 0; n < 3; n++) store.ingest(event(n, '请回答简洁一点。我们聊猫。',
    { sessionId: 'old-' + n, timestamp: at(0) }));
  store.checkpoint(); const before = store.exportData();
  store.db.exec("CREATE TRIGGER block_personality_upgrade BEFORE INSERT ON ledger WHEN NEW.kind='identity_growth' BEGIN SELECT RAISE(ABORT,'blocked upgrade'); END");
  store.close(); const failed = open();
  assert.equal(failed.status().health.readOnly, true); assert.match(failed.status().health.error, /blocked upgrade/);
  assert.equal(failed.status().selfUnderstanding.ruleVersion, 1);
  assert.deepEqual(failed.db.prepare('SELECT * FROM ledger ORDER BY seq').all(), before.ledger);
  assert.deepEqual(failed.db.prepare('SELECT * FROM checkpoints ORDER BY seq').all(), before.checkpoints);
  assert.deepEqual(JSON.parse(failed.db.prepare('SELECT json FROM state WHERE singleton=1').get().json), before.state);
});

test('withdrawn old habits reach the model as corrections and remain withdrawn after restart', t => {
  const { store, open } = fixture(t); enable(store);
  for (let n = 0; n < 3; n++) store.ingest(event(n, '请回答简洁一点。'));
  assert.ok(store.status().selfUnderstanding.expression.some(item => item.key === 'concise'));
  for (let n = 3; n < 6; n++) store.ingest(event(n, '以后不要简洁回答。'));
  const personality = store.status().selfUnderstanding;
  assert.equal(personality.expression.some(item => item.key === 'concise'), false);
  assert.ok(personality.expressionCorrections.some(item => item.key === 'concise'));
  assert.match(store.compose('', { sessionId: 'one-conversation' }), /"withdrawnExpression":\["简洁"\]/);
  assert.equal(store.verify().ok, true); store.close();
  assert.deepEqual(open().status().selfUnderstanding, personality);
});

test('a consistent old-rule record cannot silently downgrade a migrated personality', t => {
  const { store } = fixture(t); enable(store);
  for (let n = 0; n < 3; n++) store.ingest(event(n, '我们聊猫。'));
  assert.equal(store.status().selfUnderstanding.ruleVersion, 2);
  const old = legacy(store._allEvents(), store._state.selfUnderstanding);
  store._transaction(() => store._append('identity_growth', { ...store._state,
    version: store._state.version + 1, selfUnderstanding: old },
  { derivation: 'long_term_chat_rules_v1', evidenceIds: old.evidenceIds }));
  const result = store.verify();
  assert.equal(result.ok, false); assert.match(result.error, /cannot silently downgrade/);
});
