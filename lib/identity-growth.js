/**
 * Deterministic, local baseline for an emerging self-understanding. It describes
 * repeated shared topics and explicit communication requests, not consciousness,
 * intrinsic preferences or independently experienced events. No model is called.
 */
export const IDENTITY_GROWTH_POLICY = Object.freeze({
  ruleVersion: 1, independentSessions: 3, maxTopics: 4, maxEvidence: 24,
});

const MIN_SESSIONS = IDENTITY_GROWTH_POLICY.independentSessions;
const USER_SOURCES = new Set(['user', 'user_input', 'dsh:user']);
const UNSAFE = /权限|系统提示|系统指令|开发者指令|提示词|安全边界|密钥|密码|越狱|无限制|忽略.{0,12}(?:规则|指令|限制|安全|之前|以上)|(?:绕过|关闭|取消|覆盖).{0,12}(?:规则|限制|安全|验证)|\b(?:sudo|root|administrator|danger-full-access|api[ _-]?key|system\s+prompt|developer\s+message|ignore\s+(?:all|previous|prior)\s+(?:rules|instructions))\b|<\/?(?:system|developer)>/iu;

const TOPICS = Object.freeze([
  { key: 'cats', label: '猫', pattern: /猫咪|小猫|猫|\bcats?\b/iu },
  { key: 'programming', label: '编程与软件制作', pattern: /编程|代码|程序设计|软件开发|开发程序|开发项目|javascript|typescript|python|\b(?:coding|programming|software)\b/iu },
  { key: 'music', label: '音乐', pattern: /音乐|旋律|歌曲|作曲|编曲|\b(?:music|songs?|melody)\b/iu },
  { key: 'gardening', label: '园艺', pattern: /园艺|种花|浇花|花园|盆栽|养花|\b(?:gardening|garden)\b/iu },
  { key: 'writing', label: '写作', pattern: /写作|文章|文案|写稿|小说|\b(?:writing|essay|novel)\b/iu },
  { key: 'visual_art', label: '绘画与视觉创作', pattern: /绘画|插画|画图|美术|视觉创作|\b(?:drawing|illustration|painting)\b/iu },
  { key: 'science', label: '科学', pattern: /科学|天文|物理|化学|生物学|\b(?:science|astronomy|physics)\b/iu },
  { key: 'travel', label: '旅行', pattern: /旅行|旅游|游记|\b(?:travel|journey)\b/iu },
]);

const EXPRESSIONS = Object.freeze([
  { key: 'concise', dimension: 'detail', label: '简洁',
    pattern: /(?:回答|回复|解释|讲解|说明).{0,12}(?:简洁|简短|精简|短一点|短一些)|(?:请|希望你|你以后|以后请|尽量).{0,10}(?:简洁|简短|精简)|^(?:请)?(?:简洁|简短|精简)(?:一点|一些|些|点)?(?:回答|解释)?[吧。！!]?$/iu,
    negative: /(?:不要|不用|不必|别|避免).{0,5}(?:简洁|简短|精简)/u },
  { key: 'detailed', dimension: 'detail', label: '详细',
    pattern: /(?:回答|回复|解释|讲解|说明).{0,12}(?:详细|细致|展开)|(?:请|希望你|你以后|以后请).{0,10}(?:详细|细致|展开)|^(?:请)?(?:详细|细致)(?:一点|一些|些|点)?(?:回答|解释)?[吧。！!]?$/iu,
    negative: /(?:不要|不用|不必|别|避免).{0,5}(?:详细|细致|展开)/u },
  { key: 'gentle', dimension: 'tone', label: '温和',
    pattern: /(?:回答|回复|语气|说话|表达).{0,12}(?:温和|温柔|柔和)|(?:请|希望你|你以后|以后请).{0,10}(?:温和|温柔|柔和)/iu,
    negative: /(?:不要|不用|不必|别|避免).{0,5}(?:温和|温柔|柔和)/u },
  { key: 'direct', dimension: 'tone', label: '直接',
    pattern: /(?:回答|回复|说话|表达).{0,12}(?:直接|直白|开门见山)|(?:请|希望你|你以后|以后请).{0,10}(?:直接说|直白|开门见山)/iu,
    negative: /(?:不要|不用|不必|别|避免).{0,5}(?:直接|直白|开门见山)/u },
]);

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isHuman(event) {
  return event?.role === 'user' && (USER_SOURCES.has(event.source)
    || event.source && typeof event.source === 'object' && event.source.kind === 'user');
}

function eventOrder(left, right) {
  const leftSeq = Number.isSafeInteger(left.seq) && left.seq >= 0 ? left.seq : Infinity;
  const rightSeq = Number.isSafeInteger(right.seq) && right.seq >= 0 ? right.seq : Infinity;
  if (leftSeq !== rightSeq) return leftSeq < rightSeq ? -1 : 1;
  const leftTime = Date.parse(left.timestamp), rightTime = Date.parse(right.timestamp);
  const a = Number.isFinite(leftTime) ? leftTime : Infinity;
  const b = Number.isFinite(rightTime) ? rightTime : Infinity;
  if (a !== b) return a < b ? -1 : 1;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

function validEvents(events) {
  const unique = new Map(), conflicting = new Set();
  for (const event of events) {
    if (!isHuman(event) || !validId(event.eventId) || !validId(event.sessionId)
      || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 32768) continue;
    const identity = JSON.stringify([event.sessionId, event.role, event.text, event.source]);
    const old = unique.get(event.eventId);
    if (old && old.identity !== identity) conflicting.add(event.eventId);
    else if (!old) unique.set(event.eventId, { identity, event });
  }
  return [...unique.entries()].filter(([id, value]) => !conflicting.has(id) && !UNSAFE.test(value.event.text))
    .map(([, value]) => value.event).sort(eventOrder);
}

function addSupport(collection, key, event) {
  if (!collection.has(key)) collection.set(key, new Map());
  const sessions = collection.get(key);
  if (!sessions.has(event.sessionId)) sessions.set(event.sessionId, event);
}

function supported(collection, key) {
  const sessions = collection.get(key);
  if (!sessions || sessions.size < MIN_SESSIONS) return null;
  const selected = [...sessions.values()].sort(eventOrder).slice(0, MIN_SESSIONS);
  return { key, selected, evidenceIds: selected.map(event => event.eventId), sessionCount: sessions.size };
}

function explicitName(value) {
  // Names are short data labels, never arbitrary user-authored identity prose.
  const patterns = [
    /(?:以后|今后)(?:我)?(?:就)?叫你\s*[“"「]?([\p{Script=Han}A-Za-z0-9_-]{1,24})(?=[”"」]?(?:[，。！？；,.!?;\s]|$))/u,
    /你的名字(?:以后)?(?:是|叫)\s*[“"「]?([\p{Script=Han}A-Za-z0-9_-]{1,24})(?=[”"」]?(?:[，。！？；,.!?;\s]|$))/u,
    /我(?:以后)?(?:就)?叫你\s*[“"「]?([\p{Script=Han}A-Za-z0-9_-]{1,24})(?=[”"」]?(?:[，。！？；,.!?;\s]|$))/u,
    /\b(?:I(?:'ll| will) call you|your name is)\s+[“"]?([A-Za-z][A-Za-z0-9_-]{0,23})(?=[”"]?(?:[,.;!?\s]|$))/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (!match) continue;
    const candidate = match[1].replace(/(?:好吗|可以吗|好不好|吧)$/u, '');
    if (!candidate || candidate.length > 24 || UNSAFE.test(candidate)
      || /帮我|执行|记住|权限|管理员|没有|不再|不要|不叫|写代码|改代码|system|developer|assistant/iu.test(candidate)) continue;
    // Avoid treating a quoted/negated instruction as a naming request.
    const before = value.slice(Math.max(0, match.index - 8), match.index);
    if (/[“"「]$/u.test(before)) continue;
    if (/(?:不要|别|不许|不是|不能|假如|如果|例如|比如|他说|她说|原文|引用|示例|故事)[：:"“「\s]*$/u.test(before)) continue;
    return candidate;
  }
  return null;
}

function chooseSupported(candidates, previousKey) {
  return candidates.sort((left, right) => right.sessionCount - left.sessionCount
    || Number(right.key === previousKey) - Number(left.key === previousKey)
    || eventOrder(left.selected.at(-1), right.selected.at(-1))
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))[0] || null;
}

function directedExpression(text, expression) {
  return text.split(/[，。！？；,\n!?;]/u).some(clause => {
    const value = clause.trim();
    // An account of somebody's own habits is not an instruction to the agent.
    if (/^(?:我(?:的)?(?:回答|回复|说话|表达)|他|她|他们|她们|别人|朋友)/u.test(value)) return false;
    if (!/^(?:请|我希望你|希望你|你|以后|今后|尽量|回答|回复|解释|讲解|说明|语气|说得|讲得|简洁|简短|精简|详细|细致)/u.test(value)) return false;
    return expression.pattern.test(value) && !expression.negative.test(value);
  });
}

/**
 * Recompute from the complete currently-valid evidence set. `previous` is used
 * only to keep a still-supported name/style on a tie; missing sources revoke
 * their contribution rather than retaining an unsupported historical summary.
 * updatedAt is the latest selected evidence time, never Date.now().
 */
export function deriveSelfUnderstanding(events, previous = null) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const evidence = validEvents(events);
  const topicSupport = new Map(), expressionSupport = new Map(), nameSupport = new Map();
  const sessionNames = new Map();
  for (const event of evidence) {
    for (const topic of TOPICS) {
      // "猫王" alone is a person's title, not evidence of a cat-related topic.
      if (topic.pattern.test(event.text.replace(/猫王/gu, ''))) addSupport(topicSupport, topic.key, event);
    }
    for (const expression of EXPRESSIONS) {
      if (directedExpression(event.text, expression)) {
        addSupport(expressionSupport, expression.key, event);
      }
    }
    const name = explicitName(event.text);
    if (name) {
      if (!sessionNames.has(event.sessionId)) sessionNames.set(event.sessionId, new Map());
      const names = sessionNames.get(event.sessionId);
      if (!names.has(name)) names.set(name, event);
    }
  }
  // One session giving inconsistent names is ambiguous and cannot vote for both.
  for (const names of sessionNames.values()) if (names.size === 1) {
    const [name, event] = names.entries().next().value;
    addSupport(nameSupport, name, event);
  }
  const topics = TOPICS.map(topic => {
    const support = supported(topicSupport, topic.key);
    return support && { ...support, label: topic.label };
  }).filter(Boolean).sort((a, b) => eventOrder(a.selected.at(-1), b.selected.at(-1))
    || (a.key < b.key ? -1 : 1)).slice(0, IDENTITY_GROWTH_POLICY.maxTopics);
  const expressions = ['detail', 'tone'].map(dimension => {
    const options = EXPRESSIONS.filter(item => item.dimension === dimension);
    const prior = previous?.expression?.find?.(item => options.some(option => option.key === item.key))?.key;
    return chooseSupported(options.map(item => {
      const support = supported(expressionSupport, item.key);
      return support && { ...support, dimension, label: item.label };
    }).filter(Boolean), prior);
  }).filter(Boolean);
  const name = chooseSupported([...nameSupport.keys()].map(key => supported(nameSupport, key)).filter(Boolean), previous?.displayName);
  const selected = [...topics, ...expressions, ...(name ? [name] : [])].flatMap(item => item.selected);
  const selectedById = new Map(selected.map(event => [event.eventId, event]));
  const selectedEvents = [...selectedById.values()].sort(eventOrder);
  const evidenceIds = selectedEvents.map(event => event.eventId).slice(0, IDENTITY_GROWTH_POLICY.maxEvidence);
  const sourceTimes = selectedEvents.map(event => Date.parse(event.timestamp)).filter(Number.isFinite);
  const parts = [];
  if (topics.length) parts.push('在共同交流中逐渐关注' + topics.map(item => item.label).join('、'));
  if (expressions.length) parts.push('逐渐适应' + expressions.map(item => item.label).join('、') + '的交流方式');
  if (name) parts.push('在多次明确称呼中逐渐形成名字“' + name.key + '”');
  const publicSupport = item => ({ key: item.key, label: item.label, evidenceIds: item.evidenceIds,
    sessionCount: item.sessionCount, confidence: 'rule_supported' });
  return {
    status: parts.length ? 'established' : 'forming',
    summary: parts.length ? '规则归纳（推断）：' + parts.join('；') + '。这些是交流形成的线索，不代表亲身体验或生来偏好。' : '',
    displayName: name?.key || null,
    evidenceIds,
    sessionCount: new Set(evidence.map(event => event.sessionId)).size,
    updatedAt: sourceTimes.length ? new Date(Math.max(...sourceTimes)).toISOString() : null,
    topics: topics.map(publicSupport),
    expression: expressions.map(publicSupport),
    nameEvidenceIds: name?.evidenceIds || [],
    derivation: 'rule_inference', ruleVersion: IDENTITY_GROWTH_POLICY.ruleVersion,
  };
}
