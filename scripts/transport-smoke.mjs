import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Ghost from '../lib/index.js';
import { GhostStore } from '../lib/core.js';

const ACTIVE = 2;
const DISPOSED = 4;
async function loadSdk(root, name) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
  const module = await import(pathToFileURL(path.resolve(root, name, metadata.main || 'lib/index.js')).href);
  return { metadata, module };
}

/**
 * Real loopback HTTP + Connection authentication/RPC, with no transport mocks.
 * Only a temporary index route is supplied so real BrowserAuth can exchange its
 * launch token for a signed cookie. Auth material is never printed or retained.
 * All credentials and Ghost data live under a fresh OS temporary directory.
 */
export async function runTransportSmoke({ sdkRoot = process.env.DSH_SDK_ROOT } = {}) {
  if (!sdkRoot) {
    return { status: 'SKIP', reason: 'DSH_SDK_ROOT is unset; real HTTP/Connection transport was not tested. This is not a pass.' };
  }
  const root = path.resolve(sdkRoot);
  const [cordisSdk, sessionSdk, promptSdk, webSdk, connectionSdk, credentialSdk] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-system-prompt', 'dsh-host-webserver', 'dsh-client-connection', 'dsh-credentials-local',
  ].map(name => loadSdk(root, name)));
  const { Context } = cordisSdk.module;
  const { SessionStore } = sessionSdk.module;
  const { SystemPrompt } = promptSdk.module;
  const { WebServer } = webSdk.module;
  const { LocalCredentialProvider } = credentialSdk.module;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ghost-http-'));
  const dataDir = path.join(workspace, 'ghost-data');
  const ctx = new Context();
  let ghostFiber;
  let reopened;
  let removeIndex;
  const httpStatus = {};
  try {
    const credentialFiber = ctx.plugin(LocalCredentialProvider, {
      path: path.join(workspace, '.credentials.yaml'), dshHome: workspace, watch: false,
    });
    const sessionFiber = ctx.plugin(SessionStore);
    const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
    const webFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
    await Promise.all([credentialFiber.await(), sessionFiber.await(), promptFiber.await(), webFiber.await()]);
    for (const [label, fiber] of Object.entries({ credentials: credentialFiber, sessions: sessionFiber, systemPrompt: promptFiber, webServer: webFiber })) {
      assert.equal(fiber.state, ACTIVE, `${label} did not become active; state=${fiber.state}`);
    }
    const connectionFiber = ctx.plugin(connectionSdk.module, {
      cookieMaxAgeDays: 1, maxRequestBodyBytes: 65536, trustedHosts: [],
    });
    await connectionFiber.await();
    assert.equal(connectionFiber.state, ACTIVE, `real Connection did not activate; state=${connectionFiber.state}`);
    assert.equal(ctx.webServer.host, '127.0.0.1');
    assert.ok(Number.isSafeInteger(ctx.webServer.port) && ctx.webServer.port > 0, 'real loopback server did not bind a port');
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    removeIndex = ctx.webServer.register({
      kind: 'exact', path: '/', handler(req, res) {
        if (!ctx.connection.authorizeIndex(req, res)) return;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Ghost transport smoke');
      },
    });
    ghostFiber = ctx.plugin(Ghost, { dataDir });
    await ghostFiber.await();
    assert.equal(ghostFiber.state, ACTIVE, `Ghost did not apply to real Connection; state=${ghostFiber.state}`);

    const request = async (endpoint, payload = {}, headers = {}) => {
      const rpcId = randomUUID();
      const response = await fetch(`${base}/ghost/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
        signal: AbortSignal.timeout(5000), redirect: 'manual',
      });
      const raw = await response.text();
      let envelope;
      try { envelope = JSON.parse(raw); } catch { /* A failing carrier can return text or an empty body. */ }
      return { response, raw, envelope, rpcId };
    };
    const unauthenticated = await request('status');
    httpStatus.unauthenticated = unauthenticated.response.status;
    assert.equal(unauthenticated.response.status, 401, 'real Connection did not require browser authentication');

    // This exchange is the real Connection BrowserAuth implementation. The
    // random launch token and cookie are kept in memory and never logged.
    const exchange = await fetch(ctx.connection.authenticatedUrl(base + '/'), {
      redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    httpStatus.tokenExchange = exchange.status;
    await exchange.arrayBuffer();
    assert.equal(exchange.status, 303, 'real launch-token exchange did not redirect');
    const setCookie = exchange.headers.get('set-cookie');
    assert.ok(setCookie, 'real launch-token exchange did not issue a signed browser cookie');
    const cookie = setCookie.split(';', 1)[0];
    const browserHeaders = { cookie, origin: base, 'sec-fetch-site': 'same-origin' };
    const status = await request('status', {}, browserHeaders);
    httpStatus.status = status.response.status;
    assert.equal(status.response.status, 200, `POST /ghost/status failed with HTTP ${status.response.status}`);
    assert.equal(status.envelope?.type, 'server-response');
    assert.equal(status.envelope.rpcId, status.rpcId);
    assert.equal(status.envelope.result?.ok, true, 'real authenticated RPC returned an error');
    assert.equal(status.envelope.result.value.health.ok, true);
    const initial = status.envelope.result.value;
    const configure = await request('configure', {
      expectedVersion: initial.version, patch: { name: 'Ghost transport smoke' },
    }, browserHeaders);
    httpStatus.configure = configure.response.status;
    assert.equal(configure.response.status, 200);
    assert.equal(configure.envelope?.result?.ok, true);
    assert.equal(configure.envelope.result.value.name, 'Ghost transport smoke');
    assert.equal(configure.envelope.result.value.settings.captureEnabled, false);
    const stale = await request('configure', {
      expectedVersion: initial.version, patch: { name: 'stale overwrite' },
    }, browserHeaders);
    assert.equal(stale.envelope.result.ok, false);
    assert.equal(stale.envelope.result.error.code, 'VERSION_CONFLICT');
    const wrongMethod = await fetch(`${base}/ghost/status`, {
      headers: browserHeaders, signal: AbortSignal.timeout(5000),
    });
    httpStatus.wrongMethod = wrongMethod.status;
    await wrongMethod.arrayBuffer();
    assert.equal(wrongMethod.status, 405);
    const wrongType = await fetch(`${base}/ghost/status`, {
      method: 'POST', headers: { ...browserHeaders, 'content-type': 'text/plain' }, body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    httpStatus.wrongContentType = wrongType.status;
    await wrongType.arrayBuffer();
    assert.equal(wrongType.status, 415);
    const malformed = await fetch(`${base}/ghost/status`, {
      method: 'POST', headers: { ...browserHeaders, 'content-type': 'application/json' }, body: '{',
      signal: AbortSignal.timeout(5000),
    });
    httpStatus.malformed = malformed.status;
    await malformed.arrayBuffer();
    assert.equal(malformed.status, 400);
    const oversized = await fetch(`${base}/ghost/configure`, {
      method: 'POST', headers: { ...browserHeaders, 'content-type': 'application/json' }, body: 'x'.repeat(70000),
      signal: AbortSignal.timeout(5000),
    });
    httpStatus.oversized = oversized.status;
    await oversized.arrayBuffer();
    assert.equal(oversized.status, 413);
    const crossOrigin = await request('status', {}, { ...browserHeaders, origin: 'https://outside.invalid' });
    httpStatus.crossOrigin = crossOrigin.response.status;
    assert.equal(crossOrigin.response.status, 403, 'real Connection did not enforce its Origin fence');

    await ghostFiber.dispose();
    assert.equal(ghostFiber.state, DISPOSED);
    const unloaded = await request('status', {}, browserHeaders);
    httpStatus.afterUnload = unloaded.response.status;
    assert.equal(unloaded.response.status, 404, 'Ghost RPC route survived real fiber unload');
    reopened = new GhostStore({ dataDir });
    assert.equal(reopened.status().health.ok, true, 'writer lease survived real Connection/fiber unload');
    assert.equal(reopened.status().ghostId, initial.ghostId);
    assert.equal(reopened.status().name, 'Ghost transport smoke');
    reopened.close();
    reopened = undefined;
    return {
      status: 'PASS', suite: 'real-cordis-http-transport',
      sdkVersions: {
        cordis: cordisSdk.metadata.version, session: sessionSdk.metadata.version,
        systemPrompt: promptSdk.metadata.version, webServer: webSdk.metadata.version,
        connection: connectionSdk.metadata.version, credentials: credentialSdk.metadata.version,
      },
      node: process.version, httpStatus,
      verified: ['real loopback WebServer', 'real local credential provider in temporary directory',
        'real Connection auth token/cookie exchange', 'authenticated POST /ghost/status',
        'authenticated configure with version', '401 without cookie', '403 foreign Origin',
        '404 after plugin unload', 'writer lease released'],
      limits: 'Isolated Host stack only; this does not exercise the desktop renderer, its production profile, IPC or an LLM conversation.',
    };
  } finally {
    reopened?.close();
    if (ghostFiber && ghostFiber.state !== DISPOSED) await ghostFiber.dispose();
    removeIndex?.();
    await ctx.fiber.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(JSON.stringify(await runTransportSmoke(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`FAIL real-cordis-http-transport: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
