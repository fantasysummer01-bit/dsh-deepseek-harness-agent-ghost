import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** Real official CLI, isolated Desktop profile, no real credentials or records. */
export function runUpdateHostSmoke({ sdkRoot = process.env.DSH_SDK_ROOT, executable = process.execPath } = {}) {
  if (!sdkRoot || process.platform !== 'win32') return { status: 'SKIP', reason: 'Windows Desktop SDK is required for the real update CLI test.' };
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-update-real-cli-'));
  const home = path.join(root, 'dsh'), profile = path.join(home, 'profiles', 'desktop');
  const old = path.join(root, 'old-code'), newer = path.join(root, 'new-code'), other = path.join(root, 'other-code');
  const cli = path.join(sdkRoot, 'dsh-desktop-host', 'lib', 'cli.js');
  const seed = (directory, name, version) => {
    fs.mkdirSync(path.join(directory, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    fs.writeFileSync(path.join(directory, 'lib', 'index.js'), "throw new Error('The update CLI must not start the plugin runtime');\n");
    fs.writeFileSync(path.join(directory, 'cordis.patch.yml'), '- insert:\n    - id: ' + name + '\n      name: ' + name + '\n');
  };
  const add = directory => {
    const result = spawnSync(executable, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', 'add', directory, '--offline', '--ignore-scripts'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, CI: '1', GIT_TERMINAL_PROMPT: '0' },
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, 'Official isolated plugin add failed: ' + String(result.error || result.stderr || result.stdout).slice(-4000));
  };
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    seed(old, 'dsh-ghost', '1.0.0'); seed(newer, 'dsh-ghost', '1.1.0'); seed(other, 'ghost-fixture-other', '1.0.0');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'fixture-desktop', private: true,
      dependencies: { 'dsh-ghost': 'link:' + old, 'ghost-fixture-other': 'link:' + other },
      dsh: { profile: { bundles: ['dsh-ghost', 'ghost-fixture-other'] } } }));
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '# Keep existing Ghost routing\n');
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# Keep user profile patch\n');
    const coreDir = path.join(home, 'ghost'); fs.mkdirSync(coreDir);
    const coreFiles = ['ghost.sqlite', 'ghost.sqlite-wal', 'ghost.sqlite-shm', 'identity.json'].map(name => path.join(coreDir, name));
    for (const file of coreFiles) fs.writeFileSync(file, 'CORE RECORD SENTINEL ' + path.basename(file));
    const before = coreFiles.map(digest), config = ['cordis.yml', 'cordis.patch.yml'].map(name => [name, digest(path.join(profile, name))]);
    add(old);
    const baseline = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    add(newer);
    const updated = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    const dependency = updated.dependencies['dsh-ghost'];
    const target = path.resolve(profile, dependency.replace(/^(?:link|file):/, ''));
    assert.equal(fs.realpathSync(target), fs.realpathSync(newer));
    assert.equal(fs.realpathSync(path.join(profile, 'node_modules', 'dsh-ghost')), fs.realpathSync(newer));
    assert.equal(updated.dependencies['ghost-fixture-other'], baseline.dependencies['ghost-fixture-other']);
    assert.deepEqual(updated.dsh, baseline.dsh);
    for (const [name, sha] of config) assert.equal(digest(path.join(profile, name)), sha);
    assert.deepEqual(coreFiles.map(digest), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'package.json'), 'utf8')).version, '1.0.0');
    return { status: 'PASS', verified: ['real official same-name add switches code', 'old source retained', 'other plugin/config retained', 'core files byte-identical', 'no plugin runtime execution'] };
  } finally {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('ghost-update-real-cli-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
