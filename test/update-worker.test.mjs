import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateUpdateJob, runUpdateJob, updateFingerprint } from '../scripts/update-worker.mjs';

if (process.versions.electron) process.noAsar = true;
const digest = value => createHash('sha256').update(value).digest('hex');
const version = '0.6.0', sha = 'b'.repeat(40);
const pluginManifest = value => ({ name: 'dsh-ghost', version: value, type: 'module', main: 'lib/index.js',
  exports: { '.': './lib/index.js', './client': './lib/client.js', './core': './lib/core.js', './package.json': './package.json' },
  scripts: { test: 'node --test test/*.test.mjs', check: 'node --check lib/index.js', 'pack:local': 'node scripts/pack.mjs' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-connection'] } } });

function fixture(t) {
  const temporary = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temporary, 'ghost-update-worker-test-'));
  const dshHome = path.join(root, 'dsh'), profileDir = path.join(dshHome, 'profiles', 'desktop');
  const dataDir = path.join(dshHome, 'ghost'), sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(dshHome, 'plugin-updates', 'dsh-ghost'), jobId = randomUUID();
  const packageDir = path.join(cacheRoot, version + '-' + sha, 'package'), controlDir = path.join(cacheRoot, 'control', jobId);
  for (const directory of [profileDir, dataDir, sourceRoot, packageDir, controlDir, path.join(profileDir, 'node_modules')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(pluginManifest('0.5.0')));
  fs.writeFileSync(path.join(sourceRoot, 'uncommitted-work.txt'), 'Do not overwrite this checkout');
  const expectedOldDependency = 'link:' + sourceRoot.replaceAll('\\', '/');
  const manifest = { name: 'fixture-desktop', private: true, dependencies: { 'dsh-ghost': expectedOldDependency, unrelated: 'link:unrelated' },
    dsh: { profile: { bundles: ['base', 'dsh-ghost', 'unrelated'] } } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), 'private_profile_configuration: preserve\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: unrelated\n');
  const link = path.join(profileDir, 'node_modules', 'dsh-ghost');
  fs.symlinkSync(sourceRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  const coreFiles = ['ghost.sqlite', 'ghost.sqlite-wal', 'ghost.sqlite-shm', 'ghost.sqlite-journal', 'ghost-core-export.json'];
  for (const filename of coreFiles) fs.writeFileSync(path.join(dataDir, filename), 'private core bytes: ' + filename);
  const hashes = () => Object.fromEntries(coreFiles.map(name => [name, digest(fs.readFileSync(path.join(dataDir, name)))]));
  const originalHashes = hashes();
  const desktopExecutable = path.join(root, 'Desktop', 'DeepSeek Harness.exe');
  const desktopCliEntry = path.join(path.dirname(desktopExecutable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  fs.mkdirSync(path.dirname(desktopCliEntry), { recursive: true });
  fs.writeFileSync(desktopExecutable, 'fixture, never executed'); fs.writeFileSync(desktopCliEntry, 'fixture CLI, never executed');
  const contents = {
    'package.json': JSON.stringify(pluginManifest(version)), 'cordis.patch.yml': '- insert:\n    - id: dsh-ghost\n      name: dsh-ghost\n',
    'lib/index.js': 'export function apply() {}\n', 'lib/client.js': '// fixture client\n', 'lib/core.js': '// fixture core code\n',
    'scripts/uninstall-worker.mjs': '// fixture uninstall helper\n', 'scripts/update-worker.mjs': '// fixture update helper\n',
  };
  for (const [name, value] of Object.entries(contents)) {
    const target = path.join(packageDir, ...name.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
  }
  const job = { schemaVersion: 1, packageName: 'dsh-ghost', jobId, version, commitSha: sha, currentVersion: '0.5.0',
    dshHome, profileDir, dataDir, sourceRoot, cacheRoot, packageDir, controlDir, desktopExecutable, desktopCliEntry,
    expectedOldDependency, profileFingerprint: updateFingerprint(profileDir),
    files: Object.keys(contents).map(name => ({ path: name, sha256: digest(fs.readFileSync(path.join(packageDir, ...name.split('/')))) })) };
  const add = (_job, directory) => {
    const profile = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    profile.dependencies['dsh-ghost'] = 'link:' + directory.replaceAll('\\', '/');
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profile));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    fs.unlinkSync(link); fs.symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  };
  t.after(() => {
    assert.equal(path.dirname(root), temporary); assert.ok(path.basename(root).startsWith('ghost-update-worker-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, job, add, link, hashes, originalHashes,
    profile: () => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')),
    rehash(name) { const row = job.files.find(file => file.path === name); row.sha256 = digest(fs.readFileSync(path.join(packageDir, ...name.split('/')))); },
    preserve() {
      assert.deepEqual(hashes(), originalHashes);
      assert.equal(fs.readFileSync(path.join(sourceRoot, 'uncommitted-work.txt'), 'utf8'), 'Do not overwrite this checkout');
    } };
}

test('worker waits for every Desktop process then switches only plugin code and preserves all core bytes', async t => {
  const f = fixture(t); let checks = 0, sleeps = 0, additions = 0;
  assert.deepEqual(validateUpdateJob(f.job), { alreadyInstalled: false });
  const result = await runUpdateJob(f.job, { isDesktopRunning: () => ++checks < 4, sleep: async () => { sleeps++; f.preserve(); },
    runAdd(job, directory) { assert.ok(checks >= 4); additions++; f.add(job, directory); } });
  assert.equal(result.completed, true); assert.equal(result.version, version); assert.equal(result.coreFilesPreserved, true);
  assert.equal(sleeps, 3); assert.equal(additions, 1);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.job.packageDir));
  assert.equal(f.profile().dependencies.unrelated, 'link:unrelated');
  assert.equal(fs.readFileSync(path.join(f.job.profileDir, 'cordis.yml'), 'utf8'), 'private_profile_configuration: preserve\n');
  f.preserve();
});

test('waiting timeout never invokes the CLI or changes the installed code', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => true, maxChecks: 2, sleep: async () => {}, runAdd() { calls++; } }), { code: 'UPDATE_WAIT_EXPIRED' });
  assert.equal(calls, 0); assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.job.sourceRoot));
  assert.equal(fs.existsSync(path.join(f.job.controlDir, 'backup')), false); f.preserve();
});

test('failure before changing the link keeps the old installation and exact profile bytes', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.job.profileDir, 'package.json'));
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd() { throw new Error('offline install failed'); } }), { code: 'UPDATE_INSTALL_FAILED' });
  assert.deepEqual(fs.readFileSync(path.join(f.job.profileDir, 'package.json')), before);
  assert.equal(f.profile().dependencies['dsh-ghost'], f.job.expectedOldDependency); f.preserve();
});

test('a partial package-manager failure restores the former code and profile without touching memory', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.job.profileDir, 'package.json')); let calls = 0;
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false,
    runAdd(job, directory) { calls++; f.add(job, directory); if (calls === 1) throw new Error('failed after relinking'); } }), { code: 'UPDATE_INSTALL_FAILED' });
  assert.equal(calls, 2); assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.job.sourceRoot));
  assert.deepEqual(fs.readFileSync(path.join(f.job.profileDir, 'package.json')), before); f.preserve();
});

test('a terminal same-job retry snapshots later user configuration before installing or rolling back', async t => {
  for (const failSecond of [false, true]) {
    const f = fixture(t);
    await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false,
      runAdd() { throw new Error('transient first attempt failure'); } }), { code: 'UPDATE_INSTALL_FAILED' });
    const backupDir = path.join(f.job.controlDir, 'backup');
    const prior = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    assert.equal(prior.terminalFailure, true);
    const userConfig = 'private_profile_configuration: user changed after failure\n';
    fs.writeFileSync(path.join(f.job.profileDir, 'cordis.yml'), userConfig);
    const profile = f.profile(); profile.dependencies.unrelated = 'link:user-new-plugin';
    profile.dsh.profile.bundles.push('user-added-bundle');
    fs.writeFileSync(path.join(f.job.profileDir, 'package.json'), JSON.stringify(profile));
    const latestProfile = fs.readFileSync(path.join(f.job.profileDir, 'package.json'));
    let calls = 0;
    const retry = runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd(job, directory) {
      f.add(job, directory); if (++calls === 1 && failSecond) throw new Error('second attempt failed after relinking');
    } });
    if (failSecond) {
      await assert.rejects(retry, { code: 'UPDATE_INSTALL_FAILED' });
      assert.deepEqual(fs.readFileSync(path.join(f.job.profileDir, 'package.json')), latestProfile);
      assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.job.sourceRoot));
    } else {
      assert.equal((await retry).completed, true);
      assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.job.packageDir));
    }
    assert.equal(fs.readFileSync(path.join(f.job.profileDir, 'cordis.yml'), 'utf8'), userConfig);
    assert.equal(f.profile().dependencies.unrelated, 'link:user-new-plugin');
    assert.ok(f.profile().dsh.profile.bundles.includes('user-added-bundle'));
    assert.equal(fs.readFileSync(path.join(backupDir, 'cordis.yml'), 'utf8'), userConfig);
    assert.equal(fs.readdirSync(f.job.controlDir).filter(name => name.startsWith('backup-failed-')).length, 1);
    f.preserve();
  }
});

test('an interrupted attempt validates its original snapshot before reporting success or retrying its code switch', async t => {
  for (const linkAlreadySwitched of [false, true]) {
    const f = fixture(t);
    await runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd: f.add });
  // The code link and backup, with no result file, are also the state left by
  // a process exiting immediately after add and before its preservation check.
    assert.equal(fs.existsSync(path.join(f.job.controlDir, 'result.json')), false);
    if (!linkAlreadySwitched) f.add(f.job, f.job.sourceRoot);
    const recordFile = path.join(f.job.controlDir, 'backup', 'manifest.json');
    const originalRecord = fs.readFileSync(recordFile);
    const changedConfig = 'private_profile_configuration: changed during interrupted install\n';
    fs.writeFileSync(path.join(f.job.profileDir, 'cordis.yml'), changedConfig);
    let calls = 0;
    await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false,
      runAdd() { calls++; } }), { code: 'UPDATE_CONFIG_CHANGED' });
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(recordFile), originalRecord);
    assert.equal(fs.readFileSync(path.join(f.job.profileDir, 'cordis.yml'), 'utf8'), changedConfig);
    assert.equal(fs.readdirSync(f.job.controlDir).filter(name => name.startsWith('backup-failed-')).length, 0);
    f.preserve();
  }
});

test('a pre-CLI host restart retires only a confirmed unchanged snapshot and retries from current settings', async t => {
  const f = fixture(t); let checks = 0, calls = 0;
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => ++checks > 1,
    runAdd() { calls++; } }), { code: 'HOST_RESTARTED' });
  assert.equal(calls, 0);
  const userConfig = 'private_profile_configuration: later user setting\n';
  fs.writeFileSync(path.join(f.job.profileDir, 'cordis.yml'), userConfig);
  const result = await runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd: f.add });
  assert.equal(result.completed, true);
  assert.equal(fs.readFileSync(path.join(f.job.profileDir, 'cordis.yml'), 'utf8'), userConfig);
  assert.equal(fs.readdirSync(f.job.controlDir).filter(name => name.startsWith('backup-failed-')).length, 1);
  f.preserve();
});

test('an incomplete successful CLI response is not reported as installed', async t => {
  const f = fixture(t);
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd() {} }), { code: 'UPDATE_INSTALL_INCOMPLETE' });
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(f.job.sourceRoot)); f.preserve();
});

test('a CLI config change is refused and rolled back rather than changing Ghost data routing', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd(job, directory) {
    calls++; f.add(job, directory);
    if (calls === 1) fs.writeFileSync(path.join(job.profileDir, 'cordis.yml'), 'dataDir: unexpected\n');
  } }), { code: 'UPDATE_CONFIG_CHANGED' });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(f.job.profileDir, 'cordis.yml'), 'utf8'), 'private_profile_configuration: preserve\n');
  f.preserve();
});

test('rollback failure stays an explicit failure and never deletes either code version or core records', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd(job, directory) {
    calls++; if (calls === 1) f.add(job, directory); throw new Error('failed');
  } }), { code: 'UPDATE_ROLLBACK_FAILED' });
  assert.equal(fs.existsSync(f.job.packageDir), true); assert.equal(fs.existsSync(f.job.sourceRoot), true); f.preserve();
});

test('already installed verified code is idempotent and does not rerun package management', async t => {
  const f = fixture(t); f.add(f.job, f.job.packageDir);
  const result = await runUpdateJob(f.job, { isDesktopRunning() { throw new Error('not needed'); }, runAdd() { throw new Error('not needed'); } });
  assert.equal(result.completed, true); assert.equal(result.alreadyInstalled, true); f.preserve();
});

test('changed code, extra files and missing code fail before installation', async t => {
  for (const change of ['tamper', 'extra', 'empty-directory', 'missing']) {
    const f = fixture(t); let calls = 0;
    if (change === 'tamper') fs.appendFileSync(path.join(f.job.packageDir, 'lib', 'core.js'), '// changed');
    else if (change === 'extra') fs.writeFileSync(path.join(f.job.packageDir, 'ghost.sqlite'), 'not code');
    else if (change === 'empty-directory') fs.mkdirSync(path.join(f.job.packageDir, '.dsh'));
    else fs.unlinkSync(path.join(f.job.packageDir, 'lib', 'core.js'));
    await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => false, runAdd() { calls++; } }), error => ['UPDATE_HASH_MISMATCH', 'INVALID_UPDATE_PACKAGE'].includes(error.code));
    assert.equal(calls, 0); f.preserve();
  }
});

test('installation hooks, dependencies, exports and host-config changes are rejected even after cache rehash', t => {
  for (const mutate of [pkg => { pkg.scripts.prepare = 'run downloaded code'; }, pkg => { pkg.dependencies = { malicious: '1.0.0' }; },
    pkg => { pkg.exports['.'] = './unexpected.js'; }, pkg => { pkg.dsh.bundle.dataDir = 'unexpected'; }]) {
    const f = fixture(t), filename = path.join(f.job.packageDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(filename, 'utf8')); mutate(pkg); fs.writeFileSync(filename, JSON.stringify(pkg)); f.rehash('package.json');
    assert.throws(() => validateUpdateJob(f.job), { code: 'INVALID_UPDATE_PACKAGE' }); f.preserve();
  }
});

test('data, source, case-colliding and reserved paths cannot be selected as update destinations', t => {
  const f = fixture(t);
  assert.throws(() => validateUpdateJob({ ...f.job, dataDir: f.job.cacheRoot }), { code: 'UNSAFE_UPDATE_PATH' });
  assert.throws(() => validateUpdateJob({ ...f.job, sourceRoot: f.job.packageDir }), { code: 'UNSAFE_UPDATE_PATH' });
  for (const bad of ['../ghost.sqlite', 'lib/con.js', 'lib/unsafe./index.js', 'lib/core.js ', 'lib/data/private.js']) {
    assert.throws(() => validateUpdateJob({ ...f.job, files: [...f.job.files, { path: bad, sha256: '0'.repeat(64) }] }), { code: 'INVALID_UPDATE_PACKAGE' });
  }
  assert.throws(() => validateUpdateJob({ ...f.job, files: [...f.job.files, { path: 'LIB/CORE.JS', sha256: '0'.repeat(64) }] }), { code: 'INVALID_UPDATE_PACKAGE' });
  f.preserve();
});

test('a replaced profile or a substituted source link is refused', async t => {
  const f = fixture(t);
  await assert.rejects(runUpdateJob({ ...f.job, profileFingerprint: { dev: 'wrong', ino: 'wrong' } }, { isDesktopRunning: () => false, runAdd() { throw new Error('not called'); } }), { code: 'UPDATE_TARGET_CHANGED' });
  const changed = f.profile(); changed.dependencies['dsh-ghost'] = 'link:different';
  fs.writeFileSync(path.join(f.job.profileDir, 'package.json'), JSON.stringify(changed));
  assert.throws(() => validateUpdateJob(f.job), { code: 'UPDATE_TARGET_CHANGED' }); f.preserve();
});

test('code mutation while waiting is revalidated before the CLI runs', async t => {
  const f = fixture(t); let checks = 0, calls = 0;
  await assert.rejects(runUpdateJob(f.job, { isDesktopRunning: () => ++checks === 1, sleep: async () => {
    fs.appendFileSync(path.join(f.job.packageDir, 'lib', 'index.js'), '// changed while waiting');
  }, runAdd() { calls++; } }), { code: 'UPDATE_HASH_MISMATCH' });
  assert.equal(calls, 0); f.preserve();
});

test('an isolated helper records pre-install validation failures in the code control directory', t => {
  const f = fixture(t), temporary = fs.realpathSync(os.tmpdir());
  const helper = fs.mkdtempSync(path.join(temporary, 'dsh-ghost-update-test-'));
  const script = path.join(helper, 'worker.mjs'), jobFile = path.join(f.job.controlDir, 'job.json');
  fs.copyFileSync(new URL('../scripts/update-worker.mjs', import.meta.url), script);
  fs.writeFileSync(jobFile, JSON.stringify({ ...f.job, jobFile }));
  // Fail before process checks or any package-manager child could be started.
  fs.appendFileSync(path.join(f.job.packageDir, 'lib', 'core.js'), '// invalidated');
  const result = spawnSync(process.execPath, ['--expose-internals', script, jobFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(result.status, 1);
  const outcome = JSON.parse(fs.readFileSync(path.join(f.job.controlDir, 'result.json'), 'utf8'));
  assert.equal(outcome.completed, false);
  assert.ok(['UPDATE_HASH_MISMATCH', 'UNSUPPORTED_HOST'].includes(outcome.code), outcome.code);
  f.preserve();
  if (fs.existsSync(helper)) {
    assert.equal(path.dirname(helper), temporary); assert.ok(path.basename(helper).startsWith('dsh-ghost-update-test-'));
    fs.rmSync(helper, { recursive: true, force: true });
  }
});
