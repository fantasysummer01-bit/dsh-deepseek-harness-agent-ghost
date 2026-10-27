import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UPDATE_JOB_FILE = 'job.json';
export const UPDATE_RESULT_FILE = 'result.json';
export const PROFILE_BACKUP_FILES = Object.freeze(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml',
  'cordis.yml', 'pnpm-workspace.yaml']);
const REQUIRED_FILES = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/core.js',
  'scripts/uninstall-worker.mjs', 'scripts/update-worker.mjs'];
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);
const inside = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(condition, code, message) { if (!condition) fail(code, message); }
const intersects = (left, right) => inside(left, right) || inside(right, left);
function existsEntry(filename) {
  try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Validate existing code/control paths without ever opening a Ghost data file. */
export function assertUpdatePath(target, { directory = true } = {}) {
  check(typeof target === 'string' && path.isAbsolute(target), 'UNSAFE_UPDATE_PATH', 'An absolute update path is required');
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    check(!fs.lstatSync(current).isSymbolicLink(), 'UNSAFE_UPDATE_PATH', 'Update code and control paths cannot use symbolic links');
  }
  const stat = fs.lstatSync(absolute);
  check(directory ? stat.isDirectory() : stat.isFile(), 'UNSAFE_UPDATE_PATH', 'Update path has an unexpected type');
  return fs.realpathSync(absolute);
}
export function updateFingerprint(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function equalsFingerprint(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }
function safeRelative(relative) {
  return typeof relative === 'string' && relative.length <= 240 && !/[\\:\x00-\x1f\x7f%]/.test(relative)
    && !relative.startsWith('/') && relative.split('/').every(part => part && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      && !/^(?:\.git|node_modules|\.runtime|artifacts|\.dsh|data)$/i.test(part))
    && (/^(?:package\.json|cordis\.patch\.yml|README\.md)$/.test(relative)
      || /^lib\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/.test(relative)
      || /^scripts\/(?:uninstall|update)-worker\.mjs$/.test(relative));
}
function readManifest(profileDir) {
  return JSON.parse(fs.readFileSync(assertUpdatePath(path.join(profileDir, 'package.json'), { directory: false }), 'utf8'));
}
function localDependency(profileDir, dependency) {
  const match = /^(?:link|file):(.+)$/s.exec(dependency || '');
  check(!!match && !/\.(?:tgz|tar|zip)$/i.test(match[1]), 'UNSUPPORTED_INSTALL', 'Updating requires a local directory installation of Ghost');
  return path.resolve(profileDir, match[1]);
}
function dependencyMatches(profileDir, manifest, target) {
  const dependency = manifest.dependencies?.['dsh-ghost'];
  if (typeof dependency !== 'string') return false;
  try {
    if (!same(fs.realpathSync(localDependency(profileDir, dependency)), target)) return false;
    return same(fs.realpathSync(path.join(profileDir, 'node_modules', 'dsh-ghost')), target)
      && manifest.dsh?.profile?.bundles?.includes('dsh-ghost');
  } catch { return false; }
}
function checkPackage(job) {
  check(Array.isArray(job.files) && job.files.length >= REQUIRED_FILES.length && job.files.length <= 128,
    'INVALID_UPDATE_PACKAGE', 'A bounded verified update manifest is required');
  const found = new Set(), expected = new Map();
  for (const file of job.files) {
    check(safeRelative(file?.path) && /^[a-f0-9]{64}$/.test(file.sha256 || ''), 'INVALID_UPDATE_PACKAGE', 'Update manifest contains an unsafe file');
    check(!expected.has(file.path.toLowerCase()), 'INVALID_UPDATE_PACKAGE', 'Update manifest contains duplicate paths');
    expected.set(file.path.toLowerCase(), file);
  }
  check(REQUIRED_FILES.every(name => expected.has(name.toLowerCase())), 'INVALID_UPDATE_PACKAGE', 'Update package is missing a runtime entry');
  let total = 0, visited = 0;
  const visit = (directory, relative = '', depth = 0) => {
    check(depth <= 12, 'INVALID_UPDATE_PACKAGE', 'Update directory nesting is too deep');
    for (const name of fs.readdirSync(directory)) {
      check(++visited <= 256, 'INVALID_UPDATE_PACKAGE', 'Update package has too many entries');
      const filename = path.join(directory, name), rel = relative ? relative + '/' + name : name;
      const stat = fs.lstatSync(filename);
      check(!stat.isSymbolicLink(), 'UNSAFE_UPDATE_PATH', 'Downloaded code cannot contain symbolic links');
      if (stat.isDirectory()) {
        check([...expected.values()].some(file => file.path.startsWith(rel + '/')),
          'INVALID_UPDATE_PACKAGE', 'Update package contains an unexpected directory');
        visit(filename, rel, depth + 1); continue;
      }
      check(stat.isFile() && safeRelative(rel), 'INVALID_UPDATE_PACKAGE', 'Update package contains unexpected files');
      const record = expected.get(rel.toLowerCase());
      check(record && record.path === rel && !found.has(rel.toLowerCase()), 'INVALID_UPDATE_PACKAGE', 'Update files differ from their verified manifest');
      check(stat.size <= 1024 * 1024 && (total += stat.size) <= 8 * 1024 * 1024,
        'INVALID_UPDATE_PACKAGE', 'Update package exceeds its size limit');
      check(sha256(fs.readFileSync(filename)) === record.sha256, 'UPDATE_HASH_MISMATCH', 'Downloaded update code changed after verification');
      found.add(rel.toLowerCase());
    }
  };
  visit(job.packageDir);
  check(found.size === expected.size, 'INVALID_UPDATE_PACKAGE', 'Update package has missing files');
  const manifest = JSON.parse(fs.readFileSync(path.join(job.packageDir, 'package.json'), 'utf8'));
  check(manifest.name === 'dsh-ghost' && manifest.version === job.version && manifest.type === 'module'
    && manifest.main === 'lib/index.js' && manifest.dsh?.bundle?.patch === './cordis.patch.yml',
  'INVALID_UPDATE_PACKAGE', 'Downloaded package identity or version is invalid');
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    check(!manifest[kind] || typeof manifest[kind] === 'object' && !Array.isArray(manifest[kind]) && Object.keys(manifest[kind]).length === 0,
      'INVALID_UPDATE_PACKAGE', 'Automatic updates cannot install additional dependencies');
  }
  for (const key of ['bundledDependencies', 'bundleDependencies']) check(manifest[key] === undefined || Array.isArray(manifest[key]) && !manifest[key].length,
    'INVALID_UPDATE_PACKAGE', 'Automatic updates cannot install bundled dependencies');
  for (const key of ['workspaces', 'packageManager', 'pnpm', 'overrides', 'resolutions', 'bin', 'directories', 'gypfile']) {
    check(!Object.hasOwn(manifest, key), 'INVALID_UPDATE_PACKAGE', 'Automatic updates cannot change package-manager configuration');
  }
  check(!manifest.scripts || typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
    && Object.keys(manifest.scripts).every(key => ['test', 'check', 'pack:local'].includes(key)),
    'INVALID_UPDATE_PACKAGE', 'Automatic updates cannot run installation hooks');
  const expectedExports = { '.': './lib/index.js', './client': './lib/client.js', './core': './lib/core.js', './package.json': './package.json' };
  check(manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)
    && Object.keys(manifest.exports).length === Object.keys(expectedExports).length
    && Object.entries(expectedExports).every(([key, value]) => manifest.exports[key] === value),
  'INVALID_UPDATE_PACKAGE', 'Automatic updates cannot change module exports');
  check(Object.keys(manifest.dsh).every(key => ['bundle', 'client'].includes(key)) && Object.keys(manifest.dsh.bundle).length === 1
    && manifest.dsh.client && Object.keys(manifest.dsh.client).every(key => ['inject', 'platform'].includes(key))
    && manifest.dsh.client.platform === 'web' && Array.isArray(manifest.dsh.client.inject)
    && manifest.dsh.client.inject.length === 2 && manifest.dsh.client.inject[0] === '@deepseek-ai/dsh-client-ui-settings'
    && manifest.dsh.client.inject[1] === '@deepseek-ai/dsh-client-connection',
  'INVALID_UPDATE_PACKAGE', 'Automatic updates cannot change host configuration');
  const patch = fs.readFileSync(path.join(job.packageDir, 'cordis.patch.yml'), 'utf8');
  check(/^\s*-\s+insert:\s*\r?\n\s*-\s+id:\s*dsh-ghost\s*\r?\n\s+name:\s*dsh-ghost\s*$/.test(patch),
    'INVALID_UPDATE_PACKAGE', 'Automatic updates cannot change Ghost data paths or add unrelated plugins');
  return manifest;
}

/** Read-only validation: no database initialization, checkpoint or data migration. */
export function validateUpdateJob(job) {
  check(job && job.schemaVersion === 1 && job.packageName === 'dsh-ghost'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(job.jobId || '')
    && VERSION.test(job.version || '') && VERSION.test(job.currentVersion || '') && /^[a-f0-9]{40}$/.test(job.commitSha || ''),
  'INVALID_UPDATE_JOB', 'Invalid Ghost update job');
  const home = assertUpdatePath(job.dshHome), profile = assertUpdatePath(job.profileDir);
  check(same(profile, path.join(home, 'profiles', 'desktop')), 'UNSAFE_UPDATE_PATH', 'Only the current Desktop profile can be updated');
  const cache = assertUpdatePath(job.cacheRoot), directory = assertUpdatePath(job.packageDir), control = assertUpdatePath(job.controlDir);
  check(same(cache, path.join(home, 'plugin-updates', 'dsh-ghost'))
    && same(directory, path.join(cache, job.version + '-' + job.commitSha, 'package'))
    && same(control, path.join(cache, 'control', job.jobId)), 'UNSAFE_UPDATE_PATH', 'Update paths are outside the dedicated code cache');
  check(typeof job.dataDir === 'string' && path.isAbsolute(job.dataDir), 'UNSAFE_UPDATE_PATH', 'A protected Ghost data path is required');
  const protectedData = path.resolve(job.dataDir); // Deliberately do not open/stat any data file.
  for (const target of [cache, directory, control, profile]) check(!intersects(protectedData, target), 'UNSAFE_UPDATE_PATH', 'Ghost data and update paths must be separate');
  const source = assertUpdatePath(job.sourceRoot);
  check(!intersects(source, protectedData), 'UNSAFE_UPDATE_PATH', 'Ghost data and the installed code must be separate');
  for (const target of [directory, control]) check(!intersects(source, target), 'UNSAFE_UPDATE_PATH', 'Updating cannot overwrite the current source checkout');
  check(equalsFingerprint(updateFingerprint(profile), job.profileFingerprint), 'UPDATE_TARGET_CHANGED', 'Desktop profile directory changed after checking for updates');
  const executable = assertUpdatePath(job.desktopExecutable, { directory: false });
  const entry = path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  check(path.basename(executable).toLowerCase() === 'deepseek harness.exe' && same(job.desktopCliEntry, entry) && fs.existsSync(entry),
    'UNSUPPORTED_HOST', 'The installed Desktop CLI is unavailable');
  checkPackage(job);
  const manifest = readManifest(profile);
  const installed = dependencyMatches(profile, manifest, directory);
  if (!installed) {
    check(manifest.dependencies?.['dsh-ghost'] === job.expectedOldDependency, 'UPDATE_TARGET_CHANGED', 'Ghost installation changed after checking for updates');
    check(dependencyMatches(profile, manifest, source), 'UPDATE_TARGET_CHANGED', 'Current Ghost package link changed after checking for updates');
    const current = JSON.parse(fs.readFileSync(assertUpdatePath(path.join(source, 'package.json'), { directory: false }), 'utf8'));
    check(current.name === 'dsh-ghost' && current.version === job.currentVersion, 'UPDATE_TARGET_CHANGED', 'Installed Ghost version changed after checking for updates');
  }
  return { alreadyInstalled: installed };
}

export function updateDesktopIsRunning() {
  check(process.platform === 'win32', 'UNSUPPORTED_HOST', 'Desktop process verification currently requires Windows');
  const script = "$ErrorActionPreference='Stop'; $p=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne [int]$env:GHOST_UPDATE_HELPER_PID }); if($p.Count -gt 0){exit 7}else{exit 0}";
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, GHOST_UPDATE_HELPER_PID: String(process.pid) }, stdio: 'ignore', windowsHide: true, timeout: 10000,
  });
  if (result.status === 7) return true;
  check(result.status === 0, 'PROCESS_CHECK_FAILED', 'Could not establish that Desktop has exited');
  return false;
}
export function officialUpdateAdd(job, directory) {
  const result = spawnSync(job.desktopExecutable, ['--expose-internals', job.desktopCliEntry,
    'plugin', '--profile', 'desktop', 'add', directory, '--offline', '--ignore-scripts'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: job.dshHome, GIT_TERMINAL_PROMPT: '0', npm_config_ignore_scripts: 'true' },
    stdio: 'ignore', windowsHide: true, timeout: 120000,
  });
  check(result.status === 0, 'UPDATE_INSTALL_FAILED', 'Desktop did not finish installing Ghost code');
}
function readProfileBackup(job) {
  const directory = path.join(job.controlDir, 'backup'), recordFile = path.join(directory, 'manifest.json');
  if (existsEntry(directory)) {
    assertUpdatePath(directory); assertUpdatePath(recordFile, { directory: false });
    const saved = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    check(saved.jobId === job.jobId && same(saved.oldPackageDir, job.sourceRoot), 'UPDATE_BACKUP_INVALID', 'Update backup belongs to another job');
    check(saved.terminalFailure === undefined || typeof saved.terminalFailure === 'boolean',
      'UPDATE_BACKUP_INVALID', 'Update backup has an invalid attempt state');
    check(Array.isArray(saved.files) && saved.files.length === PROFILE_BACKUP_FILES.length
      && new Set(saved.files.map(file => file.name)).size === PROFILE_BACKUP_FILES.length
      && saved.files.every(file => PROFILE_BACKUP_FILES.includes(file.name) && typeof file.existed === 'boolean'
        && (!file.existed || /^[a-f0-9]{64}$/.test(file.sha256))), 'UPDATE_BACKUP_INVALID', 'Update backup contains unexpected files');
    for (const file of saved.files) if (file.existed) check(sha256(fs.readFileSync(assertUpdatePath(path.join(directory, file.name), { directory: false }))) === file.sha256,
      'UPDATE_BACKUP_INVALID', 'Update profile backup changed');
    return saved;
  }
  return null;
}
function backupProfile(job) {
  const directory = path.join(job.controlDir, 'backup'), recordFile = path.join(directory, 'manifest.json');
  const saved = readProfileBackup(job);
  if (saved && !saved.terminalFailure) return saved;
  if (saved) {
    // Only a completely restored terminal failure may start a fresh attempt.
    // An interrupted attempt keeps its original snapshot for crash recovery.
    assertUpdatePath(job.controlDir); assertUpdatePath(directory);
    fs.renameSync(directory, path.join(job.controlDir, 'backup-failed-' + randomUUID()));
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  const files = PROFILE_BACKUP_FILES.map(name => {
    const filename = path.join(job.profileDir, name);
    try { fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return { name, existed: false }; throw error; }
    const content = fs.readFileSync(assertUpdatePath(filename, { directory: false }));
    fs.writeFileSync(path.join(directory, name), content, { flag: 'wx', mode: 0o600 });
    return { name, existed: true, sha256: sha256(content) };
  });
  const record = { jobId: job.jobId, oldPackageDir: job.sourceRoot, files };
  fs.writeFileSync(recordFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return record;
}
function restoreProfileFiles(job, backup) {
  assertUpdatePath(job.profileDir);
  check(equalsFingerprint(updateFingerprint(job.profileDir), job.profileFingerprint), 'UPDATE_TARGET_CHANGED', 'Cannot restore a replaced Desktop profile');
  for (const file of backup.files) {
    check(PROFILE_BACKUP_FILES.includes(file.name), 'UPDATE_BACKUP_INVALID', 'Unexpected backup entry');
    const target = path.join(job.profileDir, file.name);
    if (existsEntry(target)) assertUpdatePath(target, { directory: false });
    if (file.existed) {
      const content = fs.readFileSync(assertUpdatePath(path.join(job.controlDir, 'backup', file.name), { directory: false }));
      check(sha256(content) === file.sha256, 'UPDATE_BACKUP_INVALID', 'Update backup checksum failed');
      fs.writeFileSync(target, content, { mode: 0o600 });
    } else if (existsEntry(target)) fs.unlinkSync(target);
  }
}
function atomicControlJson(filename, value) {
  assertUpdatePath(path.dirname(filename));
  if (existsEntry(filename)) assertUpdatePath(filename, { directory: false });
  const temporary = path.join(path.dirname(filename), '.update-' + randomUUID() + '.tmp');
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filename);
}
function writeResult(job, value) { atomicControlJson(path.join(job.controlDir, UPDATE_RESULT_FILE), value); }
function assertProfilePreserved(job, backup) {
  for (const file of backup.files.filter(item => !['package.json', 'pnpm-lock.yaml'].includes(item.name))) {
    const target = path.join(job.profileDir, file.name);
    check(file.existed ? fs.existsSync(target) && sha256(fs.readFileSync(assertUpdatePath(target, { directory: false }))) === file.sha256
      : !fs.existsSync(target), 'UPDATE_CONFIG_CHANGED', 'Installing code unexpectedly changed Desktop configuration');
  }
  const before = JSON.parse(fs.readFileSync(path.join(job.controlDir, 'backup', 'package.json'), 'utf8'));
  const after = readManifest(job.profileDir);
  delete before.dependencies?.['dsh-ghost']; delete after.dependencies?.['dsh-ghost'];
  const sorted = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(sorted)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  check(JSON.stringify(sorted(before)) === JSON.stringify(sorted(after)), 'UPDATE_CONFIG_CHANGED', 'Installing Ghost unexpectedly changed another plugin or profile setting');
}

/** Install code only after Desktop exits. Never reads, rewrites or deletes dataDir. */
export async function runUpdateJob(job, dependencies = {}) {
  const isRunning = dependencies.isDesktopRunning || updateDesktopIsRunning;
  const add = dependencies.runAdd || officialUpdateAdd;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let checks = 0;
  const waitForExit = async () => {
    while (await isRunning(job)) {
      check(++checks < (dependencies.maxChecks ?? 43200), 'UPDATE_WAIT_EXPIRED', 'Desktop is still running; update remains pending');
      await sleep(dependencies.pollMilliseconds ?? 2000);
    }
  };
  let state = validateUpdateJob(job);
  const installedResult = () => {
    const backup = readProfileBackup(job);
    if (backup) assertProfilePreserved(job, backup);
    return { completed: true, alreadyInstalled: true, version: job.version, commitSha: job.commitSha, coreFilesPreserved: true };
  };
  if (state.alreadyInstalled) return installedResult();
  await waitForExit();
  state = validateUpdateJob(job);
  if (state.alreadyInstalled) return installedResult();
  const backup = backupProfile(job);
  // An unresolved crash snapshot may predate independent user changes. Refuse
  // to install against that snapshot instead of later restoring over them.
  assertProfilePreserved(job, backup);
  let addStarted = false;
  try {
    check(!(await isRunning(job)), 'HOST_RESTARTED', 'Desktop restarted before the code switch; update remains pending');
    validateUpdateJob(job);
    addStarted = true;
    await add(job, job.packageDir);
    check(dependencyMatches(job.profileDir, readManifest(job.profileDir), job.packageDir), 'UPDATE_INSTALL_INCOMPLETE', 'Desktop did not select the verified Ghost code');
    assertProfilePreserved(job, backup);
    return { completed: true, version: job.version, commitSha: job.commitSha, coreFilesPreserved: true };
  } catch (installError) {
    if (!addStarted) {
      // No code/package operation ran. Mark only a still-matching snapshot as
      // safe to retire; unknown crash state remains available for recovery.
      try {
        assertProfilePreserved(job, backup);
        atomicControlJson(path.join(job.controlDir, 'backup', 'manifest.json'), { ...backup, terminalFailure: true });
      } catch { /* Keep the original snapshot when its state is uncertain. */ }
      throw installError;
    }
    // A failed package operation may have touched its link. Roll back only when
    // Desktop is absent; never interrupt a newly opened conversation to do it.
    await waitForExit();
    try {
      const manifest = readManifest(job.profileDir);
      if (!dependencyMatches(job.profileDir, manifest, job.sourceRoot)) await add(job, job.sourceRoot);
      restoreProfileFiles(job, backup);
      check(dependencyMatches(job.profileDir, readManifest(job.profileDir), job.sourceRoot), 'UPDATE_ROLLBACK_FAILED', 'Previous Ghost package link was not restored');
      atomicControlJson(path.join(job.controlDir, 'backup', 'manifest.json'), { ...backup, terminalFailure: true });
    } catch {
      fail('UPDATE_ROLLBACK_FAILED', 'Ghost update failed and its previous code could not be fully restored; core records were not modified');
    }
    fail(installError.code || 'UPDATE_INSTALL_FAILED', 'Ghost update failed; the previous plugin code was restored and core records were not modified');
  }
}

async function main() {
  const helper = assertUpdatePath(path.dirname(fileURLToPath(import.meta.url))), jobFile = path.resolve(process.argv[2] || '');
  check(same(path.dirname(helper), fs.realpathSync(os.tmpdir())) && path.basename(helper).startsWith('dsh-ghost-update-')
    && path.basename(jobFile) === UPDATE_JOB_FILE && path.basename(path.dirname(path.dirname(jobFile))) === 'control',
  'INVALID_UPDATE_JOB', 'Invalid isolated update helper');
  const job = JSON.parse(fs.readFileSync(assertUpdatePath(jobFile, { directory: false }), 'utf8'));
  check(same(jobFile, path.join(job.controlDir, UPDATE_JOB_FILE)) && (!job.jobFile || same(job.jobFile, jobFile)),
    'INVALID_UPDATE_JOB', 'Update job does not match its control directory');
  // Establish only the fixed control destination before validation, so a
  // subsequently damaged package produces a visible failure instead of an
  // indefinitely pending UI. Never write an error beside an arbitrary argv.
  check(typeof job.dshHome === 'string' && typeof job.jobId === 'string' && typeof job.dataDir === 'string'
    && same(job.controlDir, path.join(job.dshHome, 'plugin-updates', 'dsh-ghost', 'control', job.jobId))
    && !intersects(job.dataDir, job.controlDir), 'INVALID_UPDATE_JOB', 'Update result directory is unsafe');
  assertUpdatePath(job.controlDir);
  // A control lock has no memory contents. A crashed job may be relaunched, but
  // concurrent helpers for the same installation must not run the CLI together.
  const lockFile = path.join(job.controlDir, 'worker-lease.sqlite');
  let lock;
  try {
    validateUpdateJob(job);
    if (existsEntry(lockFile)) assertUpdatePath(lockFile, { directory: false });
    lock = new DatabaseSync(lockFile);
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { lock.close(); lock = undefined; fail('UPDATE_ALREADY_RUNNING', 'An update helper is already running'); }
    const result = await runUpdateJob(job);
    writeResult(job, result);
  } catch (error) {
    if (error.code !== 'UPDATE_ALREADY_RUNNING') writeResult(job, { completed: false,
      code: error.code || 'UPDATE_FAILED', error: error.message, coreFilesPreserved: true });
    process.exitCode = 1;
  } finally {
    if (lock) { try { lock.exec('ROLLBACK'); } finally { lock.close(); } }
    for (const name of [UPDATE_JOB_FILE, 'worker.mjs']) {
      const file = path.join(helper, name);
      if (fs.existsSync(file)) { assertUpdatePath(file, { directory: false }); fs.unlinkSync(file); }
    }
    if (!fs.readdirSync(helper).length) fs.rmdirSync(helper);
  }
}
if (process.argv[1] && same(fs.realpathSync(fileURLToPath(import.meta.url)), fs.realpathSync(path.resolve(process.argv[1])))) {
  main().catch(() => { process.exitCode = 1; });
}
