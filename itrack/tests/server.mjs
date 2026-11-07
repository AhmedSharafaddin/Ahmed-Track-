// خادم اختبار محلي: الواجهة + خادم ITrack (الـWorker نفسه فوق node:sqlite) + موقّع رموز وهمي.
// node --experimental-sqlite itrack/tests/server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeD1, makeTokens } from './d1shim.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const W = (await import('../worker/worker.js')).default;
const { jwk, token } = makeTokens();
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => (String(u).includes('jwks.test') ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(u, o));
const env = { DB: makeD1(process.env.DBFILE || ':memory:'), JWKS_URL: 'https://jwks.test/keys' };
const port = Number(process.argv[2] || 8797);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/__token') { res.end(token({ uid: url.searchParams.get('uid'), email: url.searchParams.get('email'), verified: url.searchParams.get('v') === '1' })); return; }
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await W.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  // /Ahmed-Track-/... يحاكي GitHub Pages: الجذر = مركز القيادة، و/itrack/ = ITrack (صفحة /itrack/my/ تستورد ../../js)
  let base = root; let p;
  if (url.pathname.startsWith('/Ahmed-Track-/itrack/')) p = url.pathname.slice('/Ahmed-Track-/itrack'.length);
  else if (url.pathname.startsWith('/Ahmed-Track-/')) { base = path.resolve(root, '..'); p = url.pathname.slice('/Ahmed-Track-'.length); }
  else p = url.pathname.replace(/^\/itrack/, '') || '/';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(base, p);
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  let data = fs.readFileSync(file);
  if (p === '/config.js' && base === root) data = Buffer.from(data.toString().replace(/export const apiUrl = [^;]*;/, `export const apiUrl = 'http://localhost:${port}';`));
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data);
}).listen(port, () => console.log('itrack test server on', port));
