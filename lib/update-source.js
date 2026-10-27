import { createHash } from 'node:crypto';

export const UPDATE_REPOSITORY = 'fantasysummer01-bit/dsh-deepseek-harness-agent-ghost';
export const UPDATE_SOURCE_POLICY = Object.freeze({ maxFiles: 128, maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024, maxMetadataBytes: 1024 * 1024, maxTreeEntries: 4096,
  requestTimeoutMs: 15000, operationTimeoutMs: 120000 });
const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare',
  'postprepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish', 'preversion', 'version', 'postversion', 'pnpm:devPreinstall']);
const REQUIRED = ['package.json', 'cordis.patch.yml', 'README.md', 'lib/index.js', 'lib/core.js',
  'lib/client.js', 'scripts/uninstall-worker.mjs'];
const forbiddenPart = /^(?:\.git|node_modules|\.runtime|artifacts|\.dsh|data)$/i;
const unsafeLeaf = /^(?:\.env(?:\.|$)|\.credentials)|\.(?:sqlite|db)(?:-|$)/i;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(value, code, message) { if (!value) fail(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function version(value) {
  check(typeof value === 'string' && value.length <= 128, 'UPDATE_INVALID_VERSION', '版本格式无效');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  check(match, 'UPDATE_INVALID_VERSION', '版本必须使用完整的 SemVer 格式');
  const pre = match[4]?.split('.') || [];
  check(pre.every(item => !/^\d+$/.test(item) || item === '0' || !item.startsWith('0')), 'UPDATE_INVALID_VERSION', '预发布版本格式无效');
  return { core: match.slice(1, 4).map(BigInt), pre };
}

/** SemVer ordering, including prereleases; build metadata does not change order. */
export function compareVersions(left, right) {
  const a = version(left), b = version(right);
  for (let n = 0; n < 3; n++) if (a.core[n] !== b.core[n]) return a.core[n] > b.core[n] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let n = 0; n < Math.max(a.pre.length, b.pre.length); n++) {
    if (a.pre[n] === undefined || b.pre[n] === undefined) return a.pre[n] === undefined ? -1 : 1;
    if (a.pre[n] === b.pre[n]) continue;
    const x = /^\d+$/.test(a.pre[n]), y = /^\d+$/.test(b.pre[n]);
    if (x && y) return BigInt(a.pre[n]) > BigInt(b.pre[n]) ? 1 : -1;
    if (x !== y) return x ? -1 : 1;
    return a.pre[n] > b.pre[n] ? 1 : -1;
  }
  return 0;
}

export function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function safePath(path) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 240 && !/[\\:\x00-\x1f\x7f%]/.test(path)
    && !path.startsWith('/'), 'UPDATE_UNSAFE_PATH', '更新清单含不安全路径');
  const parts = path.split('/');
  check(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !forbiddenPart.test(part) && !unsafeLeaf.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
  'UPDATE_UNSAFE_PATH', '更新清单不能包含数据、凭据或保留路径');
  return path;
}

export function isUpdateCodePath(path) {
  safePath(path);
  return ['package.json', 'cordis.patch.yml', 'README.md'].includes(path)
    || /^lib\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/.test(path)
    || /^scripts\/(?:uninstall-worker|update-worker)\.mjs$/.test(path);
}

/** Keep installation metadata from introducing dependencies or executing hooks. */
export function validateUpdateManifest(pkg, { expectedVersion } = {}) {
  check(object(pkg) && pkg.name === 'dsh-ghost' && pkg.type === 'module', 'UPDATE_INVALID_PACKAGE', '更新包不是兼容的 Ghost 插件');
  version(pkg.version);
  if (expectedVersion !== undefined) check(pkg.version === expectedVersion, 'UPDATE_VERSION_CHANGED', '下载版本与检查到的版本不一致');
  for (const key of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    check(pkg[key] === undefined || object(pkg[key]) && !Object.keys(pkg[key]).length,
      'UPDATE_UNSUPPORTED_PACKAGE', '此更新包含额外依赖，需要手动安装');
  }
  for (const key of ['bundledDependencies', 'bundleDependencies']) check(pkg[key] === undefined || Array.isArray(pkg[key]) && !pkg[key].length,
    'UPDATE_UNSUPPORTED_PACKAGE', '此更新包含额外依赖，需要手动安装');
  check(pkg.scripts === undefined || object(pkg.scripts), 'UPDATE_INVALID_PACKAGE', '更新包脚本声明无效');
  check(!Object.keys(pkg.scripts || {}).some(name => LIFECYCLE.has(name)), 'UPDATE_UNSUPPORTED_PACKAGE', '此更新包含安装生命周期脚本，需要手动安装');
  for (const key of ['workspaces', 'packageManager', 'pnpm', 'overrides', 'resolutions', 'bin', 'directories', 'gypfile']) {
    check(!Object.hasOwn(pkg, key), 'UPDATE_UNSUPPORTED_PACKAGE', '此更新的安装结构需要手动处理');
  }
  check(pkg.main === 'lib/index.js', 'UPDATE_UNSUPPORTED_PACKAGE', '此更新更改了插件入口，需要手动安装');
  const expectedExports = { '.': './lib/index.js', './client': './lib/client.js', './core': './lib/core.js', './package.json': './package.json' };
  check(object(pkg.exports) && Object.keys(pkg.exports).length === Object.keys(expectedExports).length
    && Object.entries(expectedExports).every(([key, value]) => pkg.exports[key] === value),
  'UPDATE_UNSUPPORTED_PACKAGE', '此更新更改了模块入口，需要手动安装');
  check(object(pkg.dsh) && Object.keys(pkg.dsh).every(key => ['bundle', 'client'].includes(key))
    && object(pkg.dsh.bundle) && Object.keys(pkg.dsh.bundle).length === 1 && pkg.dsh.bundle.patch === './cordis.patch.yml'
    && object(pkg.dsh.client) && Object.keys(pkg.dsh.client).every(key => ['inject', 'platform'].includes(key))
    && pkg.dsh.client.platform === 'web' && Array.isArray(pkg.dsh.client.inject)
    && pkg.dsh.client.inject.length === 2 && pkg.dsh.client.inject[0] === '@deepseek-ai/dsh-client-ui-settings'
    && pkg.dsh.client.inject[1] === '@deepseek-ai/dsh-client-connection',
  'UPDATE_UNSUPPORTED_PACKAGE', '此更新更改了宿主配置，需要手动安装');
  if (pkg.files !== undefined) check(Array.isArray(pkg.files) && pkg.files.every(file =>
    ['lib', 'docs', 'scripts', 'test', 'cordis.patch.yml', 'README.md'].includes(file)),
  'UPDATE_UNSUPPORTED_PACKAGE', '更新包包含不兼容的文件声明');
  if (pkg.engines !== undefined) check(object(pkg.engines) && Object.keys(pkg.engines).every(key => key === 'node')
    && pkg.engines.node === '>=24.0.0', 'UPDATE_UNSUPPORTED_PACKAGE', '此更新的运行环境要求需要手动检查');
  return pkg;
}

export function validateUpdatePatch(text) {
  check(typeof text === 'string' && text.length <= 4096
    && /^\s*-\s*insert:\s*\r?\n\s+-\s*id:\s*dsh-ghost\s*\r?\n\s+name:\s*dsh-ghost\s*$/.test(text),
  'UPDATE_UNSUPPORTED_PATCH', '更新不能更改 Ghost 数据路径或添加其他插件配置');
}

function timeoutSignal(signal, timeoutMs) {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= UPDATE_SOURCE_POLICY.operationTimeoutMs,
    'UPDATE_INVALID_REQUEST', '更新超时时间无效');
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('更新请求已取消或超时'), { code: signal.reason?.name === 'TimeoutError' ? 'UPDATE_TIMEOUT' : 'UPDATE_CANCELLED' }));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function requestFailure(error, signal) {
  if (error.code?.startsWith('UPDATE_')) throw error;
  if (signal.aborted) fail(signal.reason?.name === 'TimeoutError' ? 'UPDATE_TIMEOUT' : 'UPDATE_CANCELLED', '更新请求已取消或超时');
  fail('UPDATE_NETWORK_ERROR', '无法连接 GitHub，请检查网络后重试');
}
async function bytesAt(url, { fetchImpl, signal, maximum }) {
  const expected = new URL(url);
  check(expected.protocol === 'https:' && expected.hostname === 'api.github.com'
    && !expected.username && !expected.password && !expected.port, 'UPDATE_UNSAFE_URL', '更新地址无效');
  const requestSignal = timeoutSignal(signal, UPDATE_SOURCE_POLICY.requestTimeoutMs);
  if (requestSignal.aborted) requestFailure({}, requestSignal);
  let response;
  try {
    response = await abortable(fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dsh-ghost-updater' },
      signal: requestSignal }), requestSignal);
  } catch (error) {
    requestFailure(error, requestSignal);
  }
  check(response && Number.isInteger(response.status), 'UPDATE_INVALID_RESPONSE', 'GitHub 返回了无效响应');
  check(!response.redirected && !(response.status >= 300 && response.status < 400)
    && (!response.url || response.url === url), 'UPDATE_REDIRECT', '更新下载不接受重定向');
  if ([403, 429].includes(response.status)) fail('UPDATE_RATE_LIMIT', 'GitHub 暂时拒绝请求或访问过于频繁，请稍后重试');
  check(response.status >= 200 && response.status < 300, response.status === 404 ? 'UPDATE_NOT_FOUND' : 'UPDATE_HTTP_ERROR', `GitHub 请求失败（HTTP ${response.status}）`);
  const declared = response.headers?.get('content-length');
  check(declared === null || declared === undefined || /^\d+$/.test(declared) && Number(declared) <= maximum,
    'UPDATE_TOO_LARGE', '更新响应超过大小限制');
  const reader = response.body?.getReader?.();
  if (!reader) {
    check(typeof response.arrayBuffer === 'function', 'UPDATE_INVALID_RESPONSE', '更新响应正文无效');
    let data;
    try { data = Buffer.from(await abortable(response.arrayBuffer(), requestSignal)); }
    catch (error) { requestFailure(error, requestSignal); }
    check(data.length <= maximum, 'UPDATE_TOO_LARGE', '更新响应超过大小限制');
    return data;
  }
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), requestSignal);
      if (part.done) break;
      const chunk = Buffer.from(part.value); length += chunk.length;
      check(length <= maximum, 'UPDATE_TOO_LARGE', '更新响应超过大小限制'); chunks.push(chunk);
    }
  } catch (error) { void reader.cancel().catch(() => {}); requestFailure(error, requestSignal); }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
async function jsonAt(url, options, maximum = UPDATE_SOURCE_POLICY.maxMetadataBytes) {
  const data = await bytesAt(url, { ...options, maximum });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { fail('UPDATE_INVALID_RESPONSE', 'GitHub 返回了无效 JSON'); }
}
function validCommit(sha) { check(typeof sha === 'string' && SHA.test(sha), 'UPDATE_INVALID_COMMIT', '更新提交标识无效'); }
async function commitTree(commitSha, options) {
  validCommit(commitSha);
  const commit = await jsonAt(`${API}/git/commits/${commitSha}`, options);
  check(commit?.sha === commitSha && typeof commit.tree?.sha === 'string' && SHA.test(commit.tree.sha),
    'UPDATE_INVALID_COMMIT', 'GitHub 提交与检查的版本不一致');
  return commit.tree.sha;
}
function decodeBlob(content, { expectedSha, expectedSize } = {}) {
  check(object(content) && content.encoding === 'base64'
    && typeof content.content === 'string' && typeof content.sha === 'string' && SHA.test(content.sha)
    && Number.isSafeInteger(content.size) && content.size >= 0 && content.size <= UPDATE_SOURCE_POLICY.maxFileBytes,
  'UPDATE_INVALID_RESPONSE', 'GitHub 文件信息无效');
  check((expectedSha === undefined || content.sha === expectedSha) && (expectedSize === undefined || content.size === expectedSize),
    'UPDATE_HASH_MISMATCH', '更新文件与清单不一致');
  const encoded = content.content.replace(/[\r\n]/g, '');
  check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), 'UPDATE_INVALID_RESPONSE', '更新文件编码无效');
  const bytes = Buffer.from(encoded, 'base64');
  check(bytes.length === content.size && gitBlobSha(bytes) === content.sha, 'UPDATE_HASH_MISMATCH', '更新文件完整性校验失败');
  return bytes;
}
function decodePackage(content) {
  check(object(content) && content.type === 'file' && content.path === 'package.json', 'UPDATE_INVALID_PACKAGE', 'GitHub 包信息无效');
  const bytes = decodeBlob(content);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('UPDATE_INVALID_PACKAGE', '包信息 JSON 无效'); }
}

/** A user-initiated check; fixed public repository, no credentials or user data. */
export async function checkLatest({ currentVersion, fetchImpl = globalThis.fetch, signal,
  timeoutMs = UPDATE_SOURCE_POLICY.operationTimeoutMs } = {}) {
  version(currentVersion);
  check(typeof fetchImpl === 'function', 'UPDATE_NETWORK_UNAVAILABLE', '此运行环境不支持更新下载');
  const options = { fetchImpl, signal: timeoutSignal(signal, timeoutMs) };
  const ref = await jsonAt(`${API}/git/ref/heads/main`, options);
  check(ref?.ref === 'refs/heads/main' && ref.object?.type === 'commit', 'UPDATE_INVALID_COMMIT', 'GitHub 主分支信息无效');
  const commitSha = ref.object.sha; const treeSha = await commitTree(commitSha, options);
  const pkg = validateUpdateManifest(decodePackage(await jsonAt(`${API}/contents/package.json?ref=${commitSha}`, options)));
  const stable = version(pkg.version).pre.length === 0;
  const available = stable && compareVersions(pkg.version, currentVersion) > 0;
  return { currentVersion, latestVersion: pkg.version, commitSha, treeSha, available,
    reason: available ? 'newer' : stable ? 'not_newer' : 'prerelease',
    repository: UPDATE_REPOSITORY, url: `https://github.com/${UPDATE_REPOSITORY}/commit/${commitSha}` };
}

/** Download authenticated Git blobs into memory, never write a core/data path. */
export async function fetchUpdateFiles({ commitSha, expectedVersion, fetchImpl = globalThis.fetch, signal,
  timeoutMs = UPDATE_SOURCE_POLICY.operationTimeoutMs } = {}) {
  validCommit(commitSha);
  check(version(expectedVersion).pre.length === 0, 'UPDATE_INVALID_VERSION', '自动更新只安装稳定版本');
  check(typeof fetchImpl === 'function', 'UPDATE_NETWORK_UNAVAILABLE', '此运行环境不支持更新下载');
  const options = { fetchImpl, signal: timeoutSignal(signal, timeoutMs) };
  const treeSha = await commitTree(commitSha, options);
  const tree = await jsonAt(`${API}/git/trees/${treeSha}?recursive=1`, options);
  check(tree?.sha === treeSha && tree.truncated === false && Array.isArray(tree.tree)
    && tree.tree.length <= UPDATE_SOURCE_POLICY.maxTreeEntries, 'UPDATE_INVALID_TREE', '更新文件清单不完整或过大');
  const selected = [], paths = new Map(), types = new Map(); let total = 0;
  for (const item of tree.tree) {
    safePath(item?.path);
    const parts = item.path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const path = parts.slice(0, n).join('/'), key = path.toLowerCase();
      check(!paths.has(key) || paths.get(key) === path, 'UPDATE_PATH_COLLISION', '更新文件名存在大小写冲突'); paths.set(key, path);
    }
    check(item.type === 'tree' && item.mode === '040000' || item.type === 'blob' && ['100644', '100755'].includes(item.mode),
      'UPDATE_UNSAFE_TREE', '更新文件不能是符号链接或子模块');
    check(typeof item.sha === 'string' && SHA.test(item.sha), 'UPDATE_INVALID_TREE', '更新文件标识无效');
    types.set(item.path, item.type);
    if (item.type === 'tree' || !isUpdateCodePath(item.path)) continue;
    check(Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= UPDATE_SOURCE_POLICY.maxFileBytes,
      'UPDATE_TOO_LARGE', '更新文件超过大小限制');
    total += item.size; selected.push(item);
    check(total <= UPDATE_SOURCE_POLICY.maxTotalBytes && selected.length <= UPDATE_SOURCE_POLICY.maxFiles,
      'UPDATE_TOO_LARGE', '更新包超过大小限制');
  }
  check(new Set(tree.tree.map(item => item.path)).size === tree.tree.length, 'UPDATE_PATH_COLLISION', '更新清单有重复路径');
  for (const item of tree.tree) {
    const parts = item.path.split('/');
    for (let n = 1; n < parts.length; n++) check(types.get(parts.slice(0, n).join('/')) !== 'blob',
      'UPDATE_PATH_COLLISION', '更新路径不能同时作为文件和目录');
  }
  check(REQUIRED.every(path => selected.some(item => item.path === path)), 'UPDATE_INCOMPLETE', '更新包缺少必要的插件文件');
  const files = [], blobs = new Map();
  // Bounded parallelism, with a single operation timeout and no code execution.
  for (let n = 0; n < selected.length; n += 4) files.push(...await Promise.all(selected.slice(n, n + 4).map(async item => {
    if (!blobs.has(item.sha)) blobs.set(item.sha, (async () => {
      // GitHub's Git Blob API is usable where the separate raw domain is not.
      // Base64 JSON is still bounded before decoding and checked against the
      // exact blob selected by this commit's tree, never a mutable branch URL.
      const content = await jsonAt(`${API}/git/blobs/${item.sha}`, options,
        Math.ceil(UPDATE_SOURCE_POLICY.maxFileBytes * 1.4) + 8192);
      return decodeBlob(content, { expectedSha: item.sha, expectedSize: item.size });
    })());
    const bytes = Buffer.from(await blobs.get(item.sha));
    check(bytes.length === item.size, 'UPDATE_HASH_MISMATCH', '更新文件与清单不一致');
    return { path: item.path, bytes, sha: item.sha, size: bytes.length };
  })));
  let pkg;
  try { pkg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.find(file => file.path === 'package.json').bytes)); }
  catch { fail('UPDATE_INVALID_PACKAGE', '更新包 JSON 无效'); }
  validateUpdateManifest(pkg, { expectedVersion });
  validateUpdatePatch(new TextDecoder('utf-8', { fatal: true }).decode(files.find(file => file.path === 'cordis.patch.yml').bytes));
  return files;
}
