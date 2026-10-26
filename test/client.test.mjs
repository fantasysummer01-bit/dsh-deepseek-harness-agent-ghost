import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const fixture = () => ({
  ghostId: 'ghost-ui-test', branchId: 'branch-ui-test', version: 4,
  name: 'Ghost', identity: '', traits: { curiosity: .5, initiative: .4, caution: .7 }, goals: [],
  settings: { enabled: false, captureEnabled: false, captureAssistant: true, allowedSessions: [], contextBudgetBytes: 6000, topK: 5 },
  counts: { events: 3, changes: 2 }, health: { ok: true, readOnly: false, error: null },
  selfUnderstanding: { status: 'forming', summary: '', displayName: null, evidenceIds: [], sessionCount: 0, updatedAt: null },
});
function harness(responder = () => ({ ok: true, value: fixture() })) {
  let plugin, registrant, styleCount = 0, cursor = 0, effectQueued = false;
  const hooks = [], calls = [], downloads = [], blobs = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(work) { if (!effectQueued) { effectQueued = true; work(); } },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(spec) { assert.equal(spec.id, 'dsh-ghost'); plugin = spec.factory(name => { assert.equal(name, 'react'); return React; }); } } },
    document: { getElementById: () => styleCount ? {} : null,
      createElement: tag => tag === 'a' ? { click() { downloads.push({ filename: this.download, href: this.href }); }, remove() {} } : { dataset: {} },
      body: { appendChild() {} }, head: { appendChild() { styleCount++; } } },
    Blob, URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    console, setTimeout: callback => callback(),
  });
  vm.runInContext(source, context);
  plugin.apply({
    slots: { inject(name, work) { assert.equal(name, 'settings.section'); return work(); }, register(options, render) { registrant = { options, render }; } },
    connection: { rpc: { async call(...args) { calls.push(args); return responder(...args); } } },
  });
  return { plugin, calls, registrant, downloads, blobs,
    render() { cursor = 0; const panel = registrant.render(); return panel.type(panel.props); },
    styles: () => styleCount,
  };
}
function walk(node, predicate, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node)) { for (const item of node) walk(item, predicate, output); return output; }
  if (predicate(node)) output.push(node);
  walk(node.props?.children, predicate, output); return output;
}
const text = node => !node ? '' : typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : typeof node.type === 'function' ? text(node.type(node.props)) : text(node.props?.children);
const settle = () => new Promise(resolve => setImmediate(resolve));
const button = (panel, label) => walk(panel, node => text(node) === label && typeof node.props?.onClick === 'function')[0];
const plan = (patch = {}) => ({
  planId: 'uninstall-ui-plan', expiresAt: new Date(Date.now() + 300000).toISOString(),
  ghostId: 'ghost-ui-test', stateVersion: 4, requiresDshExit: true,
  dataDir: 'C:\\MockHome\\.dsh\\ghost', profileDir: 'C:\\MockHome\\.dsh\\profiles\\desktop',
  deleteFiles: ['ghost.sqlite', 'ghost.sqlite-wal'], retained: ['手工导出或外部备份保留'],
  confirmationText: 'UNINSTALL GHOST', ...patch,
});
async function loaded(responder) { const app = harness(responder); app.render(); await settle(); return app; }
function acknowledge(app, value = 'UNINSTALL GHOST', checked = true) {
  let panel = app.render();
  walk(panel, node => node.type === 'input' && node.props?.['aria-label'] === '确认删除 Ghost 本地记忆与状态')[0].props.onChange({ target: { checked } });
  panel = app.render();
  walk(panel, node => node.type === 'input' && node.props?.['aria-label'] === '卸载确认文字')[0].props.onChange({ target: { value } });
}

test('registers a default-off Ghost control surface through authenticated RPC', async () => {
  const app = await loaded();
  assert.deepEqual(Array.from(app.plugin.inject), ['slots', 'connection']);
  assert.equal(app.registrant.options.id, 'ghost'); assert.equal(app.registrant.options.order, 27);
  assert.equal(app.styles(), 1); assert.deepEqual(app.calls[0].slice(0, 2), ['/ghost', 'status']);
  const panel = app.render();
  assert.match(text(panel), /已关闭/); assert.match(text(panel), /已积累 3 条经历/);
  assert.match(text(panel), /Ghost 为智能体保存记忆和人格/);
  assert.match(text(panel), /记忆管理参考海马体/);
  assert.equal(button(panel, '启动 GHOST 系统').props.disabled, false);
  assert.equal(app.calls.length, 1);
});

test('start and stop use parameter-free actions and display returned state', async () => {
  const state = fixture();
  const app = await loaded((_service, action) => {
    if (action === 'start') { state.settings.enabled = true; state.settings.captureEnabled = true; }
    if (action === 'stop') { state.settings.enabled = false; state.settings.captureEnabled = false; }
    return { ok: true, value: structuredClone(state) };
  });
  await button(app.render(), '启动 GHOST 系统').props.onClick();
  assert.match(text(app.render()), /运行中/);
  const start = app.calls.find(row => row[1] === 'start');
  assert.deepEqual(Object.keys(start[2]), []);
  await button(app.render(), '关闭').props.onClick();
  assert.match(text(app.render()), /已关闭/);
  assert.equal(app.calls.some(row => row[1] === 'configure'), false);
  assert.deepEqual(Object.keys(app.calls.find(row => row[1] === 'stop')[2]), []);
});

test('legacy enabled without capture is not treated as running and never starts automatically', async () => {
  const state = fixture(); state.settings.enabled = true;
  const app = await loaded(() => ({ ok: true, value: state }));
  assert.ok(button(app.render(), '启动 GHOST 系统'));
  assert.equal(app.calls.some(row => row[1] === 'start'), false);
});

test('the daily surface has no manual identity, trait, goal, budget or memory editors', async () => {
  const state = fixture();
  state.selfUnderstanding = { status: 'established', summary: '不可编辑的内部归纳', displayName: '内部称呼', evidenceIds: ['evt-1'], sessionCount: 3 };
  const app = await loaded(() => ({ ok: true, value: state }));
  const panel = app.render();
  assert.equal(walk(panel, node => ['input', 'textarea', 'select'].includes(node.type)).length, 0);
  for (const title of ['基本设置', '性格与未完成目标', '记忆检索', '检查点与恢复', '从长期交流形成的身份']) assert.doesNotMatch(text(panel), new RegExp(title));
  assert.doesNotMatch(text(panel), /不可编辑的内部归纳|内部称呼/);
  assert.ok(button(panel, '卸载 Ghost'));
  assert.equal(button(panel, '确认完全卸载'), undefined);
});

test('read-only errors disable start and allow a status refresh', async () => {
  const state = fixture(); state.health = { ok: false, readOnly: true, error: 'checkpoint hash mismatch' };
  const app = await loaded(() => ({ ok: true, value: state }));
  const panel = app.render();
  assert.match(text(panel), /暂不可用|checkpoint hash mismatch/);
  assert.equal(button(panel, '启动 GHOST 系统').props.disabled, true);
  assert.equal(button(panel, '刷新状态').props.disabled, false);
});

test('a failed start does not invent a running Ghost', async () => {
  const app = await loaded((_service, action) => action === 'start'
    ? { ok: false, error: { code: 'UNAVAILABLE', message: '启动失败' } } : { ok: true, value: fixture() });
  await button(app.render(), '启动 GHOST 系统').props.onClick();
  assert.match(text(app.render()), /启动失败/); assert.doesNotMatch(text(app.render()), /运行中/);
  assert.ok(button(app.render(), '启动 GHOST 系统'));
});

test('opening and canceling uninstall review only prepares a plan', async () => {
  const app = await loaded((_service, action) => ({ ok: true, value: action === 'uninstallplan' ? plan() : fixture() }));
  await button(app.render(), '卸载 Ghost').props.onClick();
  let panel = app.render();
  assert.equal(app.calls.filter(row => row[1] === 'uninstallplan').length, 1);
  assert.equal(app.calls.some(row => row[1] === 'uninstallconfirm'), false);
  assert.match(text(panel), /C:\\MockHome\\.dsh\\ghost/); assert.match(text(panel), /ghost.sqlite/);
  assert.equal(button(panel, '确认完全卸载').props.disabled, true);
  await button(panel, '取消卸载审核').props.onClick();
  panel = app.render();
  assert.equal(button(panel, '确认完全卸载'), undefined); assert.ok(button(panel, '卸载 Ghost'));
  assert.equal(app.calls.some(row => row[1] === 'uninstallconfirm'), false);
});

test('uninstall requires a checked acknowledgement and exact phrase before sending reviewed plan/version', async () => {
  const app = await loaded((_service, action) => ({ ok: true, value: action === 'uninstallplan' ? plan() : action === 'uninstallconfirm' ? { pending: true, requiresDshExit: true } : fixture() }));
  await button(app.render(), '卸载 Ghost').props.onClick();
  acknowledge(app, 'UNINSTALL GHOST', false);
  assert.equal(button(app.render(), '确认完全卸载').props.disabled, true);
  acknowledge(app, 'UNINSTALL GHOST ');
  let panel = app.render();
  assert.equal(button(panel, '确认完全卸载').props.disabled, true);
  await button(panel, '确认完全卸载').props.onClick();
  assert.equal(app.calls.some(row => row[1] === 'uninstallconfirm'), false);
  acknowledge(app);
  panel = app.render(); assert.equal(button(panel, '确认完全卸载').props.disabled, false);
  await button(panel, '确认完全卸载').props.onClick();
  const call = app.calls.find(row => row[1] === 'uninstallconfirm');
  assert.equal(call[2].planId, 'uninstall-ui-plan'); assert.equal(call[2].confirmation, 'UNINSTALL GHOST');
  assert.equal(call[2].eraseData, true); assert.equal(call[2].expectedVersion, 4); assert.equal('dataDir' in call[2], false);
  panel = app.render(); assert.match(text(panel), /完全卸载已排队，Ghost 已停用/);
  assert.match(text(panel), /当前 DSH 任务会继续运行/); assert.equal(button(panel, '启动 GHOST 系统'), undefined);
});

test('failed confirmation retains the review and does not claim queued uninstall', async () => {
  const app = await loaded((_service, action) => action === 'uninstallconfirm'
    ? { ok: false, error: { code: 'WORKER_FAILED', message: '无法启动卸载程序' } }
    : { ok: true, value: action === 'uninstallplan' ? plan() : fixture() });
  await button(app.render(), '卸载 Ghost').props.onClick(); acknowledge(app);
  await button(app.render(), '确认完全卸载').props.onClick();
  assert.match(text(app.render()), /无法启动卸载程序/);
  assert.doesNotMatch(text(app.render()), /完全卸载已排队/); assert.ok(button(app.render(), '确认完全卸载'));
});

test('expired plans cannot submit confirmation', async () => {
  const app = await loaded((_service, action) => ({ ok: true, value: action === 'uninstallplan' ? plan({ expiresAt: new Date(Date.now() - 1000).toISOString() }) : fixture() }));
  await button(app.render(), '卸载 Ghost').props.onClick(); acknowledge(app);
  const panel = app.render(); assert.equal(button(panel, '确认完全卸载').props.disabled, true);
  await button(panel, '确认完全卸载').props.onClick();
  assert.equal(app.calls.some(row => row[1] === 'uninstallconfirm'), false);
  assert.match(text(app.render()), /卸载计划已过期/);
});

test('pending uninstall prevents start and remains refreshable', async () => {
  const state = fixture(); state.uninstall = { pending: true, requiresDshExit: true, error: '等待 DSH 退出' };
  const app = await loaded(() => ({ ok: true, value: state }));
  const panel = app.render(); assert.match(text(panel), /待卸载|等待 DSH 退出/);
  assert.equal(button(panel, '启动 GHOST 系统'), undefined); assert.equal(button(panel, '关闭'), undefined);
  assert.equal(button(panel, '刷新卸载状态').props.disabled, false); assert.equal(button(panel, '卸载 Ghost'), undefined);
});

test('plan preparation errors remain visible without a confirmation form', async () => {
  const app = await loaded((_service, action) => action === 'uninstallplan'
    ? { ok: false, error: { code: 'UNSUPPORTED', message: '当前宿主不支持自动卸载' } } : { ok: true, value: fixture() });
  await button(app.render(), '卸载 Ghost').props.onClick();
  assert.match(text(app.render()), /当前宿主不支持自动卸载/);
  assert.equal(button(app.render(), '确认完全卸载'), undefined);
});

test('an RPC failure is visible and does not invent an operational state', async () => {
  const app = await loaded(() => ({ ok: false, error: { code: 'NOT_READY', message: 'runtime unavailable' } }));
  assert.match(text(app.render()), /runtime unavailable/); assert.doesNotMatch(text(app.render()), /运行中/);
  assert.ok(button(app.render(), '重新连接'));
});


test('export downloads a complete core file without changing running or uninstall state', async () => {
  const core={format:'dsh-ghost-core',formatVersion:1,state:{ghostId:'ghost-ui-test'},events:[{eventId:'one'}],sha256:'a'.repeat(64)};
  const app=await loaded((_service,action)=>({ok:true,value:action==='export'?core:fixture()}));
  await button(app.render(),'导出 Ghost 核心').props.onClick();
  assert.equal(app.downloads.length,1);
  assert.equal(app.downloads[0].filename,'ghost-core-ghost-ui-test.json');
  const exported=JSON.parse(await app.blobs[0].text());
  assert.equal(exported.events[0].eventId,'one');
  assert.equal(app.calls.some(row=>['start','uninstallconfirm'].includes(row[1])),false);
});

test('failed export does not download a misleading file', async () => {
  const app=await loaded((_service,action)=>action==='export'?{ok:false,error:{message:'Export failed'}}:{ok:true,value:fixture()});
  await button(app.render(),'导出 Ghost 核心').props.onClick();
  assert.equal(app.downloads.length,0); assert.match(text(app.render()),/Export failed/);
});
