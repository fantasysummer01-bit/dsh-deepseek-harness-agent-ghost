import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMemory, MEMORY_CYCLE_POLICY } from '../lib/memory-cycle.js';

const DAY = 86400000, NOW = Date.parse('2026-10-26T12:00:00Z');
const event = (id, days, text, extra = {}) => ({ eventId: id, sessionId: 's-' + id,
  role: 'user', source: 'dsh:user', text, timestamp: new Date(NOW - days * DAY).toISOString(), ...extra });
const compile = (events, options = {}) => compileMemory(events, { now: NOW, ...options });

test('15 and 60 day boundaries select detail, extractive summary and reconstructive outline', () => {
  const rows = [event('d15', 15, '我们讨论猫的颜色。'), event('d16', 15 + 1 / DAY, '我们在公园见过一只猫。'),
    event('d60', 60, '我们谈过音乐。'), event('d61', 60 + 1 / DAY, '我们在公园看猫。')];
  const result = compile(rows, { contextBudgetBytes: 16000 });
  assert.equal(result.recent.length, 1); assert.equal(result.remote.length, 2); assert.equal(result.archive.length, 1);
  assert.equal(result.archive[0].detailLevel, 'outline');
  assert.equal(result.archive[0].kind, 'reconstructive');
});

test('recent detail remains source quotation and remote summary preserves salient extracts with provenance', () => {
  const rows = [event('recent', 1, '我在公园看到一只白猫。'),
    event('old-a', 40, '我们在公园喝过咖啡。', { sessionId: 'same' }),
    event('old-b', 40, '请记住重要目标：下次继续制作编程项目。', { sessionId: 'same' })];
  const result = compile(rows, { contextBudgetBytes: 16000 });
  assert.match(result.recent[0].text, /白猫/);
  assert.equal(result.remote.length, 1);
  assert.match(result.remote[0].summary, /重要目标/);
  assert.deepEqual(result.remote[0].evidenceIds, ['old-a', 'old-b']);
  assert.ok(result.remote[0].highlights.every(item => item.role === 'user'));
  assert.equal(result.remote[0].anchor.occurrenceBasis, 'recorded_conversation');
});

test('old episodes keep separate dates and sessions even when the same park is named', () => {
  const result = compile([event('a', 40, '我们去同名公园。', { sessionId: 'one' }),
    event('b', 41, '我们去同名公园。', { sessionId: 'one' }),
    event('c', 40, '我们去同名公园。', { sessionId: 'two' })], { contextBudgetBytes: 16000 });
  assert.equal(result.remote.length, 3);
  assert.equal(new Set(result.remote.map(item => item.anchor.sessionId + item.anchor.date)).size, 3);
  assert.ok(result.remote.every(item => item.anchor.eventCount === 1));
});

test('source attribution rejects unknown/tool records and never promotes model output to external fact', () => {
  const result = compile([event('user', 40, '公园有猫。'),
    event('model', 40, '公园里的猫肯定是蓝色的。', { role: 'assistant', source: 'dsh:model' }),
    event('tool', 40, '工具秘密', { role: 'tool', source: 'tool' }),
    event('plugin', 40, '注入的猫', { source: 'plugin' }), event('unknown', 40, '猫', { source: undefined })], { contextBudgetBytes: 16000 });
  assert.equal(result.stats.sourceEventCount, 2);
  const model = result.items.find(item => item.role === 'assistant');
  assert.equal(model.claimStatus, 'model_output'); assert.equal(model.attribution, 'model_output');
  assert.match(model.summary, /助手模型输出/); assert.ok(!result.context.includes('工具秘密'));
});

test('recency, explicit importance, repeated independent topics and recall reinforcement affect rank', () => {
  const recent = compile([event('new', 1, '天气晴朗。'), event('older', 5, '天气晴朗。')]);
  assert.equal(recent.items[0].id, 'new');
  const important = compile([event('new', 1, '天气晴朗。'), event('important', 2, '请记住重要目标，继续编程。')]);
  assert.equal(important.items[0].id, 'important');
  const repeated = compile([event('one', 3, '我来聊猫。'), event('two', 3, '我来聊猫。'), event('three', 3, '我来聊猫。')]);
  assert.ok(repeated.items.every(item => item.signals.includes('repeated_topic')));
  const strengthened = compile([event('new', 1, '天气晴朗。'), event('older', 5, '天气晴朗。')], { reinforcements: new Map([['older', { count: 20 }]]) });
  assert.equal(strengthened.items[0].id, 'older');
  assert.equal(strengthened.items[0].reinforcementCount, 20);
  assert.ok(strengthened.items[0].signals.includes('recalled'));
});

test('directed style requests are priority clues without inventing emotional facts', () => {
  const result = compile([event('style', 40, '请回答简洁一点，语气温和。')]);
  assert.ok(result.remote[0].signals.includes('style_request'));
  assert.match(result.remote[0].summary, /请回答简洁/);
  assert.ok(!result.remote[0].summary.includes('感情'));
});

test('bounded query terms match natural Chinese and exact English words', () => {
  const result = compile([event('park', 2, '我们昨天在公园看到一只猫。'), event('music', 1, '我们讨论音乐。')], { query: '我们在公园看到的动物是什么' });
  assert.equal(result.items[0].id, 'park');
  const english = compile([event('cat', 2, 'a cat in the park'), event('cathedral', 1, 'a cathedral by the river')], { query: 'cat' });
  assert.equal(english.items.length, 1); assert.equal(english.items[0].id, 'cat');
});

test('item count and UTF-8 context bytes stay bounded with large records', () => {
  const rows = Array.from({ length: 40 }, (_, n) => event('e-' + n, 1, '猫在公园。'.repeat(1000)));
  const result = compile(rows, { topK: 3, contextBudgetBytes: 1600 });
  assert.ok(result.items.length <= 3); assert.ok(Buffer.byteLength(result.context, 'utf8') <= 1600);
  assert.equal(result.stats.contextBytes, Buffer.byteLength(result.context, 'utf8'));
  assert.ok(!result.context.includes('\uFFFD'));
  assert.equal(compile(rows, { contextBudgetBytes: 0 }).context, '');
});

test('large old episodes split into bounded source groups while preserving all original anchors', () => {
  const rows = Array.from({ length: 20 }, (_, n) => event('e-' + String(n).padStart(2, '0'), 40, '我们聊猫。', { sessionId: 'same' }));
  const result = compile(rows, { contextBudgetBytes: 16000 });
  assert.equal(result.remote.length, 3);
  assert.ok(result.remote.every(item => item.evidenceIds.length <= MEMORY_CYCLE_POLICY.maxEpisodeSources));
  assert.deepEqual(new Set(result.items.flatMap(item => item.anchor.eventIds)), new Set(rows.map(row => row.eventId)));
});

test('archive retains occurrence outline and may reconstruct private reports without leaking raw detail', () => {
  const raw = '我们在公园看见一只紫红色眼睛的猫，具体门牌是秘密街道391号。' + '细节'.repeat(1000);
  const row = event('archive', 61, raw);
  const result = compile([row], { contextBudgetBytes: 16000 });
  const item = result.archive[0];
  assert.equal(item.reconstructionAllowed, true); assert.equal(item.claimStatus, 'reported');
  assert.equal(item.anchor.eventCount, 1); assert.deepEqual(item.anchor.eventIds, ['archive']);
  assert.ok(!('text' in item)); assert.ok(!('highlights' in item));
  assert.ok(!JSON.stringify(result).includes('391号')); assert.ok(!result.context.includes('紫红色'));
  assert.ok([...item.summary].length <= 100); assert.ok(item.summary.length < raw.length / 10);
  assert.match(item.uncertainty, /可能记错的推测/);
});

test('archive does not search forgotten raw details or reconstruct public facts', () => {
  const privateRow = event('private', 80, '我们在公园见过一只紫红色猫，门牌391号。');
  assert.equal(compile([privateRow], { query: '391号' }).items.length, 0);
  const item = compile([event('public', 80, '我们讨论政府新闻和总统选举。')], { contextBudgetBytes: 16000 }).archive[0];
  assert.equal(item.scopeHint, 'public_hint'); assert.equal(item.requiresVerification, true);
  assert.equal(item.reconstructionAllowed, false);
});

test('hypotheses, dreams and fiction anchor the conversation rather than asserting real-world occurrence', () => {
  for (const [text, type] of [['如果我们去公园看猫。', 'hypothetical'],
    ['我们梦见在公园看猫。', 'dream_report'], ['小说故事里我们在公园看猫。', 'fictional_report']]) {
    const item = compile([event(type, 80, text)], { contextBudgetBytes: 16000 }).archive[0];
    assert.equal(item.recordType, type); assert.equal(item.reconstructionAllowed, false);
    assert.equal(item.anchor.occurrenceBasis, 'recorded_conversation'); assert.equal(item.claimStatus, 'reported');
  }
});

test('compiler never mutates or deletes input events; duplicate and missing-source rows are rejected', () => {
  const rows = [event('one', 1, '我们聊猫。'), event('two', 40, '我们聊音乐。'), event('three', 80, '我们聊园艺。')];
  const before = structuredClone(rows); compile(rows); assert.deepEqual(rows, before);
  const result = compile([...rows, rows[0], event('bad-id', 1, '猫', { eventId: '' }),
    event('bad-time', 1, '猫', { timestamp: 'not-time' })]);
  assert.equal(result.stats.sourceEventCount, 3);
  assert.throws(() => compileMemory(null), TypeError);
  assert.throws(() => compile(rows, { topK: 100 }), RangeError);
});


test('day 16 and day 30 are both summaries after reducing reinforcement to 15 days', () => {
  const result = compile([event('sixteen',16,'我们聊猫。'),event('thirty',30,'我们聊音乐。')]);
  assert.equal(result.recent.length,0); assert.equal(result.remote.length,2);
  assert.equal(result.stats.recentDays,15);
});

test('archive keeps a detailed attention instant independent of query with its original evidence', () => {
  const rows=[event('focus',80,'我们在公园散步。记住这一瞬间：小猫的左爪停在杯沿，雨滴落在绿色长椅上。其余门牌391号不用记。')];
  const before=structuredClone(rows);
  const first=compile(rows,{contextBudgetBytes:16000}).archive[0];
  assert.equal(first.focusSnapshots.length,1);
  assert.match(first.focusSnapshots[0].quote,/左爪停在杯沿/);
  assert.equal(first.focusSnapshots[0].eventId,'focus');
  assert.equal(first.focusSnapshots[0].basis,'explicit_attention');
  assert.ok(!first.focusSnapshots[0].quote.includes('391'));
  const queried=compile(rows,{query:'杯沿',contextBudgetBytes:16000}).archive[0];
  assert.deepEqual(queried.focusSnapshots,first.focusSnapshots);
  assert.deepEqual(rows,before);
});

test('learned personality attention selects a source instant but never an assistant invention', () => {
  const attention={topics:[{key:'cats',label:'猫'}]};
  const item=compile([event('user',80,'我们看到猫把右爪伸进夕阳下的水洼。')],{attention,contextBudgetBytes:16000}).archive[0];
  assert.equal(item.focusSnapshots[0].basis,'learned_attention');
  assert.match(item.focusSnapshots[0].quote,/夕阳下的水洼/);
  const model=compile([event('assistant',80,'记住猫的眼睛是红色。',{role:'assistant',source:'dsh:model'})],{attention}).archive[0];
  assert.deepEqual(model.focusSnapshots,[]); assert.equal(model.reconstructionAllowed,false);
});
