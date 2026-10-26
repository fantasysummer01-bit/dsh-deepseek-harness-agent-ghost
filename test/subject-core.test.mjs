import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GhostStore, canonical } from '../lib/core.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-subject-core-'));
  const dataDir = path.join(root, 'data'), stores = [];
  const open = () => { const value = new GhostStore({ dataDir }); stores.push(value); return value; };
  t.after(() => { for (const value of stores.reverse()) value.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = open();
  store.configure({ settings: { enabled: true, captureEnabled: true, captureAssistant: true } }, store.status().version);
  return { store, open, dataDir };
}
const message = (eventId, sessionId, text, extra = {}) => ({ eventId, sessionId, text,
  role: 'user', source: 'dsh:user', timestamp: '2026-07-01T12:00:00Z', ...extra });

test('conversation channels share one subject while ambiguous updates remain local', t => {
  const { store } = fixture(t);
  store.ingest(message('report', 'a', '请帮我整理项目报告。'));
  store.ingest(message('app', 'b', '请帮我开发天气应用。'));
  const a = store.subjectView({ sessionId: 'a' }), b = store.subjectView({ sessionId: 'b' });
  assert.equal(a.ghostId, b.ghostId); assert.equal(a.activeTaskCount, 2);
  assert.notEqual(a.channelTasks[0].id, b.channelTasks[0].id);
  store.ingest(message('done-a', 'a', '完成了。'));
  assert.equal(store.subjectView({ sessionId: 'a' }).channelTasks[0].status, 'completed');
  assert.equal(store.subjectView({ sessionId: 'b' }).channelTasks[0].status, 'pending');
  store.ingest(message('another-b', 'b', '请帮我修复数据库连接。'));
  store.ingest(message('ambiguous-b', 'b', '完成了。'));
  assert.equal(store.subjectView({ sessionId: 'b' }).channelTasks.filter(task => task.status === 'pending').length, 2);
  assert.equal(store.verify().ok, true);
});

test('unsettled work survives aging, checkpoint recovery and export; prompt assembly is read-only', t => {
  const { store, open } = fixture(t);
  store.ingest(message('request', 'work', '请帮我完成迁移项目。'));
  store.ingest(message('promise', 'work', '我会继续处理迁移项目。', { role: 'assistant', source: 'dsh:model' }));
  const view = store.subjectView({ sessionId: 'work' });
  store.checkpoint(); const id = store.status().ghostId; store.close();
  const restored = open();
  assert.equal(restored.status().ghostId, id);
  assert.deepEqual(restored.subjectView({ sessionId: 'work' }), view);
  const before = restored.exportData();
  const context = restored.compose('接着做', { sessionId: 'work' });
  assert.match(context, /one persistent Ghost/); assert.match(context, /迁移项目/);
  assert.match(context, /lastSourceEventId/); assert.match(context, /Open obligations survive memory aging/);
  restored.compose('换一个话题', { sessionId: 'new-window' });
  assert.deepEqual(restored.exportData().ledger, before.ledger);
  assert.equal(restored.exportCore().state.subject.tasks.length, 1);
  assert.equal(restored.exportCore().state.subject.commitments.length, 1);
  assert.ok(Buffer.byteLength(context, 'utf8') <= restored.status().settings.contextBudgetBytes);
});

test('model progress is a report and stale parallel writes cannot replace newer work', t => {
  const { store, open } = fixture(t);
  store.ingest(message('request', 'a', '请帮我完成工程报告。'));
  const first = store.subjectView({ sessionId: 'a' }), taskId = first.channelTasks[0].id;
  const report = store.subjectCommand({ action: 'update', taskId, status: 'completed', evidenceIds: ['request'],
    expectedSubjectVersion: first.subjectVersion }, { sessionId: 'a' });
  assert.equal(report.channelTasks[0].status, 'pending');
  assert.equal(report.channelTasks[0].lastReport.claimStatus, 'model_claim');
  store.ingest(message('other-request', 'b', '请帮我分析数据库。'));
  const before = store.exportData();
  assert.throws(() => store.subjectCommand({ action: 'report', taskId, note: '迟到的结果', evidenceIds: ['request'],
    expectedSubjectVersion: report.subjectVersion }, { sessionId: 'a' }), { code: 'SUBJECT_VERSION_CONFLICT' });
  assert.deepEqual(store.exportData().ledger, before.ledger);
  const current = store.subjectView({ sessionId: 'a' });
  store.subjectCommand({ action: 'update', taskId, note: '仍在检查结果', evidenceIds: ['request'],
    expectedSubjectVersion: current.subjectVersion }, { sessionId: 'a' });
  const snapshot = store.subjectView({ sessionId: 'a' }); store.close();
  const recovered = open(); assert.equal(recovered.verify().ok, true);
  assert.deepEqual(recovered.subjectView({ sessionId: 'a' }), snapshot);
});

test('subject transition failure rolls back captured evidence, learned identity and task state', t => {
  const { store } = fixture(t), before = store.exportData();
  store.db.exec("CREATE TEMP TRIGGER fail_subject BEFORE INSERT ON ledger WHEN NEW.kind='subject_event' BEGIN SELECT RAISE(ABORT,'subject failure'); END");
  assert.throws(() => store.ingest(message('request', 'a', '请帮我完成报告。')), /subject failure/);
  const after = store.exportData();
  assert.deepEqual(after.state, before.state); assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.ledger, before.ledger); assert.equal(store.verify().ok, true);
});

// Reconstruct the schema-1 snapshots understood by 0.2.1, omitting only the new
// subject transitions. This synthetic fixture contains no user data.
function makeLegacy(store) {
  const exported = store.exportData(), kept = [], byOldSeq = new Map();
  let previous = '0'.repeat(64);
  for (const row of exported.ledger.filter(row => !row.kind.startsWith('subject_'))) {
    const version = kept.length + 1, payload = JSON.parse(row.payload);
    delete payload.state.subject; payload.state.version = version;
    const record = { version, kind: row.kind, payload: canonical(payload), prevHash: previous,
      createdAt: row.created_at, lastEventSeq: row.last_event_seq };
    const updated = { ...row, seq: version, version, payload: record.payload, prev_hash: previous, hash: hash(record) };
    previous = updated.hash; kept.push(updated); byOldSeq.set(row.seq, updated);
  }
  store.db.exec('BEGIN IMMEDIATE; DELETE FROM ledger');
  for (const row of kept) store.db.prepare('INSERT INTO ledger(seq,version,kind,payload,prev_hash,hash,created_at,last_event_seq) VALUES(?,?,?,?,?,?,?,?)')
    .run(row.seq, row.version, row.kind, row.payload, row.prev_hash, row.hash, row.created_at, row.last_event_seq);
  store.db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='ledger'").run(kept.length);
  store.db.prepare('UPDATE state SET json=? WHERE singleton=1').run(canonical(JSON.parse(kept.at(-1).payload).state));
  for (const row of exported.checkpoints) {
    const document = JSON.parse(row.document);
    const anchor = [...byOldSeq].filter(([seq]) => seq <= document.lastLedgerSeq).at(-1)[1];
    document.lastLedgerSeq = anchor.seq; document.stateVersion = anchor.version;
    document.ledgerHash = anchor.hash; document.state = JSON.parse(anchor.payload).state;
    store.db.prepare('UPDATE checkpoints SET document=?,sha256=? WHERE seq=?').run(canonical(document), hash(document), row.seq);
  }
  store.db.exec('COMMIT');
  return { ledger: store.db.prepare('SELECT * FROM ledger ORDER BY seq').all(),
    checkpoints: store.db.prepare('SELECT * FROM checkpoints ORDER BY seq').all() };
}

test('0.2.1 migration appends a subject from saved evidence and preserves old identity and checkpoints', t => {
  const { store, open } = fixture(t);
  store.ingest(message('old-request', 'old-window', '请帮我完成数据库迁移。'));
  store.ingest(message('old-promise', 'old-window', '我会继续整理迁移步骤。', { role: 'assistant', source: 'dsh:model' }));
  store.checkpoint(); const id = store.status().ghostId;
  const legacy = makeLegacy(store); store.close();
  const migrated = open(), exported = migrated.exportData();
  assert.equal(migrated.status().ghostId, id); assert.equal(migrated.verify().ok, true);
  assert.deepEqual(exported.ledger.slice(0, legacy.ledger.length), legacy.ledger);
  assert.deepEqual(exported.checkpoints, legacy.checkpoints);
  assert.equal(exported.ledger.at(-1).kind, 'subject_bootstrap');
  assert.equal(migrated.subjectView({ sessionId: 'old-window' }).activeTaskCount, 1);
  const version = migrated.status().version; migrated.close();
  assert.equal(open().status().version, version, 'migration must not repeat on reload');
});

test('semantic replay rejects a forged completed task even if its local checksums are recomputed', t => {
  const { store } = fixture(t);
  store.ingest(message('request', 'a', '请帮我完成报告。'));
  const row = store.db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1').get();
  assert.equal(row.kind, 'subject_event');
  const payload = JSON.parse(row.payload); payload.state.subject.tasks[0].status = 'completed';
  const encoded = canonical(payload);
  const digest = hash({ version: row.version, kind: row.kind, payload: encoded, prevHash: row.prev_hash,
    createdAt: row.created_at, lastEventSeq: row.last_event_seq });
  store.db.prepare('UPDATE ledger SET payload=?,hash=? WHERE seq=?').run(encoded, digest, row.seq);
  store.db.prepare('UPDATE state SET json=? WHERE singleton=1').run(canonical(payload.state));
  const report = store.verify(); assert.equal(report.ok, false); assert.match(report.error, /CORRUPT_SUBJECT/);
  assert.equal(store.status().health.readOnly, true);
});

test('stopped capture hides all subject context and rejects structured writes', t => {
  const { store } = fixture(t);
  store.ingest(message('request', 'a', '请帮我完成报告。'));
  const view = store.subjectView({ sessionId: 'a' });
  store.configure({ settings: { captureEnabled: false } }, store.status().version);
  assert.equal(store.compose('', { sessionId: 'a' }), '');
  assert.throws(() => store.subjectCommand({ action: 'report', taskId: view.channelTasks[0].id,
    note: '迟到的进展', evidenceIds: ['request'], expectedSubjectVersion: view.subjectVersion }, { sessionId: 'a' }), { code: 'SUBJECT_DISABLED' });
});

test('partial completion remains open and old cancellation cannot overrule a later user continuation', t => {
  const { store, open } = fixture(t);
  store.ingest(message('request', 'a', '请帮我完成整本书。'));
  const taskId = store.subjectView({ sessionId: 'a' }).channelTasks[0].id;
  store.ingest(message('partial', 'a', '我已经完成了第一章，剩余章节明天继续。'));
  assert.equal(store.subjectView({ sessionId: 'a' }).channelTasks[0].status, 'pending');
  store.ingest(message('cancel', 'a', '取消任务。'));
  store.ingest(message('resume', 'a', taskId + ' 继续。'));
  const current = store.subjectView({ sessionId: 'a' });
  assert.equal(current.channelTasks[0].status, 'in_progress');
  const result = store.subjectCommand({ action: 'update', taskId, status: 'cancelled', evidenceIds: ['cancel'],
    expectedSubjectVersion: current.subjectVersion }, { sessionId: 'a' });
  assert.equal(result.channelTasks[0].status, 'in_progress');
  assert.equal(result.channelTasks[0].lastReport.claimStatus, 'model_claim');
  assert.equal(store.verify().ok, true);
  store.close(); assert.equal(open().verify().ok, true);
});
