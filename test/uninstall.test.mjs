import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GhostStore } from '../lib/core.js';
import { createUninstaller, readUninstallPending } from '../lib/uninstall.js';
import { runUninstallJob, PENDING_FILE, validateUninstallPaths } from '../scripts/uninstall-worker.mjs';

// These fixtures use a literal directory named app.asar, never a real archive.
// Keep Electron's archive interception out of this isolated test process only.
if (process.versions.electron) process.noAsar = true;

function fixture(t, { closeStore = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-uninstall-test-'));
  const dataDir = path.join(root, 'data');
  const dshHome = path.join(root, 'dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = { name: 'fixture-profile', dependencies: { 'dsh-ghost': 'link:fixture', 'unrelated-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['base', 'dsh-ghost', 'unrelated-plugin'] } } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n');
  fs.mkdirSync(path.join(dshHome, 'sessions')); fs.writeFileSync(path.join(dshHome, 'sessions', 'keep.txt'), 'private unrelated chat');
  const desktopExecutable = path.join(root, 'Desktop', 'DeepSeek Harness.exe');
  const entry = path.join(path.dirname(desktopExecutable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '// fake CLI; never executed');
  fs.writeFileSync(desktopExecutable, 'fake executable; never executed');
  const store = new GhostStore({ dataDir });
  store.configure({ settings: { enabled: true, captureEnabled: true } }, store.status().version);
  store.ingest({ eventId: 'erase-me', sessionId: 'only-this-ghost', role: 'user', text: 'Ghost memory fixture' });
  let clock = 1000000, launches = 0, stopped = 0, job;
  const options = { dataDir, dshHome, desktopExecutable, getState: () => store.status(),
    stopGhost: () => { stopped++; if (closeStore) store.close(); },
    launchWorker: value => { launches++; job = value; return { helperDirectory: path.join(root, 'fake-helper') }; },
    now: () => clock };
  const uninstaller = createUninstaller(options);
  const remove = () => {
    const next = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    delete next.dependencies['dsh-ghost']; next.dsh.profile.bundles = next.dsh.profile.bundles.filter(name => name !== 'dsh-ghost');
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(next));
  };
  const confirm = async () => {
    const plan = uninstaller.plan();
    return uninstaller.confirm({ planId: plan.planId, confirmation: 'UNINSTALL GHOST', eraseData: true, expectedVersion: plan.stateVersion });
  };
  t.after(() => {
    store.close();
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ghost-uninstall-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, dshHome, profileDir, desktopExecutable, store, options, uninstaller, confirm, remove,
    get launches() { return launches; }, get stopped() { return stopped; }, get job() { return job; },
    advance() { clock += 6 * 60 * 1000; } };
}

test('uninstall preview is read-only and accurately names local data and retained copies', t => {
  const f = fixture(t); const before = f.store.status();
  assert.equal(f.uninstaller.describe().available, true);
  const plan = f.uninstaller.plan();
  assert.equal(plan.requiresDshExit, true); assert.equal(plan.stateVersion, before.version);
  assert.equal(plan.dataDir, f.dataDir); assert.equal(plan.confirmationText, 'UNINSTALL GHOST');
  assert.ok(plan.deleteFiles.includes(path.join(f.dataDir, 'ghost.sqlite')));
  assert.ok(plan.retained.some(value => /GitHub/.test(value)));
  assert.equal(f.launches, 0); assert.equal(f.stopped, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, PENDING_FILE)), false);
  assert.deepEqual(f.store.status(), before);
});

test('confirmation phrase, deletion approval and non-expired plan are mandatory', async t => {
  const f = fixture(t); const plan = f.uninstaller.plan();
  const base = { planId: plan.planId, confirmation: 'UNINSTALL GHOST', eraseData: true, expectedVersion: plan.stateVersion };
  await assert.rejects(f.uninstaller.confirm({ ...base, confirmation: 'yes' }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(f.uninstaller.confirm({ ...base, eraseData: false }), { code: 'CONFIRMATION_REQUIRED' });
  f.advance();
  await assert.rejects(f.uninstaller.confirm(base), { code: 'PLAN_EXPIRED' });
  assert.equal(f.launches, 0); assert.equal(f.stopped, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, PENDING_FILE)), false);
});

test('a changed state invalidates an otherwise confirmed uninstall plan', async t => {
  const f = fixture(t); const plan = f.uninstaller.plan();
  f.store.ingest({ eventId: 'new-evidence', sessionId: 's', role: 'user', text: 'new memory after review' });
  await assert.rejects(f.uninstaller.confirm({ planId: plan.planId, confirmation: 'UNINSTALL GHOST', eraseData: true,
    expectedVersion: plan.stateVersion }), { code: 'STATE_CHANGED' });
  assert.equal(f.stopped, 0); assert.equal(f.launches, 0);
});

test('confirm stops only Ghost and queues a resumable worker without removing data', async t => {
  const f = fixture(t); const result = await f.confirm();
  assert.equal(result.pending, true); assert.equal(result.requiresDshExit, true);
  assert.equal(f.launches, 1); assert.equal(f.stopped, 1);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), true);
  const pending = readUninstallPending(f.dataDir);
  assert.equal(pending.jobId, result.jobId); assert.equal(pending.packageName, 'dsh-ghost');
  assert.equal(JSON.stringify(pending).includes('Ghost memory fixture'), false);
  await assert.rejects(f.uninstaller.confirm({}), { code: 'UNINSTALL_PENDING' });
  const resumed = createUninstaller({ ...f.options, getState: () => { throw new Error('closed'); } });
  assert.equal(resumed.describe().pending, true);
  await resumed.resume(); assert.equal(f.launches, 2);
});

test('worker waits for Desktop exit and removes only Ghost-owned files and registration', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'keep-user-file.txt'), 'keep unknown file');
  await f.confirm();
  let running = true, removeCalls = 0;
  const result = await runUninstallJob(f.job, {
    isDesktopRunning: () => running, maxChecks: 4,
    sleep() {
      assert.equal(removeCalls, 0); assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), true);
      running = false;
    },
    runRemove() { assert.equal(running, false); removeCalls++; f.remove(); },
  });
  assert.equal(result.completed, true); assert.equal(result.directoryRemoved, false); assert.equal(removeCalls, 1);
  assert.deepEqual(result.retainedFiles, ['keep-user-file.txt']);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), false);
  assert.equal(fs.readFileSync(path.join(f.dshHome, 'sessions', 'keep.txt'), 'utf8'), 'private unrelated chat');
  const profile = JSON.parse(fs.readFileSync(path.join(f.profileDir, 'package.json'), 'utf8'));
  assert.equal(profile.dependencies['unrelated-plugin'], '1.0.0');
  assert.deepEqual(profile.dsh.profile.bundles, ['base', 'unrelated-plugin']);
});

test('worker removes an empty Ghost directory without touching its sibling', async t => {
  const f = fixture(t); const sibling = path.join(f.root, 'sibling'); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'keep'), 'stay');
  await f.confirm();
  const result = await runUninstallJob(f.job, { isDesktopRunning: () => false, runRemove: f.remove });
  assert.equal(result.completed, true); assert.equal(result.directoryRemoved, true);
  assert.equal(fs.existsSync(f.dataDir), false); assert.equal(fs.readFileSync(path.join(sibling, 'keep'), 'utf8'), 'stay');
});

test('CLI failure or incomplete package removal never erases Ghost data', async t => {
  const f = fixture(t); await f.confirm();
  await assert.rejects(runUninstallJob(f.job, { isDesktopRunning: () => false,
    runRemove() { throw Object.assign(new Error('fake CLI failure'), { code: 'REMOVE_FAILED' }); } }), { code: 'REMOVE_FAILED' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), true);
  await assert.rejects(runUninstallJob(f.job, { isDesktopRunning: () => false, runRemove() {} }), { code: 'REMOVE_INCOMPLETE' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), true);
  assert.equal(fs.existsSync(path.join(f.dataDir, PENDING_FILE)), true);
});

test('active Ghost writer prevents the worker from touching registration or memory', async t => {
  const f = fixture(t, { closeStore: false }); await f.confirm(); let removed = false;
  await assert.rejects(runUninstallJob(f.job, { isDesktopRunning: () => false, runRemove() { removed = true; } }), { code: 'WRITER_CONFLICT' });
  assert.equal(removed, false); assert.equal(f.store.status().counts.events, 1);
});

test('already removed registration skips package manager and a leftover package link blocks data erasure', async t => {
  const f = fixture(t); await f.confirm(); f.remove();
  const modules = path.join(f.profileDir, 'node_modules'); fs.mkdirSync(modules);
  const leftover = path.join(modules, 'dsh-ghost'); fs.mkdirSync(leftover);
  let calls = 0;
  await assert.rejects(runUninstallJob(f.job, { isDesktopRunning: () => false, runRemove() { calls++; } }), { code: 'REMOVE_INCOMPLETE' });
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), true);
  fs.rmdirSync(leftover);
  const result = await runUninstallJob(f.job, { isDesktopRunning: () => false, runRemove() { calls++; } });
  assert.equal(result.completed, true); assert.equal(calls, 0);
});

test('an interrupted cleanup after database deletion can resume from its approved marker', async t => {
  const f = fixture(t); await f.confirm();
  await assert.rejects(runUninstallJob(f.job, { isDesktopRunning: () => false, runRemove: f.remove,
    removeFile(file) {
      if (path.basename(file) === PENDING_FILE) throw Object.assign(new Error('temporary marker lock'), { code: 'EPERM' });
      fs.unlinkSync(file);
    } }), { code: 'EPERM' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), false);
  assert.equal(readUninstallPending(f.dataDir).cleanupStarted, true);
  const result = await runUninstallJob(f.job, { isDesktopRunning: () => false,
    runRemove() { throw new Error('must not rerun remove for an absent package'); } });
  assert.equal(result.completed, true); assert.equal(fs.existsSync(f.dataDir), false);
});

test('data directory replacement after confirmation is refused', async t => {
  const f = fixture(t); await f.confirm();
  const original = path.join(f.root, 'original'); fs.renameSync(f.dataDir, original); fs.mkdirSync(f.dataDir);
  for (const name of ['ghost.sqlite', PENDING_FILE]) fs.copyFileSync(path.join(original, name), path.join(f.dataDir, name));
  await assert.rejects(runUninstallJob(f.job, { isDesktopRunning: () => false, runRemove: f.remove }), { code: 'TARGET_CHANGED' });
  assert.equal(fs.existsSync(path.join(original, 'ghost.sqlite')), true);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), true);
});

test('junction/symlink data paths and protected profile/home paths are rejected', t => {
  const f = fixture(t); const link = path.join(f.root, 'linked-data');
  fs.symlinkSync(f.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = createUninstaller({ ...f.options, dataDir: link });
  assert.equal(linked.describe().available, false); assert.equal(linked.describe().code, 'UNSAFE_PATH');
  assert.throws(() => validateUninstallPaths({ dataDir: f.dshHome, dshHome: f.dshHome, profileDir: f.profileDir }), { code: 'UNSAFE_PATH' });
  assert.throws(() => validateUninstallPaths({ dataDir: f.profileDir, dshHome: f.dshHome, profileDir: f.profileDir }), { code: 'UNSAFE_PATH' });
});

test('a dangling pending marker fails closed before launching or changing Ghost', t => {
  const f = fixture(t);
  assert.equal(readUninstallPending(f.dataDir), null);
  assert.equal(readUninstallPending(path.join(f.root, 'not-created')), null);
  const before = f.store.status();
  const marker = path.join(f.dataDir, PENDING_FILE);
  fs.symlinkSync(path.join(f.root, 'missing-marker-target'), marker,
    process.platform === 'win32' ? 'junction' : 'file');
  // Following the link says it is missing, but its directory entry exists.
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
  assert.throws(() => readUninstallPending(f.dataDir), { code: 'UNSAFE_PATH' });
  assert.throws(() => createUninstaller(f.options), { code: 'UNSAFE_PATH' });
  assert.equal(f.launches, 0); assert.equal(f.stopped, 0);
  assert.deepEqual(f.store.status(), before);
});

test('source-tree descendants are protected before any official removal or data deletion', async t => {
  const f = fixture(t);
  const sourceRoot = path.join(f.root, 'source');
  const nested = path.join(sourceRoot, 'nested', 'data');
  fs.mkdirSync(nested, { recursive: true });
  for (const dataDir of [sourceRoot, path.join(sourceRoot, 'nested'), nested]) {
    assert.throws(() => validateUninstallPaths({ dataDir, sourceRoot,
      dshHome: f.dshHome, profileDir: f.profileDir }), { code: 'UNSAFE_PATH' });
  }
  await f.confirm();
  const manifestBefore = fs.readFileSync(path.join(f.profileDir, 'package.json'), 'utf8');
  let calls = 0;
  await assert.rejects(runUninstallJob({ ...f.job, sourceRoot: f.root }, {
    isDesktopRunning: () => false, runRemove() { calls++; },
  }), { code: 'UNSAFE_PATH' });
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'ghost.sqlite')), true);
  assert.equal(fs.existsSync(path.join(f.dataDir, PENDING_FILE)), true);
  assert.equal(fs.readFileSync(path.join(f.profileDir, 'package.json'), 'utf8'), manifestBefore);
});
