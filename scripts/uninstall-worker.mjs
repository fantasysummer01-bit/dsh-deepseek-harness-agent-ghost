import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PENDING_FILE = '.ghost-uninstall-pending.json';
export const OWNED_FILES = Object.freeze(['ghost.sqlite', 'ghost.sqlite-wal', 'ghost.sqlite-shm',
  'ghost.sqlite-journal', PENDING_FILE]);
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(condition, code, message) { if (!condition) fail(code, message); }

/** Refuse junctions/symlinks in any existing component, not only the leaf. */
export function assertPlainPath(target, { directory = true } = {}) {
  check(typeof target === 'string' && path.isAbsolute(target), 'UNSAFE_PATH', 'An absolute path is required');
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    check(!stat.isSymbolicLink(), 'UNSAFE_PATH', 'Symbolic links and junctions are not uninstall targets');
  }
  const stat = fs.lstatSync(resolved);
  check(directory ? stat.isDirectory() : stat.isFile(), 'UNSAFE_PATH', 'Uninstall target has an unexpected type');
  // realpath also expands Windows short names; lstat above already rejected links.
  return fs.realpathSync(resolved);
}

export function fingerprint(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  check(!stat.isSymbolicLink(), 'UNSAFE_PATH', 'Symbolic links and junctions are not uninstall targets');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function equalFingerprint(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }

export function inspectGhostDatabase(dataDir) {
  const database = path.join(dataDir, 'ghost.sqlite');
  assertPlainPath(database, { directory: false });
  let db;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=500');
    check(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value === '1',
      'UNRECOGNIZED_DATA', 'The database is not a recognized Ghost schema');
    const state = JSON.parse(db.prepare('SELECT json FROM state WHERE singleton=1').get()?.json);
    check(typeof state.ghostId === 'string' && state.ghostId.length > 0
      && typeof state.branchId === 'string' && state.branchId.length > 0 && Number.isSafeInteger(state.version),
    'UNRECOGNIZED_DATA', 'Ghost identity is missing or damaged');
    return { ghostId: state.ghostId, branchId: state.branchId, version: state.version,
      databaseFingerprint: fingerprint(database) };
  } catch (error) {
    if (error.code === 'UNRECOGNIZED_DATA' || error.code === 'UNSAFE_PATH') throw error;
    fail('UNRECOGNIZED_DATA', 'Ghost data could not be identified safely; no data was removed');
  } finally { db?.close(); }
}

export function validateUninstallPaths({ dataDir, dshHome, sourceRoot, profileDir }) {
  const home = assertPlainPath(dshHome);
  const data = assertPlainPath(dataDir);
  const profile = assertPlainPath(profileDir);
  check(same(profile, path.join(home, 'profiles', 'desktop')), 'UNSAFE_PATH', 'Only the current Desktop profile can be removed');
  const source = sourceRoot && (fs.existsSync(sourceRoot) ? fs.realpathSync(sourceRoot) : path.resolve(sourceRoot));
  const protectedLocations = [path.parse(data).root, fs.realpathSync(os.homedir()), home,
    source].filter(Boolean);
  check(!protectedLocations.some(protectedPath => inside(data, path.resolve(protectedPath))),
    'UNSAFE_PATH', 'Ghost data cannot be a root, home, DSH home, source tree, or their parent');
  check(!source || !inside(source, data), 'UNSAFE_PATH', 'Ghost data cannot be inside the plugin source tree');
  check(!inside(path.join(home, 'profiles'), data), 'UNSAFE_PATH', 'DSH profile directories cannot be erased');
  for (const file of OWNED_FILES) {
    const target = path.join(data, file);
    if (fs.existsSync(target)) assertPlainPath(target, { directory: false });
  }
  return { dataDir: data, dshHome: home, profileDir: profile };
}

export function validateJob(job) {
  check(job && job.schemaVersion === 1 && job.packageName === 'dsh-ghost'
    && /^[a-f0-9-]{36}$/.test(job.jobId || ''), 'INVALID_JOB', 'Invalid Ghost uninstall job');
  validateUninstallPaths(job);
  check(equalFingerprint(fingerprint(job.dataDir), job.dataFingerprint), 'TARGET_CHANGED', 'Ghost data directory changed after confirmation');
  check(equalFingerprint(fingerprint(job.profileDir), job.profileFingerprint), 'TARGET_CHANGED', 'DSH profile directory changed after confirmation');
  assertPlainPath(job.desktopExecutable, { directory: false });
  const expectedEntry = path.join(path.dirname(job.desktopExecutable), 'resources', 'app.asar',
    'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  check(same(job.desktopCliEntry, expectedEntry) && fs.existsSync(expectedEntry), 'UNSUPPORTED_HOST', 'Desktop CLI entry is unavailable');
  check(path.basename(job.desktopExecutable).toLowerCase() === 'deepseek harness.exe',
    'UNSUPPORTED_HOST', 'Complete uninstall is supported by the Desktop host only');
  if (!fs.existsSync(path.join(job.dataDir, 'ghost.sqlite'))) {
    check(job.cleanupStarted === true && pluginIsRemoved(job.profileDir), 'TARGET_CHANGED', 'Ghost database is missing before approved cleanup');
    return null;
  }
  const database = inspectGhostDatabase(job.dataDir);
  check(database.ghostId === job.ghostId && database.branchId === job.branchId
    && database.version === job.version && equalFingerprint(database.databaseFingerprint, job.databaseFingerprint),
  'TARGET_CHANGED', 'Ghost database identity changed after confirmation');
  return database;
}

function acquireLease(directory, key) {
  fs.mkdirSync(directory, { recursive: true });
  assertPlainPath(directory);
  const filename = path.join(directory, digest(key) + '.sqlite');
  if (fs.existsSync(filename)) assertPlainPath(filename, { directory: false });
  const lease = new DatabaseSync(filename);
  try { lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch { lease.close(); fail('WRITER_CONFLICT', 'Another Ghost instance is using this identity or data directory'); }
  return { filename, release() { try { lease.exec('ROLLBACK'); } finally { lease.close(); } } };
}

export function desktopIsRunning(job) {
  check(process.platform === 'win32', 'UNSUPPORTED_HOST', 'Desktop process verification is available on Windows only');
  const script = "$ErrorActionPreference='Stop'; $p=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne [int]$env:GHOST_UNINSTALL_HELPER_PID }); if($p.Count -gt 0){exit 7}else{exit 0}";
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, GHOST_UNINSTALL_HELPER_PID: String(process.pid) },
    stdio: 'ignore', windowsHide: true, timeout: 10000,
  });
  if (result.status === 7) return true;
  check(result.status === 0, 'PROCESS_CHECK_FAILED', 'Could not prove that Desktop has exited; no data was removed');
  return false;
}

export function officialRemove(job) {
  const result = spawnSync(job.desktopExecutable, ['--expose-internals', job.desktopCliEntry,
    'plugin', '--profile', 'desktop', 'remove', 'dsh-ghost'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: job.dshHome, GIT_TERMINAL_PROMPT: '0' },
    stdio: 'ignore', windowsHide: true, timeout: 120000,
  });
  check(result.status === 0, 'REMOVE_FAILED', 'DSH plugin removal failed; Ghost memory data was retained');
}

function pluginIsRemoved(profileDir) {
  const file = path.join(profileDir, 'package.json');
  assertPlainPath(file, { directory: false });
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  return !manifest.dependencies?.['dsh-ghost'] && !manifest.devDependencies?.['dsh-ghost']
    && !manifest.optionalDependencies?.['dsh-ghost'] && !manifest.dsh?.profile?.bundles?.includes('dsh-ghost');
}

function assertPackageLinkRemoved(profileDir) {
  try {
    fs.lstatSync(path.join(profileDir, 'node_modules', 'dsh-ghost'));
    fail('REMOVE_INCOMPLETE', 'Ghost package link is still present; memory data was retained');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function verifyPending(job) {
  const marker = path.join(job.dataDir, PENDING_FILE);
  assertPlainPath(marker, { directory: false });
  check(JSON.parse(fs.readFileSync(marker, 'utf8')).jobId === job.jobId,
    'TARGET_CHANGED', 'Uninstall confirmation marker changed');
}

function writeCleanupPhase(job) {
  verifyPending(job);
  const marker = path.join(job.dataDir, PENDING_FILE);
  const descriptor = fs.openSync(marker, 'r+');
  try {
    const content = Buffer.from(JSON.stringify(job), 'utf8');
    fs.writeSync(descriptor, content, 0, content.length, 0);
    fs.ftruncateSync(descriptor, content.length);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

/** All production filesystem mutations are restricted to this job's known files. */
export async function runUninstallJob(job, dependencies = {}) {
  const isRunning = dependencies.isDesktopRunning || desktopIsRunning;
  const removePlugin = dependencies.runRemove || officialRemove;
  const sleep = dependencies.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const maxChecks = dependencies.maxChecks ?? 43200;
  const pollMilliseconds = dependencies.pollMilliseconds ?? 2000;
  // The isolated copy may be retried after cleanup partially succeeded. Only
  // the durable approval marker can advance the cleanup phase.
  verifyPending(job);
  const stored = JSON.parse(fs.readFileSync(path.join(job.dataDir, PENDING_FILE), 'utf8'));
  job = { ...job, cleanupStarted: stored.cleanupStarted === true };
  validateJob(job);
  verifyPending(job);
  let checks = 0;
  while (await isRunning(job)) {
    check(++checks < maxChecks, 'WAIT_EXPIRED', 'Desktop is still running; uninstall remains pending');
    await sleep(pollMilliseconds);
  }
  validateJob(job);
  verifyPending(job);
  const leases = [];
  let removedFiles = [];
  try {
    // Use the same branch/path leases as GhostStore. No running writer is erased.
    const leaseDir = path.join(os.tmpdir(), 'dsh-ghost-writer-leases');
    leases.push(acquireLease(leaseDir, 'path:' + path.join(job.dataDir, 'ghost.sqlite').toLowerCase()));
    leases.push(acquireLease(leaseDir, `branch:${job.ghostId}:${job.branchId}`));
    validateJob(job);
    check(!(await isRunning(job)), 'HOST_RESTARTED', 'Desktop restarted before removal; no data was removed');
    if (!pluginIsRemoved(job.profileDir)) await removePlugin(job);
    check(pluginIsRemoved(job.profileDir), 'REMOVE_INCOMPLETE', 'Ghost is still registered; memory data was retained');
    assertPackageLinkRemoved(job.profileDir);
    check(!(await isRunning(job)), 'HOST_RESTARTED', 'Desktop restarted during removal; no data was removed');
    validateJob(job);
    verifyPending(job);
    if (!job.cleanupStarted) { job = { ...job, cleanupStarted: true }; writeCleanupPhase(job); }
    // Revalidate every leaf before the first deletion; never recursively remove a directory.
    const targets = OWNED_FILES.map(name => path.join(job.dataDir, name)).filter(file => fs.existsSync(file));
    for (const file of targets) assertPlainPath(file, { directory: false });
    const erase = dependencies.removeFile || (file => fs.unlinkSync(file));
    // Delete the main database last, keeping partial failures resumable.
    const owned = targets.filter(file => path.basename(file) !== PENDING_FILE)
      .sort((left, right) => Number(path.basename(left) === 'ghost.sqlite') - Number(path.basename(right) === 'ghost.sqlite'));
    for (const file of owned) {
      check(equalFingerprint(fingerprint(job.dataDir), job.dataFingerprint), 'TARGET_CHANGED', 'Ghost data directory was replaced');
      assertPlainPath(file, { directory: false });
      erase(file);
      removedFiles.push(path.basename(file));
    }
    const marker = path.join(job.dataDir, PENDING_FILE);
    verifyPending(job); erase(marker); removedFiles.push(PENDING_FILE);
    let directoryRemoved = false;
    if (!fs.readdirSync(job.dataDir).length) { fs.rmdirSync(job.dataDir); directoryRemoved = true; }
    return { completed: true, removedFiles, directoryRemoved,
      retainedFiles: directoryRemoved ? [] : fs.readdirSync(job.dataDir) };
  } finally {
    for (const lease of leases.reverse()) lease.release();
    // Shared temporary lease files contain no messages. Do not unlink released
    // lock files: another writer could acquire them between release and unlink.
  }
}

async function main() {
  const jobFile = path.resolve(process.argv[2] || '');
  const helperDirectory = assertPlainPath(path.dirname(fileURLToPath(import.meta.url)));
  check(path.dirname(helperDirectory) === fs.realpathSync(os.tmpdir())
    && path.basename(helperDirectory).startsWith('dsh-ghost-uninstall-')
    && same(fs.realpathSync(jobFile), path.join(helperDirectory, 'job.json')), 'INVALID_JOB', 'Invalid isolated helper directory');
  assertPlainPath(helperDirectory);
  assertPlainPath(jobFile, { directory: false });
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const lease = acquireLease(path.join(os.tmpdir(), 'dsh-ghost-uninstall-leases'), job.jobId);
  try {
    const result = await runUninstallJob(job);
    fs.writeFileSync(path.join(helperDirectory, 'result.json'), JSON.stringify(result));
    // Known, freshly-created temporary files only; never a recursive directory delete.
    for (const name of ['job.json', 'worker.mjs', 'result.json']) {
      const file = path.join(helperDirectory, name);
      if (fs.existsSync(file)) { assertPlainPath(file, { directory: false }); fs.unlinkSync(file); }
    }
    if (!fs.readdirSync(helperDirectory).length) fs.rmdirSync(helperDirectory);
  } catch (error) {
    fs.writeFileSync(path.join(helperDirectory, 'result.json'), JSON.stringify({ completed: false,
      code: error.code || 'UNINSTALL_FAILED', error: error.message, pending: true }));
    process.exitCode = 1;
  } finally { lease.release(); }
}

if (process.argv[1] && same(fs.realpathSync(fileURLToPath(import.meta.url)), fs.realpathSync(path.resolve(process.argv[1])))) {
  main().catch(() => { process.exitCode = 1; });
}
