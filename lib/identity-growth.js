/**
 * Deterministic, local baseline for an emerging self-understanding. It describes
 * repeated shared topics and explicit communication requests, not consciousness,
 * intrinsic preferences or independently experienced events. No model is called.
 */
export const IDENTITY_GROWTH_POLICY = Object.freeze({
  ruleVersion: 2, independentExperiences: 3, episodeGapHours: 6, maxTopics: 4, maxEvidence: 24,
});

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

function explicitName(value) {
  if (isMetaLanguage(value) || /[?？]|(?:好吗|可以吗|好不好|合适吗)[。！!\s]*$/u.test(value)) return null;
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
      || /帮我|执行|记住|权限|管理员|没有|不再|不要|不叫|写代码|改代码|这句话|的含义|合适|[吗么呢]$|system|developer|assistant/iu.test(candidate)) continue;
    // Avoid treating a quoted/negated instruction as a naming request.
    const before = value.slice(Math.max(0, match.index - 8), match.index);
    if (/[“"「]$/u.test(before)) continue;
    if (/(?:不要|别|不许|不是|不能|假如|如果|例如|比如|他说|她说|原文|引用|示例|故事)[：:"“「\s]*$/u.test(before)) continue;
    return candidate;
  }
  return null;
}


const HOUR = 3600000, DAY = 24 * HOUR;
const GAP = IDENTITY_GROWTH_POLICY.episodeGapHours * HOUR;
const TRAITS = ['curiosity', 'initiative', 'caution'];
const round = value => Math.round(value * 1000000) / 1000000;
const limit = (value, count) => [...value].slice(0, count).join('');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sourceKind = event => typeof event?.source === 'object' ? event.source.kind : event?.source;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const NON_LITERAL = /^(?:["'“‘>`]|```|假如|假设|如果|要是|举例|例如|比如|想象|引用|他说|她说|原话|故事里|小说里|\b(?:suppose|imagine|what if|for example|quote|in the story)\b)/iu;
const META_LANGUAGE = /翻译|释义|是什么意思|(?:这|那)(?:句|几个字|句话)|(?:原|例)句|引文|引用|例如|比如|举例|假设|假如|想象|你(?:认为|觉得)|(?:他|她|朋友|别人|有人)(?:曾经|昨天|刚才)?(?:说|问|提到)|\b(?:translate|translation|meaning|what does|suppose|imagine|quote|for example)\b/iu;
function isMetaLanguage(text) { return META_LANGUAGE.test(text); }
function unquoted(text) {
  return text.replace(/“[^”\n]*”|「[^」\n]*」|‘[^’\n]*’|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu, ' ');
}

function eventOrder(a, b) {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp)
    || (Number.isSafeInteger(a.seq) ? a.seq : Infinity) - (Number.isSafeInteger(b.seq) ? b.seq : Infinity)
    || compare(a.eventId, b.eventId);
}
function validEvents(events) {
  const found = new Map(), conflicts = new Set();
  for (const event of events) {
    if (!event || event.role !== 'user' || !USER_SOURCES.has(sourceKind(event)) || !validId(event.eventId)
      || !validId(event.sessionId) || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 32768
      || typeof event.timestamp !== 'string' || event.timestamp.length > 64 || !Number.isFinite(Date.parse(event.timestamp))) continue;
    const identity = JSON.stringify([event.sessionId, event.role, event.text, sourceKind(event), event.timestamp, event.seq ?? null]);
    if (found.has(event.eventId) && found.get(event.eventId).identity !== identity) conflicts.add(event.eventId);
    else if (!found.has(event.eventId)) found.set(event.eventId, { identity, event });
  }
  return [...found].filter(([id, value]) => !conflicts.has(id) && !UNSAFE.test(value.event.text) && !NON_LITERAL.test(value.event.text.trim()))
    .map(([, value]) => value.event).sort(eventOrder);
}

// A burst across ten windows is still one experience. Windows do not vote.
function independent(rows) {
  const selected = [];
  for (const event of rows) if (!selected.length || Date.parse(event.timestamp) - Date.parse(selected.at(-1).timestamp) >= GAP) selected.push(event);
  return selected;
}
function dimensionEpisodes(evidence, classify) {
  const groups = [];
  for (const event of evidence) {
    const keys = classify(event);
    if (!keys.length) continue;
    const at = Date.parse(event.timestamp);
    let group = groups.at(-1);
    if (!group || at - group.at >= GAP) { group = { at, keys: new Map() }; groups.push(group); }
    for (const key of keys) if (!group.keys.has(key)) group.keys.set(key, event);
  }
  return groups.map(group => group.keys.size === 1 ? { key: [...group.keys.keys()][0], event: [...group.keys.values()][0] } : { key: null });
}
function collectEpisodes(episodes) {
  const found = new Map();
  for (const item of episodes) if (item.key !== null) {
    if (!found.has(item.key)) found.set(item.key, []);
    found.get(item.key).push(item.event);
  }
  return found;
}
function weight(event, watermark) {
  const age = Math.max(0, watermark - Date.parse(event.timestamp));
  return 0.25 + 0.75 * Math.pow(0.5, age / (45 * DAY));
}
function legacyIds(previous, kind, key) {
  if (!previous) return [];
  if (kind === 'name') {
    if (previous.displayName !== key) return [];
    if (previous.ruleVersion === 1) return previous.nameEvidenceIds || [];
    return previous.nameSupport?.supportBasis === 'legacy_sessions' ? previous.nameSupport.legacyEvidenceIds || [] : [];
  }
  const prior = previous[kind]?.find(item => item.key === key);
  if (!prior) return [];
  if (previous.ruleVersion === 1) return prior.evidenceIds || [];
  return prior.supportBasis === 'legacy_sessions' ? prior.legacyEvidenceIds || [] : [];
}
function candidate(key, rows, watermark, legacy, validById, matches) {
  const episodes = independent(rows);
  const legacyRows = [...new Set(legacy)].map(id => validById.get(id)).filter(Boolean);
  const grandfathered = legacyRows.length >= 3 && new Set(legacyRows.map(event => event.sessionId)).size >= 3
    && legacyRows.every(matches);
  if (episodes.length < 3 && !grandfathered) return null;
  const temporal = episodes.length >= 3;
  const selected = temporal ? episodes.slice(-3) : legacyRows.slice(0, 3);
  const scoreRows = temporal ? episodes.slice(-12) : legacyRows.slice(0, 3);
  return { key, rows: selected, supportBasis: temporal ? 'temporal_experiences' : 'legacy_sessions',
    ...(temporal ? {} : { legacyEvidenceIds: selected.map(event => event.eventId) }),
    episodeCount: episodes.length, sessionCount: new Set(rows.map(event => event.sessionId)).size,
    supportScore: round(scoreRows.reduce((score, event) => score + weight(event, watermark), 0)) };
}
function choose(candidates, priorKey) {
  const ranked = candidates.filter(Boolean).sort((a, b) => b.supportScore - a.supportScore || compare(a.key, b.key));
  const prior = ranked.find(item => item.key === priorKey);
  if (prior && ranked[0]?.key !== prior.key && ranked[0].supportScore <= prior.supportScore + 0.35) return prior;
  return ranked[0] || null;
}
function publicSupport(item) {
  return { key: item.key, ...(item.label ? { label: item.label } : {}), evidenceIds: item.rows.map(event => event.eventId),
    episodeCount: item.episodeCount, sessionCount: item.sessionCount, supportScore: item.supportScore,
    confidence: 'rule_supported', supportBasis: item.supportBasis,
    ...(item.legacyEvidenceIds ? { legacyEvidenceIds: [...item.legacyEvidenceIds] } : {}) };
}

function directedClause(text, predicate) {
  if (isMetaLanguage(text)) return false;
  return unquoted(text).split(/[，。！？；,\n!?;]/u).some(clause => {
    const value = clause.trim();
    return !NON_LITERAL.test(value) && !/^(?:我(?:的)?(?:回答|回复|说话|表达)|他|她|他们|她们|别人|朋友)/u.test(value)
      && /^(?:请|我希望你|希望你|你|以后|今后|尽量|回答|回复|解释|讲解|说明|语气|说得|讲得|简洁|简短|精简|详细|细致|主动|先|多|少|不要|别|不必|不用|please\b|I (?:want|need) you\b)/iu.test(value)
      && predicate(value);
  });
}
function expressionMatch(text, expression) {
  return directedClause(text, value => expression.pattern.test(value) && !expression.negative.test(value));
}
function expressionRetraction(evidence, expression) {
  const episodes = dimensionEpisodes(evidence, event => {
    const support = expressionMatch(event.text, expression);
    const reject = directedClause(event.text, value => expression.negative.test(value));
    return support && reject ? ['support', 'reject'] : support ? ['support'] : reject ? ['reject'] : [];
  });
  let direction = null, run = [], retracted = false, proof = [];
  for (const episode of episodes) {
    if (episode.key === null) { direction = null; run = []; continue; }
    if (direction !== episode.key) { direction = episode.key; run = []; }
    run.push(episode.event);
    if (run.length >= 3) {
      retracted = direction === 'reject';
      proof = run.slice(-3);
    }
  }
  return { retracted, rows: retracted ? proof : [], episodeCount: episodes.filter(item => item.key === 'reject').length };
}

const BEHAVIOR = {
  curiosity: {
    positive: /保持好奇|多(?:问|提)(?:一些|点|些)?问题|多追问|多探索|主动探索|继续探索|\b(?:ask more questions|explore more|be more curious)\b/iu,
    negative: /不要追问|别追问|少问(?:问题)?|不必追问|不用追问|不要探索|\b(?:ask fewer questions|stop asking questions|do not explore)\b/iu,
  },
  initiative: {
    positive: /更主动|主动(?:提|给|提出)(?:一些|点|些)?(?:建议|方案)|多(?:提|给)(?:一些|点|些)?建议|\b(?:be more proactive|offer more suggestions|take more initiative)\b/iu,
    negative: /不要擅自|别擅自|等我确认|先问我|不要主动|少提建议|\b(?:wait for my confirmation|ask me first|be less proactive)\b/iu,
  },
  caution: {
    positive: /先验证|先核实|先检查|更加谨慎|更谨慎|谨慎一点|稳妥一点|确认后再|\b(?:verify first|check first|be more cautious)\b/iu,
    negative: /不用反复验证|不必反复检查|别太谨慎|不要太谨慎|大胆尝试|少些顾虑|\b(?:be less cautious|stop rechecking|try more boldly)\b/iu,
  },
};
function behavioralTraits(evidence) {
  const values = {}, supporting = {}, metadata = {}, selected = [];
  for (const key of TRAITS) {
    const rule = BEHAVIOR[key];
    const episodes = dimensionEpisodes(evidence, event => {
      const positive = directedClause(event.text, text => {
        const match = rule.positive.exec(text);
        return !!match && !rule.negative.test(text)
          && !/(?:不要|不用|不必|别|避免|不能|无需|do not|don't|never|avoid).{0,14}$/iu.test(text.slice(0, match.index));
      });
      const negative = directedClause(event.text, text => rule.negative.test(text));
      return positive && negative ? ['positive', 'negative'] : positive ? ['positive'] : negative ? ['negative'] : [];
    });
    let value = 0.5, direction = null, run = [], support = [];
    for (const episode of episodes) {
      if (episode.key === null) { direction = null; run = []; continue; }
      if (episode.key !== direction) { direction = episode.key; run = []; }
      run.push(episode.event);
      if (run.length < 3) continue;
      value = Math.max(0.3, Math.min(0.7, round(value + (direction === 'positive' ? 0.02 : -0.02))));
      support = run.slice(-3);
    }
    values[key] = value;
    supporting[key] = support.map(event => event.eventId);
    metadata[key] = { episodeCount: episodes.filter(item => item.key !== null).length,
      lastAdjustedAt: support.length ? new Date(Date.parse(support.at(-1).timestamp)).toISOString() : null };
    selected.push(...support);
  }
  return { value: { values, evidence: supporting, support: metadata, derivation: 'directed_feedback', stepLimit: 0.02 }, selected };
}

/** Derive from committed evidence; elapsed wall time alone never changes personality. */
export function deriveSelfUnderstanding(events, previous = null) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const evidence = validEvents(events), byId = new Map(evidence.map(event => [event.eventId, event]));
  const topicRows = new Map(TOPICS.map(topic => [topic.key, evidence.filter(event => topic.pattern.test(event.text.replace(/猫王/gu, '')))]));
  const topicWatermark = Math.max(0, ...[...topicRows.values()].flatMap(rows => independent(rows).map(event => Date.parse(event.timestamp))));
  const priorTopics = new Set(previous?.topics?.map(item => item.key) || []);
  const topics = TOPICS.map(topic => {
    const match = event => topic.pattern.test(event.text.replace(/猫王/gu, ''));
    const support = candidate(topic.key, topicRows.get(topic.key), topicWatermark, legacyIds(previous, 'topics', topic.key), byId, match);
    return support && { ...support, label: topic.label };
  }).filter(Boolean).sort((a, b) => (b.supportScore + Number(priorTopics.has(b.key)) * 0.35)
    - (a.supportScore + Number(priorTopics.has(a.key)) * 0.35) || compare(a.key, b.key)).slice(0, IDENTITY_GROWTH_POLICY.maxTopics);
  const expressions = [], corrections = [];
  for (const dimension of ['detail', 'tone']) {
    const options = EXPRESSIONS.filter(item => item.dimension === dimension);
    const episodes = dimensionEpisodes(evidence, event => options.filter(item => expressionMatch(event.text, item)).map(item => item.key));
    const collected = collectEpisodes(episodes);
    const watermark = Math.max(0, ...episodes.filter(item => item.key !== null).map(item => Date.parse(item.event.timestamp)));
    const prior = previous?.expression?.find(item => options.some(option => option.key === item.key))?.key;
    const support = choose(options.map(option => {
      const retraction = expressionRetraction(evidence, option);
      if (retraction.retracted) {
        corrections.push({ key: option.key, label: option.label, rows: retraction.rows,
          episodeCount: retraction.episodeCount, supportBasis: 'explicit_retraction' });
        return null;
      }
      return candidate(option.key, collected.get(option.key) || [], watermark,
        legacyIds(previous, 'expression', option.key), byId, event => expressionMatch(event.text, option));
    }), prior);
    if (support) expressions.push({ ...support, label: options.find(option => option.key === support.key).label });
  }
  const namingEpisodes = dimensionEpisodes(evidence, event => {
    const name = explicitName(event.text); return name ? [name] : [];
  });
  const naming = collectEpisodes(namingEpisodes);
  if (previous?.displayName && !naming.has(previous.displayName)) naming.set(previous.displayName, []);
  const nameWatermark = Math.max(0, ...namingEpisodes.filter(item => item.key !== null).map(item => Date.parse(item.event.timestamp)));
  const name = choose([...naming].map(([key, rows]) => candidate(key, rows, nameWatermark,
    legacyIds(previous, 'name', key), byId, event => explicitName(event.text) === key)), previous?.displayName);
  const behavior = behavioralTraits(evidence);
  const selected = () => [...expressions, ...(name ? [name] : [])].flatMap(item => item.rows)
    .concat(corrections.flatMap(item => item.rows), behavior.selected, topics.flatMap(item => item.rows));
  while (new Set(selected().map(event => event.eventId)).size > IDENTITY_GROWTH_POLICY.maxEvidence && topics.length) topics.pop();
  const selectedEvents = [...new Map(selected().map(event => [event.eventId, event])).values()].sort(eventOrder);
  const parts = [];
  if (topics.length) parts.push('在共同交流中逐渐关注' + topics.map(item => item.label).join('、'));
  if (expressions.length) parts.push('逐渐适应' + expressions.map(item => item.label).join('、') + '的交流方式');
  if (name) parts.push('在多次明确称呼中逐渐形成名字“' + name.key + '”');
  if (corrections.length) parts.push('根据反复反馈撤回' + corrections.map(item => item.label).join('、') + '的交流习惯');
  const learnedBehavior = TRAITS.filter(key => behavior.value.evidence[key].length);
  if (learnedBehavior.length) parts.push('根据反复反馈微调交流倾向');
  return {
    status: parts.length ? 'established' : 'forming',
    summary: parts.length ? limit('规则归纳（推断）：' + parts.join('；') + '。这些是交流形成的线索，不代表亲身体验或生来偏好。', 600) : '',
    displayName: name?.key || null, nameSupport: name ? publicSupport(name) : null,
    evidenceIds: selectedEvents.map(event => event.eventId),
    sessionCount: new Set(evidence.map(event => event.sessionId)).size,
    episodeCount: independent(evidence).length,
    updatedAt: selectedEvents.length ? new Date(Date.parse(selectedEvents.at(-1).timestamp)).toISOString() : null,
    topics: topics.map(publicSupport), expression: expressions.map(publicSupport),
    expressionCorrections: corrections.map(item => ({ key: item.key, label: item.label,
      evidenceIds: item.rows.map(event => event.eventId), episodeCount: item.episodeCount, supportBasis: item.supportBasis })),
    nameEvidenceIds: name?.rows.map(event => event.eventId) || [],
    behavioralTraits: behavior.value,
    derivation: 'rule_inference', ruleVersion: IDENTITY_GROWTH_POLICY.ruleVersion,
  };
}
