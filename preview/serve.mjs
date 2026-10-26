import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const relative = url.pathname === '/' ? 'preview/index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  // A preview never serves state, profiles, arbitrary workspace files or secrets.
  if (!['preview/index.html', 'lib/client.js'].includes(relative) || !file.startsWith(root + path.sep)) {
    response.writeHead(404); response.end(); return;
  }
  const content = fs.readFileSync(file);
  response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(content);
});
server.listen(Number(process.env.GHOST_PREVIEW_PORT || 8768), '127.0.0.1', () => console.log(`Ghost preview: http://127.0.0.1:${server.address().port}`));
