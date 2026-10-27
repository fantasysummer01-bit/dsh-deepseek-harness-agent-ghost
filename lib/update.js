import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLatest, fetchUpdateFiles, compareVersions, isUpdateCodePath,
  validateUpdateManifest, validateUpdatePatch } from './update-source.js';
import { assertPlainPath, fingerprint } from '../scripts/uninstall-worker.mjs';
import { validateUpdateJob } from '../scripts/update-worker.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const same = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(value, code, message) { if (!value) fail(code, message); }
function entryExists(filename) {
  try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function readJson(filename, optional = false) {
  if (optional && !entryExists(filename)) return null;
  assertPlainPath(filename, { directory: false });
  check(fs.statSync(filename).size <= 256 * 1024, 'UPDATE_INVALID_STATE', '更新状态文件过大');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function makeDirectory(directory) {
  if (!entryExists(directory)) { makeDirectory(path.dirname(directory)); fs.mkdirSync(directory); }
  return assertPlainPath(directory);
}
function atomicJson(filename, value) {
  if (entryExists(filename)) assertPlainPath(filename, { directory: false });
  const temporary = path.join(path.dirname(filename), '.' + path.basename(filename) + '.' + randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}
function listFiles(directory, prefix = '') {
  assertPlainPath(directory);
  const files = [];
  for (const name of fs.readdirSync(directory)) {
    const target = path.join(directory, name), stat = fs.lstatSync(target), relative = prefix + name;
    check(!stat.isSymbolicLink(), 'UPDATE_UNSAFE_PATH', '更新代码目录不能包含链接');
    if (stat.isDirectory()) files.push(...listFiles(target, relative + '/'));
    else { check(stat.isFile(), 'UPDATE_UNSAFE_PATH', '更新代码目录含非常规文件'); files.push(relative); }
  }
  return files.sort();
}
function verifyCode(directory, files) {
  check(JSON.stringify(listFiles(directory)) === JSON.stringify(files.map(file => file.path).sort()),
    'UPDATE_CACHE_CONFLICT', '更新缓存文件清单发生变化，请勿覆盖此目录');
  for (const file of files) {
    const target = path.join(directory, ...file.path.split('/'));
    assertPlainPath(target, { directory: false });
    check(sha256(fs.readFileSync(target)) === file.sha256, 'UPDATE_CACHE_CONFLICT', '更新缓存校验失败');
  }
}

async function launchIsolatedWorker(job) {
  const directory = assertPlainPath(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ghost-update-')));
  const worker = path.join(directory, 'worker.mjs');
  fs.copyFileSync(fileURLToPath(new URL('../scripts/update-worker.mjs', import.meta.url)), worker);
  const child = spawn(job.desktopExecutable, ['--expose-internals', worker, job.jobFile], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: job.dshHome },
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve({ helperDirectory: directory, helperPid: child.pid }); });
  });
}

/** Update code only. This module never opens a GhostStore or reads a core file. */
export function createUpdater({ dataDir, dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  sourceRoot = packageRoot, desktopExecutable = process.execPath,
  currentVersion = readJson(path.join(packageRoot, 'package.json')).version,
  checkSource = checkLatest, downloadSource = fetchUpdateFiles, launchWorker = launchIsolatedWorker,
  fetchImpl, getBlocked = () => false } = {}) {
  compareVersions(currentVersion, currentVersion);
  const home = path.resolve(dshHome), source = fs.realpathSync(sourceRoot);
  // Resolve the directory, never enumerate/read its memory files.
  const protectedData = entryExists(dataDir) ? fs.realpathSync(dataDir) : path.resolve(dataDir);
  const cacheRoot = path.join(home, 'plugin-updates', 'dsh-ghost');
  const profileDir = path.join(home, 'profiles', 'desktop');
  const executable = path.resolve(desktopExecutable);
  const cliEntry = path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const pointerFile = path.join(cacheRoot, 'pending.json');
  let state = { phase: 'idle', currentVersion }, disposed = false, active = null, controller = null, savedJob = null;

  function supported() {
    assertPlainPath(home); assertPlainPath(profileDir); assertPlainPath(source);
    assertPlainPath(executable, { directory: false });
    check(path.basename(executable).toLowerCase() === 'deepseek harness.exe' && fs.existsSync(cliEntry),
      'UPDATE_UNSUPPORTED_HOST', '当前宿主不支持自动更新，请使用 Desktop 插件');
    check(!overlaps(cacheRoot, protectedData) && !overlaps(profileDir, protectedData),
      'UPDATE_UNSAFE_PATH', '更新目录与核心记录目录重叠，已拒绝更新');
    check(!inside(source, cacheRoot), 'UPDATE_UNSAFE_PATH', '更新缓存不能写入当前插件源码目录');
    if (entryExists(cacheRoot)) assertPlainPath(cacheRoot);
    const manifest = readJson(path.join(profileDir, 'package.json'));
    const dependency = manifest.dependencies?.['dsh-ghost'];
    check(typeof dependency === 'string' && /^(?:link:|file:)/.test(dependency),
      'UPDATE_UNSUPPORTED_INSTALL', '此安装方式暂不支持安全自动更新');
    const oldPath = path.resolve(profileDir, dependency.slice(dependency.indexOf(':') + 1));
    check(same(fs.realpathSync(oldPath), source)
      && same(fs.realpathSync(path.join(profileDir, 'node_modules', 'dsh-ghost')), source),
    'UPDATE_INSTALL_CHANGED', 'Ghost 安装位置发生变化，请正常重启 DSH 后再检查更新');
    return { expectedOldDependency: dependency, profileFingerprint: fingerprint(profileDir) };
  }

  function loadPending() {
    const pointer = readJson(pointerFile, true);
    if (!pointer) return null;
    check(pointer.schemaVersion === 1 && /^[a-f0-9-]{36}$/.test(pointer.jobId), 'UPDATE_INVALID_STATE', '更新指针无效');
    const expected = path.join(cacheRoot, 'control', pointer.jobId, 'job.json');
    check(typeof pointer.jobFile === 'string' && same(pointer.jobFile, expected), 'UPDATE_INVALID_STATE', '更新指针超出代码缓存');
    const job = readJson(expected);
    check(job.schemaVersion === 1 && job.packageName === 'dsh-ghost' && job.jobId === pointer.jobId
      && same(job.cacheRoot, cacheRoot) && same(job.controlDir, path.dirname(expected)) && same(job.dataDir, protectedData)
      && same(job.dshHome, home) && same(job.profileDir, profileDir), 'UPDATE_INVALID_STATE', '更新任务不属于当前安装');
    compareVersions(job.version, currentVersion);
    const result = readJson(path.join(job.controlDir, 'result.json'), true);
    savedJob = job;
    // A failed rollback must stay visible even if the new package link was left
    // selected. Merely seeing its version is not evidence of a safe update.
    if (result?.completed === false) return { phase: 'error', currentVersion, latestVersion: job.version,
      error: String(result.error || '更新未完成，请重试'), code: result.code || 'UPDATE_FAILED', blocking: false };
    if (compareVersions(currentVersion, job.version) >= 0) return { phase: 'idle', currentVersion, installedVersion: job.version };
    if (result?.completed === true) {
      return { phase: compareVersions(currentVersion, job.version) >= 0 ? 'up_to_date' : 'pending', currentVersion,
        latestVersion: job.version, commitSha: job.commitSha, requiresDshExit: compareVersions(currentVersion, job.version) < 0 };
    }
    return { phase: 'pending', currentVersion, latestVersion: job.version, commitSha: job.commitSha, requiresDshExit: true };
  }

  function describe() {
    if (!active) {
      try {
        const durable = loadPending();
        // Installed metadata is not a new GitHub check. Keep a completed check
        // only within this live controller, and start idle after a restart.
        if (durable && !(durable.phase === 'idle' && state.phase === 'up_to_date')) state = durable;
      } catch (error) { state = { phase: 'error', currentVersion, error: error.message, code: error.code || 'UPDATE_INVALID_STATE', blocking: true }; }
    }
    return { ...state };
  }
  async function launch(job) {
    validateUpdateJob(job);
    const resultFile = path.join(job.controlDir, 'result.json');
    if (entryExists(resultFile)) { assertPlainPath(resultFile, { directory: false }); fs.unlinkSync(resultFile); }
    try {
      await launchWorker(job);
      state = { phase: 'pending', currentVersion, latestVersion: job.version, commitSha: job.commitSha, requiresDshExit: true };
    } catch (error) {
      atomicJson(resultFile, { completed: false, code: 'UPDATE_LAUNCH_FAILED', error: error.message });
      throw error;
    }
    return { ...state };
  }

  async function perform(signal, resumePending) {
    check(!disposed && !signal.aborted, 'CANCELLED', '更新请求已取消');
    check(!getBlocked(), 'UNINSTALL_PENDING', 'Ghost 正在卸载，不能同时更新');
    const installation = supported();
    makeDirectory(path.join(cacheRoot, 'control'));
    const leaseFile = path.join(cacheRoot, 'control', 'update-lease.sqlite');
    if (entryExists(leaseFile)) assertPlainPath(leaseFile, { directory: false });
    const lease = new DatabaseSync(leaseFile);
    try {
      try { lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
      catch { fail('UPDATE_BUSY', '另一个进程正在准备更新'); }
      const prior = loadPending();
      if (prior?.phase === 'pending') { state = prior; return resumePending ? await launch(savedJob) : { ...state }; }
      if (prior?.code === 'UPDATE_ROLLBACK_FAILED') { state = prior; return { ...state }; }
      // Failed, already-verified installations can be retried without a new
      // download. The worker rechecks the current profile and every code file.
      if (prior?.phase === 'error' && savedJob && compareVersions(savedJob.version, currentVersion) > 0) {
        // A fresh attempt must not reuse a snapshot from before the user's
        // subsequent configuration changes. Only immutable code is reused.
        const jobId = randomUUID(), controlDir = makeDirectory(path.join(cacheRoot, 'control', jobId));
        const retry = { ...savedJob, jobId, controlDir, jobFile: path.join(controlDir, 'job.json'),
          currentVersion, sourceRoot: source, ...installation };
        validateUpdateJob(retry);
        atomicJson(retry.jobFile, retry);
        atomicJson(pointerFile, { schemaVersion: 1, jobId, jobFile: retry.jobFile }); savedJob = retry;
        return await launch(retry);
      }
      state = { phase: 'checking', currentVersion };
      const latest = await checkSource({ currentVersion, fetchImpl, signal });
      check(!disposed && !signal.aborted && !getBlocked(), 'CANCELLED', '更新请求已取消');
      if (!latest.available) { state = { phase: 'up_to_date', currentVersion, latestVersion: latest.latestVersion }; return { ...state }; }
      check(compareVersions(latest.latestVersion, currentVersion) > 0 && /^[a-f0-9]{40}$/.test(latest.commitSha),
        'UPDATE_INVALID_VERSION', '更新版本或提交标识无效');
      state = { phase: 'checking', currentVersion, latestVersion: latest.latestVersion };
      const downloaded = await downloadSource({ commitSha: latest.commitSha, expectedVersion: latest.latestVersion, fetchImpl, signal });
      check(!disposed && !signal.aborted && !getBlocked(), 'CANCELLED', '更新请求已取消');
      check(Array.isArray(downloaded) && downloaded.length > 0 && downloaded.length <= 128, 'UPDATE_INVALID_PACKAGE', '更新清单无效');
      const names = new Set();
      const files = downloaded.map(file => {
        check(isUpdateCodePath(file.path) && Buffer.isBuffer(file.bytes) && file.bytes.length <= 1024 * 1024
          && !names.has(file.path.toLowerCase()), 'UPDATE_INVALID_PACKAGE', '更新包含重复或非代码文件');
        names.add(file.path.toLowerCase());
        return { path: file.path, sha256: sha256(file.bytes) };
      });
      check(['lib/index.js', 'lib/core.js', 'lib/client.js', 'scripts/uninstall-worker.mjs', 'scripts/update-worker.mjs']
        .every(name => names.has(name)), 'UPDATE_INVALID_PACKAGE', '更新缺少必要运行文件');
      check(downloaded.reduce((sum, file) => sum + file.bytes.length, 0) <= 8 * 1024 * 1024,
        'UPDATE_TOO_LARGE', '更新包过大');
      const pkg = downloaded.find(file => file.path === 'package.json'), patch = downloaded.find(file => file.path === 'cordis.patch.yml');
      check(pkg && patch, 'UPDATE_INVALID_PACKAGE', '更新缺少插件声明');
      validateUpdateManifest(JSON.parse(pkg.bytes.toString('utf8')), { expectedVersion: latest.latestVersion });
      validateUpdatePatch(patch.bytes.toString('utf8'));
      const jobId = randomUUID(), controlDir = makeDirectory(path.join(cacheRoot, 'control', jobId));
      const staging = makeDirectory(path.join(controlDir, 'staging', 'package'));
      for (const file of downloaded) {
        const target = path.join(staging, ...file.path.split('/'));
        check(inside(staging, target), 'UPDATE_UNSAFE_PATH', '下载路径超出代码目录');
        makeDirectory(path.dirname(target)); fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 });
      }
      verifyCode(staging, files);
      const versionDirectory = makeDirectory(path.join(cacheRoot, latest.latestVersion + '-' + latest.commitSha));
      const packageDir = path.join(versionDirectory, 'package');
      if (entryExists(packageDir)) verifyCode(packageDir, files);
      else fs.renameSync(staging, packageDir);
      const job = { schemaVersion: 1, packageName: 'dsh-ghost', jobId, version: latest.latestVersion,
        commitSha: latest.commitSha, currentVersion, dshHome: home, profileDir, dataDir: protectedData,
        sourceRoot: source, cacheRoot, packageDir, controlDir, jobFile: path.join(controlDir, 'job.json'),
        desktopExecutable: executable, desktopCliEntry: cliEntry, ...installation, files };
      validateUpdateJob(job);
      check(!disposed && !signal.aborted && !getBlocked(), 'CANCELLED', '更新请求已取消');
      atomicJson(job.jobFile, job);
      atomicJson(pointerFile, { schemaVersion: 1, jobId, jobFile: job.jobFile }); savedJob = job;
      return await launch(job);
    } finally { try { lease.exec('ROLLBACK'); } catch { /* no lock was acquired */ } lease.close(); }
  }

  function run({ signal, resumePending = false } = {}) {
    if (active) return active;
    controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    active = perform(combined, resumePending).catch(error => {
      state = { ...state, phase: 'error', currentVersion, error: error.message || '更新失败', code: error.code || 'UPDATE_FAILED' };
      return { ...state };
    }).finally(() => { active = null; controller = null; });
    return active;
  }
  return { update: options => run(options), resume: options => run({ ...options, resumePending: true }), describe, get pending() {
    const current = describe();
    return !!active || current.phase === 'pending' || current.blocking === true;
  },
    async dispose() { disposed = true; controller?.abort(); if (active) await active; } };
}
