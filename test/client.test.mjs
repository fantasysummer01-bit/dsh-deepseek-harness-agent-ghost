import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const fixture = () => ({
  ghostId: 'ghost-ui-test', branchId: 'branch-ui-test', version: 4,
  name: 'Ghost', identity: '测试身份', traits: { curiosity: .5, initiative: .4, caution: .7 }, goals: ['完成测试'],
  settings: { enabled: true, captureEnabled: false, captureAssistant: false, allowedSessions: [], contextBudgetBytes: 6000, topK: 5 },
  counts: { events: 3, changes: 2 }, health: { ok: true, readOnly: false, error: null }, lastCheckpoint: null,
});

function harness(responder = () => ({ ok: true, value: fixture() })) {
  let plugin, registrant, styleCount = 0, cursor = 0, effectQueued = false;
  const hooks = [], calls = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(work) { if (!effectQueued) { effectQueued = true; work(); } },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(spec) { assert.equal(spec.id, 'dsh-ghost'); plugin = spec.factory(name => { assert.equal(name, 'react'); return React; }); } } },
    document: { getElementById: () => styleCount ? {} : null, createElement: () => ({ dataset: {} }), head: { appendChild() { styleCount++; } } },
    console, setTimeout,
  });
  vm.runInContext(source, context);
  plugin.apply({
    slots: { inject(name, work) { assert.equal(name, 'settings.section'); return work(); }, register(options, render) { registrant = { options, render }; } },
    connection: { rpc: { async call(...args) { calls.push(args); return responder(...args); } } },
  });
  return {
    plugin, calls, registrant,
    render() { cursor = 0; const panel = registrant.render(); return panel.type(panel.props); },
    styles: () => styleCount,
  };
}

function walk(node, predicate, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node)) { for (const item of node) walk(item, predicate, output); return output; }
  if (predicate(node)) output.push(node);
  walk(node.props?.children, predicate, output);
  return output;
}
const text = node => !node ? '' : typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : typeof node.type === 'function' ? text(node.type(node.props)) : text(node.props?.children);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('registers the Ghost settings section and reads through the existing connection', async () => {
  const app = harness();
  assert.deepEqual(Array.from(app.plugin.inject), ['slots', 'connection']);
  assert.equal(app.registrant.options.id, 'ghost');
  assert.equal(app.registrant.options.order, 27);
  assert.equal(app.styles(), 1);
  app.render(); await settle();
  assert.deepEqual(app.calls[0].slice(0, 2), ['/ghost', 'status']);
  const panel = app.render();
  assert.match(text(panel), /检查点与恢复/);
  assert.match(text(panel), /UTF-8 字节/);
  const capture = walk(panel, node => node.props?.label === '记录后续可见消息')[0];
  assert.equal(capture.props.checked, false);
});

test('saves an explicit user change with the state version and retains version conflicts', async () => {
  const app = harness((_service, endpoint) => endpoint === 'configure'
    ? { ok: false, error: { code: 'VERSION_CONFLICT', message: 'conflict' } }
    : { ok: true, value: fixture() });
  app.render(); await settle();
  let panel = app.render();
  const name = walk(panel, node => node.type === 'input' && node.props?.maxLength === 64)[0];
  name.props.onChange({ target: { value: '新的名字' } });
  panel = app.render();
  const save = walk(panel, node => text(node) === '保存修改' && typeof node.props?.onClick === 'function')[0];
  assert.equal(save.props.disabled, false);
  await save.props.onClick(); await settle();
  const call = app.calls.find(row => row[1] === 'configure');
  assert.equal(call[2].expectedVersion, 4);
  assert.equal(call[2].patch.name, '新的名字');
  panel = app.render();
  assert.match(text(panel), /其他窗口更新/);
  assert.equal(walk(panel, node => node.type === 'input' && node.props?.maxLength === 64)[0].props.value, '新的名字');
});

test('read-only diagnostics disable editing and checkpoint writes', async () => {
  const state = fixture(); state.health = { ok: false, readOnly: true, error: 'checkpoint hash mismatch' };
  const app = harness(() => ({ ok: true, value: state }));
  app.render(); await settle();
  const panel = app.render();
  assert.match(text(panel), /只读诊断/);
  assert.match(text(panel), /checkpoint hash mismatch/);
  assert.ok(walk(panel, node => node.type === 'textarea').every(node => node.props.disabled));
  const checkpoint = walk(panel, node => text(node) === '创建检查点' && typeof node.props?.onClick === 'function')[0];
  assert.equal(checkpoint.props.disabled, true);
});

test('verification refresh does not silently rebase a dirty draft onto a newer version', async () => {
  let reads = 0;
  const app = harness((_service, endpoint) => {
    if (endpoint === 'verify') return { ok: true, value: { ok: true } };
    if (endpoint === 'configure') return { ok: false, error: { code: 'VERSION_CONFLICT', message: 'conflict' } };
    const state = fixture(); state.version = ++reads === 1 ? 4 : 5;
    return { ok: true, value: state };
  });
  app.render(); await settle();
  let panel = app.render();
  walk(panel, node => node.type === 'input' && node.props?.maxLength === 64)[0].props.onChange({ target: { value: '保留草稿' } });
  panel = app.render();
  await walk(panel, node => text(node) === '校验状态' && typeof node.props?.onClick === 'function')[0].props.onClick();
  panel = app.render();
  await walk(panel, node => text(node) === '保存修改' && typeof node.props?.onClick === 'function')[0].props.onClick();
  assert.equal(app.calls.find(row => row[1] === 'configure')[2].expectedVersion, 4);
});

test('an RPC failure is visible and does not invent an operational state', async () => {
  const app = harness(() => ({ ok: false, error: { code: 'NOT_READY', message: 'runtime unavailable' } }));
  app.render(); await settle();
  const panel = app.render();
  assert.match(text(panel), /runtime unavailable/);
  assert.doesNotMatch(text(panel), /本地运行/);
  assert.match(text(panel), /重新连接/);
});
