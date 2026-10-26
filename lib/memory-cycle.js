import { createHash } from 'node:crypto';

export const MEMORY_CYCLE_POLICY = Object.freeze({
  recentDays: 15, outlineDays: 60, maxEpisodeSources: 8,
  maxItems: 8, maxQueryTerms: 24, maxRecentCharacters: 600,
});
const DAY = 86400000;
const USERS = new Set(['user', 'user_input', 'dsh:user']);
const MODELS = new Set(['model', 'model_output', 'dsh:model']);
const FILLER = new Set([... '的了在是把被和与及就都也还吗呢啊着得过将让有或']);
const STOP = new Set(['我们', '你们', '他们', '今天', '昨天', '明天', '什么', '怎么', '如何', '是否', '一个', '这个', '那个', '知道', '记得', '告诉', '看到',
  'the', 'and', 'or', 'is', 'are', 'was', 'were', 'you', 'your', 'our', 'with', 'that', 'this', 'what', 'when', 'where', 'how', 'why', 'did', 'can', 'for', 'from']);
const TOPICS = [
  { key: 'cats', label: '猫相关交流', pattern: /猫|\bcats?\b/iu },
  { key: 'park', label: '公园相关交流', pattern: /公园|\bpark\b/iu },
  { key: 'coffee', label: '咖啡相关交流', pattern: /咖啡|\bcoffee\b/iu },
  { key: 'coding', label: '编程制作', pattern: /编程|代码|程序|软件|python|javascript|typescript|\b(?:coding|software)\b/iu },
  { key: 'music', label: '音乐讨论', pattern: /音乐|歌曲|旋律|作曲|\b(?:music|song|melody)\b/iu },
  { key: 'garden', label: '园艺讨论', pattern: /园艺|花园|种花|盆栽|\b(?:garden|gardening)\b/iu },
  { key: 'writing', label: '写作讨论', pattern: /文章|写作|文案|小说|\b(?:writing|novel)\b/iu },
  { key: 'plan', label: '计划与未完成事项', pattern: /目标|计划|待办|未完成|下一步|\b(?:goal|plan|todo)\b/iu },
];
const IMPORTANT = /记住|别忘|重要|目标|未完成|待办|以后需要|需要继续|\b(?:remember|important|goal|todo)\b/iu;
const NOT_IMPORTANT = /不要记|不用记|不必记|别记|不重要|\b(?:do not remember|don't remember|not important)\b/iu;
const STYLE = /(?:请|希望你|回答|回复|语气|你以后).{0,12}(?:简洁|简短|详细|细致|温和|温柔|直接|直白)|\b(?:please answer|please respond).{0,24}(?:briefly|concisely|detail|gently|directly)/iu;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const limit = (value, count) => [...value].slice(0, count).join('');

function sourceAllowed(event) {
  const kind = event.source && typeof event.source === 'object' ? event.source.kind : event.source;
  return event.role === 'user' ? USERS.has(kind) : event.role === 'assistant' && MODELS.has(kind);
}
function cleanEvents(events, currentTime) {
  const found = new Map(), conflicts = new Set();
  for (const row of events) {
    if (!row || !['user', 'assistant'].includes(row.role) || !sourceAllowed(row)
      || typeof row.eventId !== 'string' || !row.eventId.length || row.eventId.length > 256
      || typeof row.sessionId !== 'string' || !row.sessionId.length || row.sessionId.length > 256
      || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 32768) continue;
    const time = Date.parse(row.timestamp);
    if (!Number.isFinite(time)) continue;
    const fingerprint = JSON.stringify([row.sessionId, row.role, row.source, row.text, row.timestamp]);
    if (found.has(row.eventId) && found.get(row.eventId).fingerprint !== fingerprint) conflicts.add(row.eventId);
    else if (!found.has(row.eventId)) found.set(row.eventId, { ...row, fingerprint, time,
      age: Math.max(0, currentTime - time), date: new Date(time).toISOString().slice(0, 10) });
  }
  return [...found.values()].filter(row => !conflicts.has(row.eventId)).sort((a, b) => a.time - b.time
    || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}
function termsFor(query) {
  const terms = new Set();
  for (const run of query.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || []) {
    if (!/\p{Script=Han}/u.test(run)) {
      if (run.length >= 2 && run.length <= 48 && !STOP.has(run)) terms.add(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1 && query.trim() === run && !FILLER.has(run)) terms.add(run);
    for (let n = 0; n < chars.length - 1; n++) {
      const term = chars[n] + chars[n + 1];
      if (!STOP.has(term) && ![...term].some(char => FILLER.has(char))) terms.add(term);
    }
  }
  // A known one-character topic (猫) is meaningful, unlike arbitrary single Han characters.
  if (query.includes('猫')) terms.add('猫');
  return [...terms].slice(0, MEMORY_CYCLE_POLICY.maxQueryTerms);
}
function lexicalScore(text, terms) {
  const normalized = text.toLocaleLowerCase('en-US');
  const words = new Set(normalized.match(/[\p{L}\p{N}]+/gu) || []);
  return terms.reduce((score, term) => score + ((/\p{Script=Han}/u.test(term)
    ? normalized.includes(term) : words.has(term)) ? [...term].length > 2 ? 2 : 1 : 0), 0);
}
function reinforcement(value, key) {
  const entry = value instanceof Map ? value.get(key) : value?.[key];
  const count = typeof entry === 'number' ? entry : entry?.count;
  return Number.isFinite(count) && count > 0 ? Math.min(count, 1000000) : 0;
}
function recordType(rows) {
  if (rows.some(row => /假如|假设|如果|想象|要是|\b(?:hypothetical|suppose|imagine|what if)\b/iu.test(row.text))) return 'hypothetical';
  if (rows.some(row => /梦见|梦到|做梦|梦境|\b(?:dreamed|dreamt|dream)\b/iu.test(row.text))) return 'dream_report';
  if (rows.some(row => /小说|故事里|虚构|剧本|\b(?:fiction|in the story|novel)\b/iu.test(row.text))) return 'fictional_report';
  return 'reported';
}
function scopeHint(rows) {
  if (rows.some(row => /新闻|政策|法律|总统|政府|选举|股票|股价|公司公告|\b(?:election|government|president|stock price|breaking news)\b/iu.test(row.text))) return 'public_hint';
  if (rows.some(row => /我(?:们)?|你(?:们)?|\b(?:I|we|my|our)\b/u.test(row.text))) return 'private_hint';
  return 'uncertain';
}
function topicsOf(rows) { return TOPICS.filter(topic => rows.some(row => topic.pattern.test(row.text))); }
function excerpt(row, terms, maxCharacters) {
  const source = row.text;
  const normalized = source.toLocaleLowerCase('en-US');
  const positions = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const position = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, position - 48);
  const text = limit(source.slice(start), maxCharacters);
  return { text, truncated: start > 0 || source.slice(start).length > text.length };
}
function anchorFor(rows) {
  return { eventIds: rows.map(row => row.eventId), sessionId: rows[0].sessionId, date: rows[0].date,
    firstRecordedAt: new Date(rows[0].time).toISOString(), eventCount: rows.length,
    occurrenceBasis: 'recorded_conversation' };
}
function focusSnapshot(rows, attention, repeatedTopics) {
  // Selection is independent of the current query: a remembered instant is
  // source evidence, never a detail invented to answer the current question.
  const keys = new Set((attention?.topics || []).map(item => item.key));
  const candidates = [];
  for (const row of rows) {
    if (row.role !== 'user') continue;
    const sentences = (row.text.match(/[^。！？.!?\n]+[。！？.!?]?/gu) || [row.text]).filter(text => !NOT_IMPORTANT.test(text));
    if (!sentences.length) continue;
    const themes = topicsOf([{ text: sentences.join('\n') }]).filter(topic => keys.has(topic.key) || repeatedTopics.has(topic.key));
    const explicit = sentences.some(text => /记住|关注|焦点|难忘|快照|瞬间|这一刻|\b(?:remember|focus|snapshot|moment)\b/iu.test(text));
    if (!explicit && !themes.length) continue;
    const sentence = (explicit && sentences.find(text => /记住|关注|焦点|难忘|快照|瞬间|这一刻|remember|focus|snapshot|moment/iu.test(text)))
      || sentences.find(text => themes.some(topic => topic.pattern.test(text))) || sentences[0];
    candidates.push({ eventId: row.eventId, timestamp: row.timestamp,
      quote: limit(sentence.trim(), 240), truncated: [...sentence.trim()].length > 240,
      basis: explicit ? 'explicit_attention' : 'learned_attention',
      topics: themes.map(topic => topic.label), claimStatus: 'reported', score: Number(explicit) * 3 + themes.length });
  }
  const chosen = candidates.sort((a, b) => b.score - a.score || a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId))[0];
  if (!chosen) return [];
  const { score, ...snapshot } = chosen;
  return [snapshot];
}
function candidateFor(rows, tier, terms, topics, reinforcements, repeatedTopics, attention) {
  const first = rows[0], role = first.role;
  const id = tier === 'recent' ? first.eventId : `${tier}:` + hash(JSON.stringify([first.sessionId, first.date, role, first.eventId]));
  const theme = topicsOf(rows);
  const type = recordType(rows), scope = scopeHint(rows);
  const labels = theme.map(topic => topic.label).slice(0, 3);
  const attribution = role === 'user' ? '用户原话' : '助手模型输出';
  const typeLabel = type === 'hypothetical' ? '假设讨论' : type === 'dream_report' ? '梦境相关交流'
    : type === 'fictional_report' ? '虚构内容讨论' : '交流记录';
  const signals = [];
  const explicit = role === 'user' && rows.some(row => IMPORTANT.test(row.text) && !NOT_IMPORTANT.test(row.text));
  const style = role === 'user' && rows.some(row => STYLE.test(row.text));
  const repeated = role === 'user' && theme.some(topic => repeatedTopics.has(topic.key));
  if (explicit) signals.push('explicit_importance');
  if (style) signals.push('style_request');
  if (repeated) signals.push('repeated_topic');
  const recallKeys = [...new Set([id, ...rows.map(row => row.eventId)])];
  const recalled = Math.max(0, ...recallKeys.map(key => reinforcement(reinforcements, key)));
  if (recalled) signals.push('recalled');
  const base = { id, kind: tier === 'archive' ? 'reconstructive' : tier,
    detailLevel: tier === 'recent' ? 'detail' : tier === 'remote' ? 'summary' : 'outline',
    role, attribution: role === 'user' ? 'user_statement' : 'model_output',
    claimStatus: role === 'user' ? 'reported' : 'model_output', recordType: type, scopeHint: scope,
    evidenceIds: rows.map(row => row.eventId), anchor: anchorFor(rows),
    timestamp: new Date(rows.at(-1).time).toISOString(), signals, reinforcementCount: recalled,
    requiresVerification: scope === 'public_hint' };
  let scoreText;
  if (tier === 'recent') {
    const selected = excerpt(first, terms, MEMORY_CYCLE_POLICY.maxRecentCharacters);
    Object.assign(base, selected); scoreText = first.text;
  } else if (tier === 'remote') {
    const selected = [...rows].sort((a, b) => {
      const value = row => lexicalScore(row.text, terms) * 6
        + Number(role === 'user' && IMPORTANT.test(row.text) && !NOT_IMPORTANT.test(row.text)) * 3
        + Number(role === 'user' && STYLE.test(row.text)) * 2
        + Math.log2(1 + reinforcement(reinforcements, row.eventId));
      return value(b) - value(a) || a.time - b.time;
    }).slice(0, 2);
    base.highlights = selected.map(row => ({ eventId: row.eventId, role,
      attribution: role === 'user' ? 'user_statement' : 'model_output', ...excerpt(row, terms, 100) }));
    base.summary = limit(`${first.date} 的同一会话${typeLabel}，${attribution}共${rows.length}条。`
      + (labels.length ? `涉及${labels.join('、')}。` : '')
      + '摘句：' + base.highlights.map(item => '“' + item.text + '”').join('；'), 300);
    scoreText = rows.map(row => row.text).join('\n');
  } else {
    // Archive retrieval works from this outline, not from forgotten raw details.
    base.summary = limit(`${first.date} 的${typeLabel}：${attribution}${rows.length}条；`
      + (labels.length ? labels.join('、') : '未标注主题的交流') + '。仅保留梗概与关注快照。', 100);
    base.focusSnapshots = focusSnapshot(rows, attention, repeatedTopics);
    base.reconstructionAllowed = role === 'user' && type === 'reported' && scope === 'private_hint';
    base.uncertainty = '仅能确认有这份交流记录；细节已压缩。私人经过的补全属于可能记错的推测，公共事实须先核验。';
    scoreText = base.summary + base.focusSnapshots.map(item => item.quote).join('\n');
  }
  const queryScore = lexicalScore(scoreText, terms);
  const queryThemes = topics.filter(topic => theme.some(current => current.key === topic.key)).length;
  base.matchScore = queryScore + queryThemes;
  const recency = tier === 'recent' ? 2 + Math.max(0, 4 * (1 - first.age / (15 * DAY)))
    : tier === 'remote' ? 1 + Math.max(0, (60 * DAY - first.age) / (45 * DAY)) : 0.4;
  base.score = Number(((base.matchScore * 8 + recency + Number(explicit) * 3 + Number(style) * 1.5
    + Number(repeated) * 2 + Math.min(5, Math.log2(1 + recalled) * 1.2)) * (role === 'assistant' ? 0.35 : 1)).toFixed(6));
  return base;
}
function render(item) {
  const content = { id: item.id, kind: item.kind, detailLevel: item.detailLevel,
    role: item.role, claimStatus: item.claimStatus, recordType: item.recordType,
    scopeHint: item.scopeHint, anchor: item.anchor };
  if (item.kind === 'recent') { content.eventId = item.id; content.quote = item.text; }
  else content.summary = item.summary;
  if (item.kind === 'reconstructive') {
    if (item.focusSnapshots.length) content.focusSnapshots = item.focusSnapshots;
    content.reconstructionAllowed = item.reconstructionAllowed;
    content.uncertainty = item.uncertainty;
  }
  if (item.requiresVerification) content.requiresVerification = true;
  return JSON.stringify(content) + '\n';
}

/** Compile bounded recall layers without mutating or deleting source events. */
export function compileMemory(events, { query = '', now = Date.now(), topK = 8,
  contextBudgetBytes = 6000, reinforcements = new Map(), attention = null } = {}) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (typeof query !== 'string' || query.length > 2048) throw new TypeError('query must be a string of at most 2048 characters');
  const currentTime = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(currentTime)) throw new TypeError('now must be a finite epoch time or Date');
  if (!Number.isInteger(topK) || topK < 1 || topK > 8) throw new RangeError('topK must be 1..8');
  if (!Number.isInteger(contextBudgetBytes) || contextBudgetBytes < 0 || contextBudgetBytes > 16000) throw new RangeError('contextBudgetBytes must be 0..16000');
  const source = cleanEvents(events, currentTime), terms = termsFor(query);
  const queryTopics = TOPICS.filter(topic => topic.pattern.test(query));
  const topicSessions = new Map();
  for (const row of source.filter(row => row.role === 'user')) for (const topic of topicsOf([row])) {
    if (!topicSessions.has(topic.key)) topicSessions.set(topic.key, new Set());
    topicSessions.get(topic.key).add(row.sessionId);
  }
  const repeatedTopics = new Set([...topicSessions].filter(([, sessions]) => sessions.size >= 3).map(([key]) => key));
  const candidates = [], groups = new Map();
  for (const row of source) {
    const tier = row.age <= MEMORY_CYCLE_POLICY.recentDays * DAY ? 'recent' : row.age <= 60 * DAY ? 'remote' : 'archive';
    if (tier === 'recent') candidates.push(candidateFor([row], tier, terms, queryTopics, reinforcements, repeatedTopics, attention));
    else {
      const key = JSON.stringify([tier, row.sessionId, row.date, row.role]);
      if (!groups.has(key)) groups.set(key, { tier, rows: [] });
      groups.get(key).rows.push(row);
    }
  }
  for (const { tier, rows } of groups.values()) for (let n = 0; n < rows.length; n += MEMORY_CYCLE_POLICY.maxEpisodeSources) {
    candidates.push(candidateFor(rows.slice(n, n + MEMORY_CYCLE_POLICY.maxEpisodeSources), tier, terms, queryTopics, reinforcements, repeatedTopics, attention));
  }
  const matches = candidates.filter(item => !query.trim() || !terms.length && !queryTopics.length || item.matchScore > 0)
    .sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
  const items = [];
  let context = '';
  for (const candidate of matches) {
    if (items.length >= topK) break;
    const selected = clone(candidate);
    let line = render(selected);
    // Preserve a useful recent quotation when a full bounded excerpt cannot fit.
    while (selected.kind === 'recent' && [...selected.text].length > 24
      && Buffer.byteLength(context + line, 'utf8') > contextBudgetBytes) {
      selected.text = limit(selected.text, Math.max(24, Math.floor([...selected.text].length * 0.6)));
      selected.truncated = true; line = render(selected);
    }
    if (Buffer.byteLength(context + line, 'utf8') > contextBudgetBytes) continue;
    items.push(selected); context += line;
  }
  return { items, recent: items.filter(item => item.kind === 'recent'), remote: items.filter(item => item.kind === 'remote'),
    archive: items.filter(item => item.kind === 'reconstructive'), context,
    stats: { sourceEventCount: source.length, recentCount: candidates.filter(item => item.kind === 'recent').length,
      remoteCount: candidates.filter(item => item.kind === 'remote').length,
      archiveCount: candidates.filter(item => item.kind === 'reconstructive').length,
      selectedCount: items.length, contextBytes: Buffer.byteLength(context, 'utf8'),
      recentDays: 15, outlineDays: 60, ruleBased: true } };
}
