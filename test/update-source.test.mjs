import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLatest, fetchUpdateFiles, compareVersions, gitBlobSha, isUpdateCodePath,
  validateUpdateManifest, validateUpdatePatch, UPDATE_REPOSITORY, UPDATE_SOURCE_POLICY } from '../lib/update-source.js';

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
const BLOBS = `${API}/git/blobs/`;
const manifest = (version = '0.5.0') => ({ name: 'dsh-ghost', version, type: 'module', main: 'lib/index.js',
  exports: { '.': './lib/index.js', './client': './lib/client.js', './core': './lib/core.js', './package.json': './package.json' },
  scripts: { test: 'node --test test/*.test.mjs', check: 'node --check lib/index.js', 'pack:local': 'node scripts/pack.mjs' },
  files: ['lib', 'docs', 'scripts', 'test', 'cordis.patch.yml', 'README.md'],
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: {
    inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-connection'], platform: 'web' } } });
function fixture(options = {}) {
  const pkg = options.pkg || manifest(options.version);
  const files = {
    'package.json': JSON.stringify(pkg), 'cordis.patch.yml': '- insert:\n    - id: dsh-ghost\n      name: dsh-ghost\n',
    'README.md': '# Ghost\n', 'lib/index.js': 'export const name="dsh-ghost";\n',
    'lib/core.js': 'export const core=1;\n', 'lib/client.js': '/* UI */\n',
    'scripts/uninstall-worker.mjs': '/* isolated worker */\n',
    'scripts/update-worker.mjs': '/* isolated updater */\n', ...options.files,
  };
  const entries = Object.entries(files).map(([path, value]) => {
    const bytes = Buffer.from(value); return { path, mode: '100644', type: 'blob', size: bytes.length, sha: gitBlobSha(bytes) };
  });
  const tree = { sha: TREE, truncated: false, tree: [...entries, { path: 'docs/ACCEPTANCE.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: 123 }] };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (options.override) { const response = await options.override(url, init, { files, tree }); if (response) return response; }
    let data;
    if (url === `${API}/git/ref/heads/main`) data = { ref: 'refs/heads/main', object: { type: 'commit', sha: COMMIT } };
    else if (url === `${API}/git/commits/${COMMIT}`) data = { sha: COMMIT, tree: { sha: TREE } };
    else if (url === `${API}/contents/package.json?ref=${COMMIT}`) {
      const bytes = Buffer.from(files['package.json']);
      data = { type: 'file', path: 'package.json', encoding: 'base64', size: bytes.length, sha: gitBlobSha(bytes), content: bytes.toString('base64') };
    } else if (url === `${API}/git/trees/${TREE}?recursive=1`) data = tree;
    else if (url.startsWith(BLOBS)) {
      const entry = entries.find(item => item.sha === url.slice(BLOBS.length));
      assert.ok(entry, 'updater requested an unknown blob');
      const bytes = Buffer.from(files[entry.path]);
      data = { sha: entry.sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    } else throw new Error('Unexpected URL ' + url);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  return { pkg, files, tree, entries, calls, fetchImpl,
    check: (currentVersion = '0.4.0', extra = {}) => checkLatest({ currentVersion, fetchImpl, ...extra }),
    download: (extra = {}) => fetchUpdateFiles({ commitSha: COMMIT, expectedVersion: pkg.version, fetchImpl, ...extra }) };
}

test('SemVer compares numeric versions, prereleases and build metadata without precision loss', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(compareVersions('999999999999999999999.0.0', '999999999999999999998.0.0'), 1);
  for (const value of ['v1.0.0', '1.2', '01.2.3', '1.2.3-01', '../1.2.3', '']) assert.throws(() => compareVersions(value, '1.0.0'), { code: 'UPDATE_INVALID_VERSION' });
});

test('checks the fixed public main branch and pins manifest reads to a full commit', async () => {
  const f = fixture(); const result = await f.check();
  assert.equal(result.available, true); assert.equal(result.latestVersion, '0.5.0');
  assert.equal(result.commitSha, COMMIT); assert.equal(result.repository, UPDATE_REPOSITORY);
  assert.ok(f.calls.every(({ url, init }) => url.startsWith(API) && init.method === 'GET'
    && init.credentials === 'omit' && init.redirect === 'manual' && !Object.hasOwn(init.headers, 'Authorization')));
  assert.match(f.calls.at(-1).url, new RegExp('ref=' + COMMIT + '$'));
});

test('never offers a downgrade, same-version replacement or prerelease from main', async () => {
  assert.equal((await fixture().check('0.5.0')).available, false);
  assert.equal((await fixture().check('9.0.0')).available, false);
  const pre = await fixture({ version: '0.6.0-beta.1' }).check();
  assert.equal(pre.available, false); assert.equal(pre.reason, 'prerelease');
  assert.equal((await fixture().check('0.5.0-rc.1')).available, true);
});

test('invalid branch metadata, commit and altered package content fail before staging', async () => {
  const wrongRef = fixture({ override(url) { if (url.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ ref: 'refs/heads/elsewhere', object: { type: 'commit', sha: COMMIT } })); } });
  await assert.rejects(wrongRef.check(), { code: 'UPDATE_INVALID_COMMIT' });
  const wrongCommit = fixture({ override(url) { if (url.endsWith('/git/commits/' + COMMIT)) return new Response(JSON.stringify({ sha: 'd'.repeat(40), tree: { sha: TREE } })); } });
  await assert.rejects(wrongCommit.check(), { code: 'UPDATE_INVALID_COMMIT' });
  const wrongHash = fixture({ override(url, _init, data) {
    if (url.includes('/contents/package.json')) { const bytes = Buffer.from(data.files['package.json']);
      return new Response(JSON.stringify({ type: 'file', path: 'package.json', encoding: 'base64', size: bytes.length, sha: 'd'.repeat(40), content: bytes.toString('base64') })); }
  } });
  await assert.rejects(wrongHash.check(), { code: 'UPDATE_HASH_MISMATCH' });
});

test('downloads only runtime distribution files and verifies every Git blob', async () => {
  const f = fixture(), files = await f.download();
  assert.equal(files.length, 8); assert.ok(files.every(file => Buffer.isBuffer(file.bytes) && gitBlobSha(file.bytes) === file.sha && file.size === file.bytes.length));
  assert.equal(files.some(file => file.path.startsWith('docs/')), false);
  assert.equal(f.calls.some(({ url }) => url.endsWith('/' + 'c'.repeat(40))), false);
  assert.ok(f.calls.filter(({ url }) => url.startsWith(BLOBS)).every(({ url }) => /^[a-f0-9]{40}$/.test(url.slice(BLOBS.length))));
});

test('truncated or missing trees are rejected, never partially installed', async () => {
  const truncated = fixture(); truncated.tree.truncated = true;
  await assert.rejects(truncated.download(), { code: 'UPDATE_INVALID_TREE' });
  const missing = fixture(); missing.tree.tree = missing.tree.tree.filter(item => item.path !== 'lib/core.js');
  await assert.rejects(missing.download(), { code: 'UPDATE_INCOMPLETE' });
});

test('rejects symbolic links, submodules, traversal, data paths and case collisions', async () => {
  for (const item of [
    { path: 'lib/linked.js', mode: '120000', type: 'blob' },
    { path: 'lib/vendor', mode: '160000', type: 'commit' },
    { path: '../ghost.sqlite', mode: '100644', type: 'blob' },
    { path: 'lib/../../ghost.sqlite', mode: '100644', type: 'blob' },
    { path: 'lib\\evil.js', mode: '100644', type: 'blob' },
    { path: '.git/config', mode: '100644', type: 'blob' },
    { path: '.credentials.yaml', mode: '100644', type: 'blob' },
    { path: 'lib/ghost.sqlite', mode: '100644', type: 'blob' },
    { path: 'data/ghost.json', mode: '100644', type: 'blob' },
    { path: 'lib/NUL.js', mode: '100644', type: 'blob' },
    { path: 'LIB/other.js', mode: '100644', type: 'blob' },
    { path: 'lib/index.js', mode: '100644', type: 'blob' },
    { path: 'lib/index.js/nested.js', mode: '100644', type: 'blob' },
  ]) {
    const f = fixture(); f.tree.tree.push({ sha: 'c'.repeat(40), size: 1, ...item });
    await assert.rejects(f.download(), error => /^UPDATE_(?:UNSAFE|PATH_COLLISION)/.test(error.code));
    assert.equal(f.calls.some(({ url }) => url.startsWith(BLOBS)), false);
  }
});

test('metadata and runtime byte/count limits are enforced before downloads or while streaming', async () => {
  const large = fixture(); large.tree.tree[0].size = UPDATE_SOURCE_POLICY.maxFileBytes + 1;
  await assert.rejects(large.download(), { code: 'UPDATE_TOO_LARGE' });
  const many = fixture(); for (let n = 0; n < 128; n++) many.tree.tree.push({ path: `lib/extra-${n}.js`, type: 'blob', mode: '100644', sha: 'c'.repeat(40), size: 0 });
  await assert.rejects(many.download(), { code: 'UPDATE_TOO_LARGE' });
  const hugeResponse = fixture({ override(url) { if (url.endsWith('/git/ref/heads/main')) return new Response('x', { headers: { 'content-length': String(UPDATE_SOURCE_POLICY.maxMetadataBytes + 1) } }); } });
  await assert.rejects(hugeResponse.check(), { code: 'UPDATE_TOO_LARGE' });
});

test('modified source bytes or changed package versions are refused', async () => {
  const f = fixture({ override(url) { if (url === BLOBS + gitBlobSha(Buffer.from('export const core=1;\n'))) {
    const bytes = Buffer.from('tampered code'); return new Response(JSON.stringify({ sha: url.slice(BLOBS.length), size: bytes.length, encoding: 'base64', content: bytes.toString('base64') })); }
  } });
  await assert.rejects(f.download(), { code: 'UPDATE_HASH_MISMATCH' });
  await assert.rejects(fixture().download({ expectedVersion: '0.7.0' }), { code: 'UPDATE_VERSION_CHANGED' });
});

test('network, HTTP and redirect errors are explicit and do not follow external hosts', async () => {
  const offline = fixture({ override() { throw new Error('private proxy URL must not leak'); } });
  await assert.rejects(offline.check(), error => error.code === 'UPDATE_NETWORK_ERROR' && !error.message.includes('proxy'));
  for (const [status, code] of [[403, 'UPDATE_RATE_LIMIT'], [429, 'UPDATE_RATE_LIMIT'], [404, 'UPDATE_NOT_FOUND'], [500, 'UPDATE_HTTP_ERROR'], [302, 'UPDATE_REDIRECT']]) {
    const f = fixture({ override() { return new Response('', { status, headers: { Location: 'https://untrusted.example/' } }); } });
    await assert.rejects(f.check(), { code }); assert.equal(f.calls.length, 1);
  }
});

test('stream failures and implicit final-host redirects fail with safe network errors', async () => {
  const stream = fixture({ override() { return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private stream detail')); } })); } });
  await assert.rejects(stream.check(), error => error.code === 'UPDATE_NETWORK_ERROR' && !error.message.includes('private'));
  const wrongHost = fixture({ override() { const response = new Response('{}'); Object.defineProperty(response, 'url', { value: 'https://untrusted.example/response' }); return response; } });
  await assert.rejects(wrongHost.check(), { code: 'UPDATE_REDIRECT' });
});

test('abort and timeout terminate an unresponsive fetch implementation', async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(fixture().check('0.4.0', { signal: aborted.signal }), { code: 'UPDATE_CANCELLED' });
  const never = fixture({ override() { return new Promise(() => {}); } });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(never.check('0.4.0', { timeoutMs: 10 }), { code: 'UPDATE_TIMEOUT' }); }
  finally { clearTimeout(keepAlive); }
});

test('package validation permits development scripts but rejects installation hooks and external dependencies', () => {
  assert.equal(validateUpdateManifest(manifest()).version, '0.5.0');
  for (const key of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    assert.throws(() => validateUpdateManifest({ ...manifest(), [key]: { unexpected: 'https://untrusted.example/code' } }), { code: 'UPDATE_UNSUPPORTED_PACKAGE' });
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'pnpm:devPreinstall']) {
    assert.throws(() => validateUpdateManifest({ ...manifest(), scripts: { [hook]: 'run arbitrary command' } }), { code: 'UPDATE_UNSUPPORTED_PACKAGE' });
  }
  for (const key of ['workspaces', 'packageManager', 'pnpm', 'bin', 'overrides', 'resolutions']) {
    assert.throws(() => validateUpdateManifest({ ...manifest(), [key]: {} }), { code: 'UPDATE_UNSUPPORTED_PACKAGE' });
  }
  assert.throws(() => validateUpdateManifest({ ...manifest(), main: '../ghost/core.js' }), { code: 'UPDATE_UNSUPPORTED_PACKAGE' });
  assert.throws(() => validateUpdateManifest({ ...manifest(), engines: { node: '>=99.0.0' } }), { code: 'UPDATE_UNSUPPORTED_PACKAGE' });
  assert.throws(() => validateUpdateManifest({ ...manifest(), dsh: { ...manifest().dsh, config: { dataDir: '/other-memory' } } }), { code: 'UPDATE_UNSUPPORTED_PACKAGE' });
});

test('downloaded package hooks and Ghost path-changing patches are refused after integrity verification', async () => {
  await assert.rejects(fixture({ pkg: { ...manifest(), scripts: { postinstall: 'bad hook' } } }).download(), { code: 'UPDATE_UNSUPPORTED_PACKAGE' });
  await assert.rejects(fixture({ files: { 'cordis.patch.yml': '- insert:\n    - id: dsh-ghost\n      name: dsh-ghost\n      config:\n        dataDir: /other\n' } }).download(), { code: 'UPDATE_UNSUPPORTED_PATCH' });
  assert.doesNotThrow(() => validateUpdatePatch('- insert:\r\n    - id: dsh-ghost\r\n      name: dsh-ghost\r\n'));
  assert.throws(() => validateUpdatePatch('- insert:\n    - id: dsh-ghost\n      name: dsh-ghost\n    - id: other\n      name: other\n'), { code: 'UPDATE_UNSUPPORTED_PATCH' });
});

test('code path allowlist includes future module subdirectories and excludes all record exports', () => {
  assert.equal(isUpdateCodePath('lib/future/helper.js'), true);
  assert.equal(isUpdateCodePath('scripts/update-worker.mjs'), true);
  assert.equal(isUpdateCodePath('scripts/pack.mjs'), false);
  assert.equal(isUpdateCodePath('docs/ACCEPTANCE.md'), false);
  for (const path of ['ghost.sqlite', '.env', 'lib/foo.js ', 'C:/ghost.js', 'lib/%2e%2e/ghost.js']) assert.throws(() => isUpdateCodePath(path), { code: 'UPDATE_UNSAFE_PATH' });
});
