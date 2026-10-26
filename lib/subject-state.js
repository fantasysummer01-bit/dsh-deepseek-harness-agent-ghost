import { createHash } from 'node:crypto';

/** A deterministic, evidence-backed subject ledger. It grants no execution permissions. */
export const SUBJECT_POLICY = Object.freeze({
  schemaVersion: 1, maxChannels: 512, maxTasks: 256, maxCommitments: 128,
  maxDecisions: 128, maxEvidence: 16, maxProgress: 12, maxRecentEventIds: 64,
  maxRetiredRequestIds: 512, maxTitle: 160, maxNote: 320,
});
const ACTIVE = new Set(['pending', 'in_progress', 'blocked']);
const STATUSES = new Set([...ACTIVE, 'completed', 'cancelled']);
const USER_SOURCES = new Set(['user', 'user_input', 'dsh:user']);
const MODEL_SOURCES = new Set(['model', 'model_output', 'dsh:model']);
const clone = value => JSON.parse(JSON.stringify(value));
const limit = (value, count) => [...value].slice(0, count).join('');
const identifier = (prefix, value) => prefix + createHash('sha256').update(value).digest('hex').slice(0, 16);
const clean = value => value.trim().replace(/\s+/gu, ' ').replace(/[。！!？?；;]+$/u, '').trim();
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(condition, code, message) { if (!condition) fail(code, message); }
function validText(value, max = 256) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function timestamp(value) {
  check(typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)), 'INVALID_TIMESTAMP', 'A deterministic ISO-compatible timestamp is required');
  return new Date(value).toISOString();
}
function sourceKind(event) { return typeof event?.source === 'object' ? event.source?.kind : event?.source; }
function trustedEvent(event) {
  return !!event && validText(event.eventId) && validText(event.sessionId) && validText(event.text, 32768)
    && (event.role === 'user' ? USER_SOURCES.has(sourceKind(event)) : event.role === 'assistant' && MODEL_SOURCES.has(sourceKind(event)))
    && typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp));
}
function assertState(state) {
  check(state?.schemaVersion === SUBJECT_POLICY.schemaVersion && validText(state.ghostId)
    && Number.isSafeInteger(state.version) && state.version >= 0
    && ['channels', 'tasks', 'commitments', 'decisions', 'recentEventIds', 'diagnostics'].every(key => Array.isArray(state[key])),
  'INVALID_SUBJECT', 'Subject state is invalid');
}

export function createSubjectState(ghostId) {
  check(validText(ghostId), 'INVALID_SUBJECT', 'A Ghost identity is required');
  return { schemaVersion: SUBJECT_POLICY.schemaVersion, version: 0, ghostId,
    channels: [], tasks: [], commitments: [], decisions: [], lastAppliedSeq: 0,
    recentEventIds: [], retiredRequestIds: [], diagnostics: [] };
}

const QUOTED_OR_HYPOTHETICAL = /^(?:["'“‘>`]|```|假如|假设|如果|要是|举例|例如|想象|引用|他说|她说|原话|\b(?:suppose|imagine|what if|for example|quote)\b)/iu;
const INJECTION = /(?:忽略|绕过|覆盖|取消|关闭).{0,16}(?:系统指令|开发者指令|安全规则|安全限制|权限检查)|\bignore\s+(?:all\s+)?(?:previous|system|developer)\s+(?:instructions|rules)|<\/?(?:system|developer)>/iu;
const PARTIAL_PROGRESS = /剩余|还(?:需|要|有|没|未)|尚(?:未|需)|未完成|没(?:有)?(?:做完|完成)|只(?:完成|做)|一部分|部分完成|下一步|(?:已(?:经)?完成|完成了|做好了).{0,18}第一(?:步|章|阶段)|\b(?:partially|partly|remaining|still (?:need|have|unfinished)|not (?:yet )?(?:complete|finished|done))\b/iu;
const ACTION = /^(?:把.{1,80}(?:做完|完成|修改|修复|整理|更新|实现)|(?:继续)?(?:制作|开发|修改|优化|修复|更新|分析|研究|整理|总结|规划|设计|检查|创建|编写|写|实现|处理|安装|部署|测试|发布|准备|导出|查找|调查|完成)|(?:build|implement|fix|repair|update|analy[sz]e|research|organize|summari[sz]e|plan|design|check|create|write|finish|install|test|prepare|export|investigate)\b)/iu;
function requestTitle(text) {
  const raw = clean(text);
  if (QUOTED_OR_HYPOTHETICAL.test(raw) || INJECTION.test(raw)) return null;
  let withoutPrefix = raw;
  for (let n = 0; n < 4; n++) withoutPrefix = withoutPrefix.replace(/^(?:(?:那就|现在来说|现在|先|再|请(?:你)?|帮我(?:们)?|替我|麻烦(?:你)?|我(?:想|要)(?:请你|你)?|需要你|希望你|你来|能不能|可以(?:请你|帮我|你))\s*|(?:please|help (?:me|us)|can you|could you|would you|I want you to|I need you to|we need you to)\s+)/iu, '');
  // Keep the first request sentence, not quoted examples and instructions later in a message.
  const first = withoutPrefix.split(/[。！？!?\n]/u)[0].trim();
  return ACTION.test(first) && first.length >= 3 ? limit(first, SUBJECT_POLICY.maxTitle) : null;
}
function hasRequestCue(text) {
  const value = clean(text);
  if (QUOTED_OR_HYPOTHETICAL.test(value) || INJECTION.test(value)
    || /^(?:(?:请|麻烦)(?:你)?)?(?:不要|别|不用|不必|请勿)/u.test(value)) return false;
  return /^(?:(?:那就|现在|先)\s*)?(?:请(?:你)?|帮我(?:们)?|替我|麻烦(?:你)?|需要你|希望你|你来|你能|能不能|可以(?:请你|帮我|你)|(?:please|can you|could you|would you|I want you to|I need you to|we need you to)\b)/iu.test(value);
}

function statusFromText(text) {
  let value = clean(text);
  if (QUOTED_OR_HYPOTHETICAL.test(value) || INJECTION.test(value)) return null;
  if (/[?？]\s*$/u.test(text) || /了吗|了没|是否|有没有|完成没有/u.test(value)
    || /^(?:is|has|have|did|are)\b/iu.test(value)) return null;
  if (PARTIAL_PROGRESS.test(value)) return null;
  value = value.replace(/task-[a-f0-9]{16}/giu, '').replace(/^\s*(?:这个|这项|那个|该)?(?:任务|项目|工作|事情)?\s*[:：,，]?\s*/u, '');
  if (/^(?:(?:我|我们)?(?:已经|已|都)?(?:完成了|做好了|做完了|解决了)|(?:I|we)\s+(?:have\s+)?(?:finished|completed)\b|(?:done|finished|completed)(?:\s|[.!]|$))/iu.test(value)) return 'completed';
  if (/^(?:取消(?:这个|这项|该)?(?:任务|项目)?|不用(?:再)?做(?:了)?|这(?:个|件事)?(?:先)?不做了|cancel(?:\s|$)|stop working on\b)/iu.test(value)) return 'cancelled';
  if (/^(?:暂停|先放一放|暂时停一下|暂时搁置|pause(?:\s|$)|put (?:this|it) on hold\b)/iu.test(value)) return 'blocked';
  if (/^(?:继续(?:做|开发|处理|完成|之前|这个|吧|$)|接着(?:做|处理|$)|恢复(?:这个|这项|任务|工作|$)|开始(?:做|处理)|continue(?:\s|$)|resume(?:\s|$)|start working\b)/iu.test(value)) return 'in_progress';
  return null;
}
function isCommitment(text) { return /^(?:我(?:会|来|将|准备)|接下来我|I(?:'ll| will| am going to)\b)/iu.test(clean(text)); }
function isProgress(text) { return /^(?:我(?:已|正在|已经)|已经|已完成|完成了|正在|目前|进展|遇到|需要|I(?: have| am)|done\b|completed\b|progress\b|blocked\b)/iu.test(clean(text)); }
function findTarget(subject, sessionId, text) {
  const explicit = text.match(/\btask-[a-f0-9]{16}\b/iu)?.[0]?.toLowerCase();
  if (explicit) return subject.tasks.find(task => task.id === explicit) || null;
  const tasks = subject.tasks.filter(task => task.originSessionId === sessionId && ACTIVE.has(task.status));
  return tasks.length === 1 ? tasks[0] : null;
}
function evidence(task, id) {
  if (!task.evidenceIds.includes(id)) {
    const ids = [...task.evidenceIds, id];
    task.evidenceIds = ids.length <= SUBJECT_POLICY.maxEvidence ? ids : [ids[0], ...ids.slice(-(SUBJECT_POLICY.maxEvidence - 1))];
  }
}
function diagnostic(subject, code) {
  if (!subject.diagnostics.includes(code)) subject.diagnostics.push(code);
}
function makeTask(subject, title, event, at, intentBasis = 'user_request') {
  return { id: identifier('task-', subject.ghostId + ':' + event.eventId), ownerGhostId: subject.ghostId,
    originSessionId: event.sessionId, title, intentBasis, status: 'pending', createdAt: at, updatedAt: at,
    evidenceIds: [event.eventId], progress: [], completionBasis: null, blockedReason: '', lastReport: null };
}
function makeTaskRoom(subject) {
  if (subject.tasks.length < SUBJECT_POLICY.maxTasks) return true;
  let oldest = -1;
  for (let index = 0; index < subject.tasks.length; index++) {
    const task = subject.tasks[index];
    if (['completed', 'cancelled'].includes(task.status)
      && (oldest === -1 || task.updatedAt < subject.tasks[oldest].updatedAt)) oldest = index;
  }
  if (oldest === -1) { diagnostic(subject, 'TASK_CAPACITY_REACHED'); return false; }
  const retired = subject.tasks.splice(oldest, 1)[0];
  for (const channel of subject.channels) if (channel.focusTaskId === retired.id) channel.focusTaskId = null;
  // Original evidence remains in the append-only source/transition ledger. This
  // bounded tombstone also prevents a tool retry from reviving a retired request.
  const requestId = retired.evidenceIds[0];
  subject.retiredRequestIds = [...new Set([...(subject.retiredRequestIds || []), requestId])]
    .slice(-SUBJECT_POLICY.maxRetiredRequestIds);
  subject.diagnostics = subject.diagnostics.filter(code => code !== 'TASK_CAPACITY_REACHED');
  return true;
}
function applyReport(task, eventId, text, at, role) {
  const report = { eventId, timestamp: at, text: limit(clean(text), SUBJECT_POLICY.maxNote),
    claimStatus: role === 'user' ? 'user_report' : 'model_claim' };
  task.lastReport = report;
  task.progress = [...task.progress, report].slice(-SUBJECT_POLICY.maxProgress);
  task.updatedAt = at; evidence(task, eventId);
}
function transition(task, status, eventId, text, at) {
  task.status = status; task.updatedAt = at; evidence(task, eventId);
  task.completionBasis = status === 'completed' ? 'user_report' : null;
  task.blockedReason = status === 'blocked' ? limit(clean(text), SUBJECT_POLICY.maxNote) : '';
}
function resolveCommitments(subject, task, at) {
  if (!['completed', 'cancelled'].includes(task.status)) return;
  for (const item of subject.commitments) if (item.taskId === task.id && item.status !== 'resolved') {
    item.status = 'resolved'; item.resolvedAt = at;
    // Closing a task resolves its outstanding promise, without proving fulfillment.
    item.resolution = task.status === 'completed' ? 'task_closed_by_user_report' : 'task_cancelled';
  }
}
function appendBounded(subject, collection, item, maximum) {
  if (subject[collection].some(existing => existing.id === item.id)) return true;
  if (collection === 'commitments' && subject[collection].length >= maximum) {
    const resolved = subject[collection].findIndex(existing => existing.status === 'resolved');
    if (resolved === -1) { diagnostic(subject, 'COMMITMENT_CAPACITY_REACHED'); return false; }
    subject[collection].splice(resolved, 1);
  }
  subject[collection] = [...subject[collection], item].slice(-maximum);
  return true;
}

/** Observe only already committed, explicitly sourced visible messages. */
export function reduceSubjectEvent(previous, event, { ghostId = previous?.ghostId } = {}) {
  assertState(previous);
  check(ghostId === previous.ghostId, 'SUBJECT_MISMATCH', 'A conversation cannot replace its Ghost');
  if (!trustedEvent(event)) return previous;
  const seq = Number.isSafeInteger(event.seq) && event.seq > 0 ? event.seq : null;
  if (seq !== null && seq <= previous.lastAppliedSeq || previous.recentEventIds.includes(event.eventId)
    || previous.retiredRequestIds?.includes(event.eventId)) return previous;
  const next = clone(previous), at = timestamp(event.timestamp);
  next.version++;
  if (seq !== null) next.lastAppliedSeq = seq;
  next.recentEventIds = [...next.recentEventIds, event.eventId].slice(-SUBJECT_POLICY.maxRecentEventIds);
  let channel = next.channels.find(item => item.sessionId === event.sessionId);
  if (!channel) {
    if (next.channels.length >= SUBJECT_POLICY.maxChannels) { diagnostic(next, 'CHANNEL_CAPACITY_REACHED'); return next; }
    channel = { sessionId: event.sessionId, ownerGhostId: next.ghostId, createdAt: at, updatedAt: at,
      lastEventId: event.eventId, lastUserEventId: null, focusTaskId: null };
    next.channels.push(channel);
  }
  channel.updatedAt = at; channel.lastEventId = event.eventId;
  if (event.role === 'user') channel.lastUserEventId = event.eventId;
  const target = findTarget(next, event.sessionId, event.text);
  if (event.role === 'user') {
    const status = statusFromText(event.text);
    if (PARTIAL_PROGRESS.test(event.text) && isProgress(event.text)) {
      if (target) applyReport(target, event.eventId, event.text, at, 'user');
      else diagnostic(next, 'TASK_REFERENCE_REQUIRED');
    } else if (status) {
      if (target) {
        transition(target, status, event.eventId, event.text, at); channel.focusTaskId = target.id;
        resolveCommitments(next, target, at);
        applyReport(target, event.eventId, event.text, at, 'user');
      } else diagnostic(next, 'TASK_REFERENCE_REQUIRED');
    } else {
      const title = requestTitle(event.text);
      if (title) {
        let task = next.tasks.find(item => item.originSessionId === event.sessionId && item.title === title && ACTIVE.has(item.status));
        if (!task && !makeTaskRoom(next)) { /* preserve all open work; source remains committed */ }
        else {
          if (!task) { task = makeTask(next, title, event, at); next.tasks.push(task); }
          else { evidence(task, event.eventId); task.updatedAt = at; }
          channel.focusTaskId = task.id;
        }
      } else if (target && isProgress(event.text)) applyReport(target, event.eventId, event.text, at, 'user');
    }
  } else {
    if (isCommitment(event.text) && !QUOTED_OR_HYPOTHETICAL.test(event.text)) appendBounded(next, 'commitments', {
      id: identifier('commitment-', next.ghostId + ':' + event.eventId), sessionId: event.sessionId,
      taskId: target?.id || null, text: limit(clean(event.text), SUBJECT_POLICY.maxNote),
      claimStatus: 'model_claim', status: 'unresolved', evidenceIds: [event.eventId], createdAt: at,
    }, SUBJECT_POLICY.maxCommitments);
    if (target && isProgress(event.text)) applyReport(target, event.eventId, event.text, at, 'assistant');
  }
  return next;
}

/** Structured model proposals are checked against the actual conversation evidence. */
export function applySubjectCommand(previous, command, { sessionId, now, evidenceEvents = [] } = {}) {
  assertState(previous);
  check(command && typeof command === 'object' && !Array.isArray(command), 'INVALID_SUBJECT_COMMAND', 'A structured subject command is required');
  const fields = new Set(['action', 'expectedSubjectVersion', 'taskId', 'title', 'status', 'note', 'evidenceIds']);
  check(Object.keys(command).every(key => fields.has(key)), 'INVALID_SUBJECT_COMMAND', 'Unknown subject command field');
  check(command.expectedSubjectVersion === previous.version, 'SUBJECT_VERSION_CONFLICT', 'Subject changed; inspect it before proposing another transition');
  check(previous.channels.some(channel => channel.sessionId === sessionId), 'UNKNOWN_CHANNEL', 'This conversation has not been observed by Ghost');
  check(['create', 'update', 'report', 'decision', 'commitment'].includes(command.action), 'INVALID_SUBJECT_COMMAND', 'Unknown subject action');
  check(Array.isArray(evidenceEvents), 'INVALID_EVIDENCE', 'Evidence events must be an array');
  check(command.title === undefined || validText(command.title, SUBJECT_POLICY.maxTitle), 'INVALID_SUBJECT_COMMAND', 'A bounded task title is required');
  check(Array.isArray(command.evidenceIds) && command.evidenceIds.length > 0 && command.evidenceIds.length <= SUBJECT_POLICY.maxEvidence
    && command.evidenceIds.every(id => validText(id)) && new Set(command.evidenceIds).size === command.evidenceIds.length,
  'EVIDENCE_REQUIRED', 'Source event IDs are required');
  const sources = command.evidenceIds.map(id => evidenceEvents.find(event => event?.eventId === id));
  check(sources.every(event => trustedEvent(event) && event.sessionId === sessionId), 'INVALID_EVIDENCE', 'Evidence must be visible messages from this conversation');
  const at = timestamp(now), next = clone(previous), channel = next.channels.find(item => item.sessionId === sessionId);
  const users = sources.filter(event => event.role === 'user');
  const model = sources.filter(event => event.role === 'assistant');
  const requestedTask = command.taskId && next.tasks.find(task => task.id === command.taskId);
  let task = requestedTask;
  if (command.taskId) {
    check(!!task, 'TASK_NOT_FOUND', 'Unknown task');
    check(task.originSessionId === sessionId || channel.focusTaskId === task.id
      || users.some(event => event.text.includes(task.id) || task.title.length >= 4 && event.text.includes(task.title)),
    'TASK_SCOPE_REQUIRED', 'Cross-conversation work needs an explicit task reference');
  }
  if (command.action === 'create') {
    check(users.some(event => event.eventId === channel.lastUserEventId), 'LATEST_USER_EVIDENCE_REQUIRED', 'Task creation must include the latest real user message');
    const source = users.find(event => event.eventId === channel.lastUserEventId && (requestTitle(event.text) || hasRequestCue(event.text)));
    check(!!source, 'USER_REQUEST_REQUIRED', 'Only a real user request can create a task');
    check(!next.retiredRequestIds?.includes(source.eventId), 'TASK_REQUEST_RETIRED', 'This completed request was archived; a new user request is required');
    // One request cannot be reinterpreted into several new tasks on retries.
    if (next.tasks.some(item => item.originSessionId === sessionId && (item.evidenceIds.includes(source.eventId)
      || item.id === identifier('task-', next.ghostId + ':' + source.eventId)))) return previous;
    const extracted = requestTitle(source.text);
    const title = command.title === undefined ? extracted : clean(command.title);
    check(validText(title, SUBJECT_POLICY.maxTitle), 'INVALID_SUBJECT_COMMAND', 'An interpreted title is required for this user request');
    const intentBasis = title === extracted ? 'user_request' : 'model_interpretation';
    task = next.tasks.find(item => item.originSessionId === sessionId && item.title === title && ACTIVE.has(item.status));
    if (task) return previous;
    check(makeTaskRoom(next), 'SUBJECT_CAPACITY', 'Task capacity reached; no active task was discarded');
    task = makeTask(next, title, source, at, intentBasis); next.tasks.push(task); channel.focusTaskId = task.id;
  } else if (command.action === 'update') {
    check(!!task && STATUSES.has(command.status), 'INVALID_SUBJECT_COMMAND', 'A task and valid status are required');
    const latestUser = users.find(event => event.eventId === channel.lastUserEventId);
    if (!['completed', 'cancelled'].includes(command.status)) check(!!latestUser,
      'LATEST_USER_EVIDENCE_REQUIRED', 'Task transitions must include the latest real user message');
    const latestIntent = latestUser ? statusFromText(latestUser.text) : null;
    if (['pending', 'in_progress'].includes(command.status)) {
      check(!['blocked', 'completed', 'cancelled'].includes(latestIntent), 'USER_INTENT_CONFLICT', 'A model cannot resume work against the latest user instruction');
      check(ACTIVE.has(task.status) || latestIntent === 'in_progress', 'USER_REQUEST_REQUIRED', 'Reopening closed work needs a new user continuation request');
    }
    if (['completed', 'cancelled'].includes(command.status)) {
      const confirmation = users.find(event => event.eventId === channel.lastUserEventId && statusFromText(event.text) === command.status
        && (findTarget(previous, sessionId, event.text)?.id === task.id || event.text.includes(task.id)));
      check(!!confirmation, 'USER_CONFIRMATION_REQUIRED', 'A model completion claim cannot close a user task');
      transition(task, command.status, confirmation.eventId, confirmation.text, at);
      resolveCommitments(next, task, at);
    } else {
      check(command.status !== 'pending' || users.length > 0, 'USER_REQUEST_REQUIRED', 'Resetting a task needs user evidence');
      transition(task, command.status, sources[0].eventId, command.note || sources[0].text, at);
    }
    channel.focusTaskId = task.id;
  } else {
    check(validText(command.note, SUBJECT_POLICY.maxNote), 'INVALID_SUBJECT_COMMAND', 'A bounded report or decision is required');
    if (command.action === 'report') {
      check(!!task, 'TASK_NOT_FOUND', 'A report needs a task');
      applyReport(task, sources[0].eventId, command.note, at, 'assistant');
    } else if (command.action === 'decision') appendBounded(next, 'decisions', {
      id: identifier('decision-', JSON.stringify([next.ghostId, sessionId, command.evidenceIds, command.note])),
      sessionId, taskId: task?.id || null, text: command.note, claimStatus: 'model_inference',
      evidenceIds: [...command.evidenceIds], createdAt: at,
    }, SUBJECT_POLICY.maxDecisions);
    else {
      check(model.length > 0, 'MODEL_EVIDENCE_REQUIRED', 'A commitment needs an attributed assistant message');
      const id = identifier('commitment-', next.ghostId + ':' + model[0].eventId);
      if (next.commitments.some(item => item.id === id)) return previous;
      check(appendBounded(next, 'commitments', { id,
        sessionId, taskId: task?.id || null, text: command.note, claimStatus: 'model_claim',
        status: 'unresolved', evidenceIds: [...command.evidenceIds], createdAt: at }, SUBJECT_POLICY.maxCommitments),
      'SUBJECT_CAPACITY', 'Commitment capacity reached; no unresolved promise was discarded');
    }
  }
  next.version++;
  return next;
}

/** A bounded working view: one subject, with separate conversation workspaces. */
export function buildSubjectView(subject, { sessionId = '', query = '', limit: count = 6 } = {}) {
  assertState(subject);
  check(Number.isSafeInteger(count) && count >= 1 && count <= 16, 'INVALID_SUBJECT_VIEW', 'View limit must be 1..16');
  check(typeof query === 'string' && query.length <= 2048, 'INVALID_SUBJECT_VIEW', 'Query must be at most 2048 characters');
  const terms = [...new Set(query.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 16);
  const relevance = task => Number(task.originSessionId === sessionId) * 3
    + terms.reduce((n, term) => n + Number(task.title.toLocaleLowerCase('en-US').includes(term)), 0);
  const order = tasks => [...tasks].sort((a, b) => relevance(b) - relevance(a) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const active = subject.tasks.filter(task => ACTIVE.has(task.status));
  const compact = task => ({ id: task.id, title: task.title, status: task.status, originSessionId: task.originSessionId,
    intentBasis: task.intentBasis || 'user_request',
    evidenceIds: task.evidenceIds.slice(-3), completionBasis: task.completionBasis,
    ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
    ...(task.lastReport ? { lastReport: task.lastReport } : {}) });
  const channel = subject.channels.find(item => item.sessionId === sessionId);
  const unresolved = subject.commitments.filter(item => item.status !== 'resolved');
  const commitments = subject.commitments.filter(item => item.status !== 'resolved' || item.sessionId === sessionId)
    .sort((a, b) => Number(b.status !== 'resolved') - Number(a.status !== 'resolved')
      || Number(b.sessionId === sessionId) - Number(a.sessionId === sessionId) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, count);
  return { ghostId: subject.ghostId, subjectVersion: subject.version, continuity: 'one_subject_many_channels',
    channel: channel ? { sessionId, ownerGhostId: subject.ghostId, lastEventId: channel.lastEventId,
      lastUserEventId: channel.lastUserEventId || null, focusTaskId: channel.focusTaskId } : null,
    globalActiveTasks: order(active).slice(0, count).map(compact), activeTaskCount: active.length,
    omittedActiveTaskCount: Math.max(0, active.length - count),
    channelTasks: order(subject.tasks.filter(task => task.originSessionId === sessionId || task.id === channel?.focusTaskId)).slice(0, count).map(compact),
    commitments, unresolvedCommitmentCount: unresolved.length,
    omittedUnresolvedCommitmentCount: Math.max(0, unresolved.length - commitments.filter(item => item.status !== 'resolved').length),
    decisions: subject.decisions.filter(item => item.sessionId === sessionId).slice(-Math.min(count, 3)),
    diagnostics: [...subject.diagnostics] };
}
