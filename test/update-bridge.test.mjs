import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { apply } from '../lib/index.js';
import { invokeRoute } from '../scripts/testing/rpc-probe.mjs';

if (process.versions.electron) process.noAsar = true;
const SHA = 'b'.repeat(40);
function fixture(t, custom = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-update-bridge-'));
  const dataDir = path.join(root, 'data'), home = path.join(root, 'dsh'), profile = path.join(home, 'profiles', 'desktop'), source = path.join(root, 'source');
  fs.mkdirSync(source); fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')); pkg.version = '1.0.0';
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'fixture-desktop', private: true,
    dependencies: { 'dsh-ghost': 'link:' + source }, dsh: { profile: { bundles: ['dsh-ghost'] } } }));
  fs.symlinkSync(source, path.join(profile, 'node_modules', 'dsh-ghost'), process.platform === 'win32' ? 'junction' : 'dir');
  const executable = path.join(root, 'Desktop', 'DeepSeek Harness.exe');
  const cli = path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(executable, 'not executed'); fs.writeFileSync(cli, '// not executed');
  const downloaded = [
    { path: 'package.json', bytes: Buffer.from(JSON.stringify({ ...pkg, version: '1.1.0' })) },
    { path: 'cordis.patch.yml', bytes: Buffer.from('- insert:\n    - id: dsh-ghost\n      name: dsh-ghost\n') },
    { path: 'README.md', bytes: Buffer.from('fixture') },
    ...['lib/index.js', 'lib/core.js', 'lib/client.js', 'scripts/uninstall-worker.mjs', 'scripts/update-worker.mjs']
      .map(name => ({ path: name, bytes: Buffer.from('// fixture') })),
  ];
  let handler, cleanup, launches = 0, checks = 0;
  const ctx = { connection: { requestRejection() {} }, webServer: { register(value) { handler = value; return () => {}; } },
    on() { return () => {}; }, systemPrompt: { variable() { return () => {}; }, context() { return () => {}; } }, effect(work) { cleanup = work(); } };
  apply(ctx, { dataDir, dshHome: home, desktopExecutable: executable,
    updateOptions: { sourceRoot: source, currentVersion: '1.0.0',
      checkSource: async () => { checks++; return { available: true, latestVersion: '1.1.0', commitSha: SHA }; },
      downloadSource: async () => downloaded, launchWorker: async () => { launches++; }, ...custom } });
  t.after(async () => {
    await cleanup(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ghost-update-bridge-')); fs.rmSync(root, { recursive: true, force: true });
  });
  const bytes = () => Object.fromEntries(fs.readdirSync(dataDir).map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(dataDir, name))).digest('hex')]));
  return { call: (action, payload = {}) => invokeRoute(handler, action, payload), bytes,
    get checks() { return checks; }, get launches() { return launches; } };
}

test('native update action preserves actual Ghost records while a pending update blocks uninstall only', async t => {
  const f = fixture(t), initial = (await f.call('export')).value, bytes = f.bytes();
  const updated = await f.call('update'); assert.equal(updated.ok, true); assert.equal(updated.value.phase, 'pending');
  assert.equal(f.launches, 1); assert.deepEqual(f.bytes(), bytes);
  const after = (await f.call('export')).value;
  for (const key of ['state', 'events', 'ledger', 'checkpoints']) assert.deepEqual(after[key], initial[key]);
  assert.equal((await f.call('uninstallplan')).error.code, 'UPDATE_PENDING');
  assert.equal((await f.call('uninstallconfirm', {})).error.code, 'UPDATE_PENDING');
  const started = await f.call('start'); assert.equal(started.ok, true); assert.equal(started.value.running, true);
  assert.equal(started.value.ghostId, initial.state.ghostId);
  assert.equal((await f.call('stop')).ok, true); assert.equal((await f.call('export')).ok, true);
});

test('update cannot accept a browser-supplied URL or installation path', async t => {
  const f = fixture(t), before = f.bytes();
  const response = await f.call('update', { url: 'https://example.com/package', dataDir: 'C:/unrelated' });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_REQUEST');
  assert.equal(f.checks, 0); assert.equal(f.launches, 0); assert.deepEqual(f.bytes(), before);
});

test('uninstall cannot race an update that is still checking the network', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { checkSource: async () => { await gate; return { available: false, latestVersion: '1.0.0' }; } });
  const update = f.call('update');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.call('uninstallplan')).error.code, 'UPDATE_PENDING');
  release(); assert.equal((await update).value.phase, 'up_to_date');
  assert.equal((await f.call('uninstallplan')).ok, true);
});
