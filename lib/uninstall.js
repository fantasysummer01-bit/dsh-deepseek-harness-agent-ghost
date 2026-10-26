import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PENDING_FILE, OWNED_FILES, assertPlainPath, fingerprint, inspectGhostDatabase,
  validateUninstallPaths, validateJob } from '../scripts/uninstall-worker.mjs';

export const CONFIRMATION_TEXT = 'UNINSTALL GHOST';
const TTL = 5 * 60 * 1000;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(condition, code, message) { if (!condition) fail(code, message); }
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readUninstallPending(dataDir) {
  const marker = path.join(path.resolve(dataDir), PENDING_FILE);
  // existsSync follows links and treats a dangling marker as absent. A marker
  // entry of any kind must instead be validated before Ghost can open a store.
  try { fs.lstatSync(marker); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assertPlainPath(marker, { directory: false });
  const job = JSON.parse(fs.readFileSync(marker, 'utf8'));
  check(job?.schemaVersion === 1 && job.packageName === 'dsh-ghost', 'INVALID_JOB', 'Uninstall marker is invalid');
  check(typeof job.dataDir === 'string' && path.resolve(job.dataDir).toLowerCase() === fs.realpathSync(path.dirname(marker)).toLowerCase(),
    'INVALID_JOB', 'Uninstall marker points to another data directory');
  return job;
}

function launchIsolatedWorker(job) {
  const directory = assertPlainPath(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ghost-uninstall-')));
  const worker = path.join(directory, 'worker.mjs');
  fs.copyFileSync(fileURLToPath(new URL('../scripts/uninstall-worker.mjs', import.meta.url)), worker);
  fs.writeFileSync(path.join(directory, 'job.json'), JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  const child = spawn(job.desktopExecutable, ['--expose-internals', worker, path.join(directory, 'job.json')], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: job.dshHome },
  });
  // Spawn failures are reported to the caller before successful queuing is shown.
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve({ helperDirectory: directory, helperPid: child.pid }); });
  });
}

export function createUninstaller({ dataDir, dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  desktopExecutable = process.execPath, getState, stopGhost, launchWorker = launchIsolatedWorker,
  now = Date.now } = {}) {
  check(typeof getState === 'function' && typeof stopGhost === 'function', 'INVALID_OPTIONS', 'Ghost state and shutdown callbacks are required');
  const options = { dataDir: path.resolve(dataDir), dshHome: path.resolve(dshHome), sourceRoot,
    profileDir: path.join(path.resolve(dshHome), 'profiles', 'desktop'), desktopExecutable: path.resolve(desktopExecutable),
    desktopCliEntry: path.join(path.dirname(path.resolve(desktopExecutable)), 'resources', 'app.asar',
      'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js') };
  let currentPlan = null;
  let currentPending = readUninstallPending(options.dataDir);
  if (currentPending) {
    check(currentPending.dshHome === assertPlainPath(options.dshHome)
      && currentPending.desktopExecutable === assertPlainPath(options.desktopExecutable, { directory: false }),
    'INVALID_JOB', 'Uninstall marker belongs to another host installation');
  }

  function snapshot() {
    const locations = validateUninstallPaths(options);
    assertPlainPath(options.desktopExecutable, { directory: false });
    check(path.basename(options.desktopExecutable).toLowerCase() === 'deepseek harness.exe'
      && fs.existsSync(options.desktopCliEntry), 'UNSUPPORTED_HOST', 'Complete uninstall currently supports the Desktop host only');
    const state = getState();
    const database = inspectGhostDatabase(options.dataDir);
    check(state.ghostId === database.ghostId && state.branchId === database.branchId
      && state.version === database.version, 'STATE_CHANGED', 'Ghost state changed; refresh before uninstalling');
    const manifestFile = path.join(options.profileDir, 'package.json');
    assertPlainPath(manifestFile, { directory: false });
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    check(manifest.dependencies?.['dsh-ghost'] || manifest.devDependencies?.['dsh-ghost']
      || manifest.optionalDependencies?.['dsh-ghost'], 'NOT_INSTALLED', 'Ghost is not installed in this Desktop profile');
    const patchFile = path.join(options.profileDir, 'cordis.patch.yml');
    if (fs.existsSync(patchFile)) {
      assertPlainPath(patchFile, { directory: false });
      check(!/^\s*(?:-\s*)?(?:id|name):\s*["']?dsh-ghost(?:["']?\s*)$/m.test(fs.readFileSync(patchFile, 'utf8')),
        'MANUAL_REGISTRATION', 'Remove a manual Ghost patch entry before using complete uninstall');
    }
    return { ...options, ...locations, desktopExecutable: assertPlainPath(options.desktopExecutable, { directory: false }),
      ...database, dataFingerprint: fingerprint(options.dataDir), profileFingerprint: fingerprint(options.profileDir),
      eventCount: state.counts?.events || 0 };
  }

  const retained = ['DSH 聊天、模型配置与其他插件', '插件源码和 GitHub 仓库', '手动导出、复制到其他位置的备份或其他 profile 中的安装',
    '系统临时目录中的空共享写入锁文件（不含记忆内容）'];
  function describe() {
    if (currentPending) return { available: true, pending: true, requiresDshExit: true, jobId: currentPending.jobId,
      dataDir: currentPending.dataDir, retained };
    try { snapshot(); return { available: true, pending: false, requiresDshExit: true, retained }; }
    catch (error) { return { available: false, pending: false, reason: error.message, code: error.code || 'UNINSTALL_UNAVAILABLE' }; }
  }

  function plan() {
    check(!currentPending, 'UNINSTALL_PENDING', 'Ghost uninstall is already pending');
    const state = snapshot();
    currentPlan = { ...state, planId: randomUUID(), expiresAt: now() + TTL };
    return { planId: currentPlan.planId, expiresAt: new Date(currentPlan.expiresAt).toISOString(),
      ghostId: state.ghostId, stateVersion: state.version, eventCount: state.eventCount,
      requiresDshExit: true, dataDir: state.dataDir, profileDir: state.profileDir,
      deleteFiles: OWNED_FILES.map(file => path.join(state.dataDir, file)), retained,
      confirmationText: CONFIRMATION_TEXT };
  }

  async function resume() {
    check(currentPending, 'NO_PENDING_UNINSTALL', 'There is no pending uninstall');
    validateJob(currentPending);
    await stopGhost();
    try { return { pending: true, requiresDshExit: true, jobId: currentPending.jobId, ...await launchWorker(currentPending) }; }
    catch (error) { return { pending: true, requiresDshExit: true, jobId: currentPending.jobId,
      launchError: error.message || 'Could not start the isolated uninstall helper' }; }
  }

  async function confirm(payload) {
    check(!currentPending, 'UNINSTALL_PENDING', 'Ghost uninstall is already pending');
    check(currentPlan && payload?.planId === currentPlan.planId && now() < currentPlan.expiresAt,
      'PLAN_EXPIRED', 'Uninstall plan expired; review a new plan');
    check(payload.confirmation === CONFIRMATION_TEXT && payload.eraseData === true,
      'CONFIRMATION_REQUIRED', 'Type UNINSTALL GHOST and explicitly approve memory deletion');
    check(payload.expectedVersion === currentPlan.version, 'STATE_CHANGED', 'Ghost state changed; review a new plan');
    const current = snapshot();
    check(current.version === currentPlan.version && current.ghostId === currentPlan.ghostId
      && current.branchId === currentPlan.branchId
      && JSON.stringify(current.dataFingerprint) === JSON.stringify(currentPlan.dataFingerprint)
      && JSON.stringify(current.databaseFingerprint) === JSON.stringify(currentPlan.databaseFingerprint),
    'STATE_CHANGED', 'Ghost state or data location changed; review a new plan');
    const job = { ...current, schemaVersion: 1, packageName: 'dsh-ghost', jobId: randomUUID(),
      approvedAt: new Date(now()).toISOString() };
    delete job.eventCount;
    const marker = path.join(options.dataDir, PENDING_FILE);
    const descriptor = fs.openSync(marker, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(job)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    currentPending = job;
    currentPlan = null;
    return resume();
  }

  return { describe, plan, confirm, resume, get pending() { return !!currentPending; } };
}
