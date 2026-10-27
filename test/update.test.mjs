import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUpdater } from '../lib/update.js';

if (process.versions.electron) process.noAsar = true;
const digest = value => createHash('sha256').update(value).digest('hex');
const SHA = 'a'.repeat(40);
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-code-update-test-'));
  const dataDir = path.join(root, 'memory'), dshHome = path.join(root, 'dsh'), sourceRoot = path.join(root, 'source');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(sourceRoot); fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  manifest.version = '1.0.0';
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(sourceRoot, 'uncommitted.txt'), 'Keep this local edit.');
  fs.symlinkSync(sourceRoot, path.join(profileDir, 'node_modules', 'dsh-ghost'), process.platform === 'win32' ? 'junction' : 'dir');
  const profile = { name: 'fixture-desktop', private: true,
    dependencies: { 'dsh-ghost': 'link:' + sourceRoot, unrelated: '1.0.0' },
    dsh: { profile: { bundles: ['dsh-ghost', 'unrelated'] } } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profile));
  const executable = path.join(root, 'Desktop', 'DeepSeek Harness.exe');
  const cliEntry = path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  fs.mkdirSync(path.dirname(cliEntry), { recursive: true }); fs.writeFileSync(executable, 'not executed'); fs.writeFileSync(cliEntry, '// not executed');
  for (const name of ['ghost.sqlite', 'ghost.sqlite-wal', 'ghost.sqlite-shm', 'ghost.sqlite-journal', 'custom-core.json']) {
    fs.writeFileSync(path.join(dataDir, name), 'PRIVATE CORE SENTINEL ' + name);
  }
  const target = { ...manifest, version: '1.1.0' };
  const downloaded = [
    { path: 'package.json', bytes: Buffer.from(JSON.stringify(target)) },
    { path: 'cordis.patch.yml', bytes: Buffer.from('- insert:\n    - id: dsh-ghost\n      name: dsh-ghost\n') },
    { path: 'README.md', bytes: Buffer.from('Ghost fixture') },
    ...['lib/index.js', 'lib/client.js', 'lib/core.js', 'scripts/uninstall-worker.mjs', 'scripts/update-worker.mjs']
      .map(name => ({ path: name, bytes: Buffer.from('// verified fixture only') })),
  ];
  let checks = 0, downloads = 0, launches = 0, job;
  const options = { dataDir, dshHome, sourceRoot, desktopExecutable: executable, currentVersion: '1.0.0',
    checkSource: async () => { checks++; return { available: true, currentVersion: '1.0.0', latestVersion: '1.1.0', commitSha: SHA }; },
    downloadSource: async () => { downloads++; return downloaded; },
    launchWorker: async value => { launches++; job = value; }, ...overrides };
  const updater = createUpdater(options);
  t.after(async () => {
    await updater.dispose();
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('ghost-code-update-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const core = () => Object.fromEntries(fs.readdirSync(dataDir).map(name => [name, digest(fs.readFileSync(path.join(dataDir, name)))]));
  return { root, dataDir, profileDir, sourceRoot, dshHome, downloaded, options, updater, core,
    get checks() { return checks; }, get downloads() { return downloads; }, get launches() { return launches; }, get job() { return job; } };
}

test('checking the current version never opens, changes or clears core records', async t => {
  const f = fixture(t, { checkSource: async () => ({ available: false, latestVersion: '1.0.0' }) });
  const before = f.core(), profile = fs.readFileSync(path.join(f.profileDir, 'package.json'));
  const read = fs.readFileSync;
  fs.readFileSync = (filename, ...args) => {
    assert.ok(!path.resolve(String(filename)).startsWith(f.dataDir + path.sep), 'updater attempted to read a core file');
    return read(filename, ...args);
  };
  let result;
  try { result = await f.updater.update(); } finally { fs.readFileSync = read; }
  assert.equal(result.phase, 'up_to_date'); assert.equal(f.downloads, 0); assert.equal(f.launches, 0);
  assert.deepEqual(f.core(), before); assert.deepEqual(fs.readFileSync(path.join(f.profileDir, 'package.json')), profile);
});

test('a newer version is staged separately and queued without modifying core, source or profile', async t => {
  const f = fixture(t), core = f.core(), profile = fs.readFileSync(path.join(f.profileDir, 'package.json'));
  const result = await f.updater.update();
  assert.equal(result.phase, 'pending'); assert.equal(result.requiresDshExit, true);
  assert.equal(f.launches, 1); assert.equal(f.checks, 1); assert.equal(f.downloads, 1);
  assert.equal(f.job.packageDir, path.join(f.dshHome, 'plugin-updates', 'dsh-ghost', '1.1.0-' + SHA, 'package'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.job.packageDir, 'package.json'))).version, '1.1.0');
  assert.deepEqual(f.core(), core); assert.deepEqual(fs.readFileSync(path.join(f.profileDir, 'package.json')), profile);
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, 'uncommitted.txt'), 'utf8'), 'Keep this local edit.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.sourceRoot, 'package.json'))).version, '1.0.0');
  assert.equal(f.updater.pending, true);
  await f.updater.update(); assert.equal(f.launches, 1); assert.equal(f.downloads, 1);
});

test('concurrent clicks share one check and one installation job', async t => {
  let release, checks = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { checkSource: async () => { checks++; await gate; return { available: true, latestVersion: '1.1.0', commitSha: SHA }; } });
  const first = f.updater.update(), second = f.updater.update();
  assert.equal(first, second); assert.equal(f.updater.pending, true);
  release(); assert.equal((await first).phase, 'pending'); await second;
  assert.equal(checks, 1); assert.equal(f.launches, 1);
});

test('a queued uninstall or protected-directory overlap cannot start an update', async t => {
  const f = fixture(t, { getBlocked: () => true });
  const before = f.core();
  assert.equal((await f.updater.update()).code, 'UNINSTALL_PENDING'); assert.equal(f.checks, 0);
  const unsafe = createUpdater({ ...f.options, dataDir: f.dshHome, getBlocked: () => false });
  assert.equal((await unsafe.update()).code, 'UPDATE_UNSAFE_PATH'); await unsafe.dispose();
  assert.deepEqual(f.core(), before); assert.equal(f.launches, 0);
});

test('network and unsafe-package failures never become success or launch an installer', async t => {
  const f = fixture(t, { checkSource: async () => { throw Object.assign(new Error('GitHub unavailable'), { code: 'UPDATE_NETWORK_ERROR' }); } });
  const before = f.core();
  assert.equal((await f.updater.update()).phase, 'error'); assert.equal(f.updater.describe().code, 'UPDATE_NETWORK_ERROR');
  const bad = createUpdater({ ...f.options, checkSource: async () => ({ available: true, latestVersion: '1.1.0', commitSha: SHA }),
    downloadSource: async () => [...f.downloaded, { path: '../ghost.sqlite', bytes: Buffer.from('bad') }] });
  assert.equal((await bad.update()).phase, 'error'); await bad.dispose();
  assert.equal(f.launches, 0); assert.deepEqual(f.core(), before);
});

test('persisted pending updates resume without network or core changes; tampered code is refused', async t => {
  const f = fixture(t), before = f.core(); await f.updater.update();
  let retries = 0;
  const restored = createUpdater({ ...f.options, checkSource() { throw new Error('must not fetch again'); },
    launchWorker: async () => { retries++; } });
  assert.equal(restored.describe().phase, 'pending');
  assert.equal((await restored.resume()).phase, 'pending'); assert.equal(retries, 1);
  fs.writeFileSync(path.join(f.job.packageDir, 'lib', 'index.js'), '// changed after verification');
  const result = await restored.resume(); assert.equal(result.phase, 'error');
  assert.equal(retries, 1); assert.deepEqual(f.core(), before); await restored.dispose();
});

test('helper launch failure is visible and an explicit retry reuses the verified code only', async t => {
  let attempts = 0; const jobs = [];
  const f = fixture(t, { launchWorker: async job => { jobs.push(job); if (++attempts === 1) throw new Error('helper failed'); } });
  const before = f.core(); assert.equal((await f.updater.update()).phase, 'error');
  assert.match(f.updater.describe().error, /helper failed/);
  fs.writeFileSync(path.join(f.profileDir, 'cordis.yml'), '# user changed configuration after failure');
  assert.equal((await f.updater.update()).phase, 'pending'); assert.equal(attempts, 2);
  assert.notEqual(jobs[0].controlDir, jobs[1].controlDir);
  assert.equal(jobs[0].packageDir, jobs[1].packageDir);
  assert.equal(fs.readFileSync(path.join(f.profileDir, 'cordis.yml'), 'utf8'), '# user changed configuration after failure');
  assert.equal(f.downloads, 1); assert.deepEqual(f.core(), before);
});

test('installed metadata cannot cause a downgrade, remain pending or pretend a fresh GitHub check', async t => {
  const f = fixture(t); await f.updater.update();
  const installed = createUpdater({ ...f.options, currentVersion: '1.1.0' });
  assert.equal(installed.describe().phase, 'idle'); assert.equal(installed.pending, false);
  await installed.dispose();
});

test('a failed rollback remains an error even when the new package version is already selected', async t => {
  const f = fixture(t); await f.updater.update();
  fs.writeFileSync(path.join(f.job.controlDir, 'result.json'), JSON.stringify({ completed: false,
    code: 'UPDATE_ROLLBACK_FAILED', error: 'Previous code could not be restored' }));
  const profileFile = path.join(f.profileDir, 'package.json');
  const profile = JSON.parse(fs.readFileSync(profileFile)); profile.dependencies['dsh-ghost'] = 'link:' + f.job.packageDir;
  fs.writeFileSync(profileFile, JSON.stringify(profile));
  fs.unlinkSync(path.join(f.profileDir, 'node_modules', 'dsh-ghost'));
  fs.symlinkSync(f.job.packageDir, path.join(f.profileDir, 'node_modules', 'dsh-ghost'), process.platform === 'win32' ? 'junction' : 'dir');
  const newer = createUpdater({ ...f.options, sourceRoot: f.job.packageDir, currentVersion: '1.1.0',
    checkSource() { throw new Error('Rollback failure must not be hidden by a new check'); } });
  assert.equal(newer.describe().phase, 'error'); assert.equal(newer.describe().code, 'UPDATE_ROLLBACK_FAILED');
  assert.equal((await newer.update()).code, 'UPDATE_ROLLBACK_FAILED'); await newer.dispose();
});

test('a malformed durable pointer fails closed without changing memory', async t => {
  const f = fixture(t), before = f.core(); await f.updater.update();
  fs.writeFileSync(path.join(f.dshHome, 'plugin-updates', 'dsh-ghost', 'pending.json'), '{invalid');
  const restored = createUpdater(f.options);
  assert.equal(restored.describe().phase, 'error'); assert.equal(restored.pending, true);
  assert.equal((await restored.update()).phase, 'error');
  assert.deepEqual(f.core(), before); await restored.dispose();
});
