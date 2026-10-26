import { PassThrough } from 'node:stream';

/** In-memory HTTP edge for contract tests; this is never used by the plugin. */
export async function invokeRoute(route, action, payload = {}) {
  const req = new PassThrough();
  req.method = 'POST'; req.url = '/ghost/' + action;
  req.headers = { 'content-type': 'application/json' };
  const envelope = { type: 'client-request', rpcId: 'test-rpc', method: action, payload };
  let output, status;
  const res = {
    destroyed: false, headersSent: false,
    writeHead(code) { status = code; this.headersSent = true; },
    end(bytes) { output = bytes ? JSON.parse(String(bytes)) : undefined; },
  };
  const handled = route.handler(req, res);
  req.end(JSON.stringify(envelope));
  await handled;
  if (status !== 200) throw new Error(`Fixture HTTP ${status}: ${JSON.stringify(output)}`);
  return output.result;
}
