// DSH 0.2.0's nested connection.rpc.handle captures the provider context and
// cannot access webServer through Cordis dependency tracing. Register the same
// wire protocol from our own injected context; Connection still owns trust/auth.
const MAX_BODY = 65536;
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });

function json(res, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Content-Length': bytes.length,
    'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request exceeds 64 KiB'), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); }
    });
    req.once('error', error => { if (!done) { done = true; reject(error); } });
    req.once('aborted', () => {
      if (!done) { done = true; reject(Object.assign(new Error('Request aborted'), { status: 400 })); }
    });
  });
}

export function registerGhostRpc(ctx, handler) {
  return ctx.webServer.register({ kind: 'prefix', path: '/ghost', handler: async (req, res) => {
    let rejection;
    try {
      if (typeof ctx.connection.requestRejection !== 'function') {
        req.resume();
        json(res, 503, failure('UNAVAILABLE', 'Host authentication is unavailable')); return;
      }
      rejection = ctx.connection.requestRejection(req);
    } catch {
      req.resume();
      json(res, 503, failure('UNAVAILABLE', 'Host authentication failed')); return;
    }
    if (rejection !== undefined && rejection !== null && rejection !== false) {
      req.resume();
      res.writeHead(rejection === 401 ? 401 : 403, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.method !== 'POST') { req.resume(); json(res, 405, failure('METHOD_NOT_ALLOWED', 'POST required')); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      req.resume(); json(res, 415, failure('CONTENT_TYPE', 'application/json required')); return;
    }
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume(); json(res, 413, failure('REQUEST_TOO_LARGE', 'Request exceeds 64 KiB')); return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const match = /^\/ghost\/([a-z]+)$/.exec(pathname);
    if (!match) { req.resume(); json(res, 404, failure('NOT_FOUND', 'Unknown Ghost endpoint')); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    try {
      const request = JSON.parse(await readBody(req));
      if (request?.type !== 'client-request' || typeof request.rpcId !== 'string'
        || !request.rpcId.length || request.rpcId.length > 128 || request.method !== match[1]) {
        json(res, 400, failure('INVALID_REQUEST', 'Invalid Connection RPC envelope')); return;
      }
      const result = await handler(match[1], request.payload, controller.signal);
      if (!res.destroyed) json(res, 200, { type: 'server-response', rpcId: request.rpcId, result });
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        const status = error.status || (error instanceof SyntaxError ? 400 : 500);
        json(res, status, failure('INVALID_REQUEST', status === 500 ? 'Ghost transport failed' : error.message));
      }
    } finally { req.removeListener('aborted', abort); }
  } });
}
