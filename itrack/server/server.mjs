#!/usr/bin/env node
// ITrack — خادم التثبيت على سيرفر أي جهة (بديل Cloudflare). ملف واحد بلا مكتبات: Node.js 22.13+ فقط.
// يخدم التطبيق (واجهة «العمل» و«مهامي») والـAPI من نفس العنوان، فوق قاعدة SQLite محلية، مع نسخ احتياطي يومي.
// منطق الخادم هو نفسه الذي يعمل على Cloudflare (itrack/worker/worker.js) ⇒ إصدار واحد يُصان، لا نسختان.
//
//   node itrack/server/server.mjs            تشغيل
//   node itrack/server/server.mjs backup     نسخة احتياطية فورية ثم خروج
//
// الإعداد بمتغيرات البيئة (أو ملف itrack.env بجانب مجلد البيانات، سطر KEY=VALUE لكل متغير):
//   PORT=8080  HOST=0.0.0.0  DATA_DIR=./data  BACKUP_KEEP=14
//   TLS_CERT / TLS_KEY   مسارا شهادة HTTPS (ضروري للميكروفون والتثبيت كتطبيق؛ أو ضع الخادم خلف Nginx/IIS/Caddy)
//   TRUST_PROXY=1        إن كان خلف وكيل عكسي (يقرأ X-Forwarded-For لحدود المحاولات)
//   SIGNUP=invite        (افتراضي هنا) أول حساب ينشئ الجهة، والباقون بدعوة. open = تسجيل حر.
//   AI_URL, AI_KEY, AI_STT_MODEL, AI_LLM_MODEL   الذكاء الاصطناعي (أي خدمة متوافقة مع OpenAI، محلية أو سحابية)
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..'); // جذر المستودع: itrack/ + js/ (واجهة «مهامي» المشتركة) + fonts/ + icons/

/* ───── الإعداد ───── */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile(path.resolve(process.cwd(), 'itrack.env'));
const E = process.env;
const DATA = path.resolve(E.DATA_DIR || path.join(process.cwd(), 'data'));
const BACKUPS = path.join(DATA, 'backups');
fs.mkdirSync(BACKUPS, { recursive: true });
const DB_FILE = path.join(DATA, 'itrack.db');
const db = makeD1(DB_FILE);
const env = {
  DB: db,
  SIGNUP: E.SIGNUP || 'invite',
  AUTH_FIREBASE: E.AUTH_FIREBASE || '0', // سيرفر الشركة لا يعتمد على Google
  PBKDF2_ITERS: E.PBKDF2_ITERS || '600000', // الحد الموصى به لـSHA-256 (OWASP)؛ Node لا يقيّدها كـCloudflare. الكلمات القديمة تبقى صالحة وتُجدَّد عند تغييرها
  ALLOWED_ORIGINS: E.ALLOWED_ORIGINS, AI_URL: E.AI_URL, AI_KEY: E.AI_KEY, AI_STT_MODEL: E.AI_STT_MODEL, AI_LLM_MODEL: E.AI_LLM_MODEL,
};
const W = (await import('../worker/worker.js')).default;

/* ───── نسخ احتياطي (VACUUM INTO: نسخة متسقة دون إيقاف الخدمة) ───── */
const KEEP = Math.max(Number(E.BACKUP_KEEP) || 14, 1);
function backup() {
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(BACKUPS, `itrack-${stamp}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.sq.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(BACKUPS).filter((f) => /^itrack-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) fs.unlinkSync(path.join(BACKUPS, f));
  return file;
}
if (process.argv[2] === 'backup') {
  await W.fetch(new Request('http://local/api/health'), env); // يضمن تطبيق الترحيلات
  console.log('backup:', backup()); process.exit(0);
}

/* ───── الملفات الثابتة ───── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
// ما يُسمح بخدمته فقط (لا مجلد tests ولا worker ولا server ولا ملفات المستودع الأخرى)
const ALLOW = [/^\/itrack\/(index\.html|styles\.css|config\.js|sw\.js|manifest\.webmanifest)$/, /^\/itrack\/(js|icons|fonts)\/[\w.-]+$/, /^\/itrack\/templates\/jd-template\.xlsx$/, /^\/itrack\/my\/index\.html$/,
  /^\/js\/[\w.-]+\.js$/, /^\/(fonts|icons)\/[\w.-]+$/, /^\/styles\.css$/];
const NO_CACHE = /\.(html|webmanifest)$|\/sw\.js$|\/config\.js$/;
const files = new Map(); // كاش في الذاكرة: المحتوى + الضغط + ETag، يُحدَّث إن تغيّر الملف
function asset(rel) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = files.get(rel);
  if (hit && hit.key === key) return hit;
  const body = fs.readFileSync(file);
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const text = /^(text|application\/(json|manifest)|image\/svg)/.test(type);
  const a = { key, body, type, etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`,
    br: text && body.length > 1024 ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } }) : null,
    gz: text && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null };
  files.set(rel, a);
  return a;
}
const TLS = !!(E.TLS_CERT && E.TLS_KEY);
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  ...(TLS || E.TRUST_PROXY === '1' ? { 'strict-transport-security': 'max-age=31536000' } : {}),
};
function sendAsset(req, res, rel) {
  const a = asset(rel);
  if (!a) return notFound(res);
  const h = { ...SEC, 'content-type': a.type, etag: a.etag, vary: 'Accept-Encoding',
    // الملفات بلا بصمة في أسمائها ⇒ تحقق سريع بالـETag (304) بدل تخزين أعمى؛ والـService Worker يتكفّل بالعمل دون اتصال
    'cache-control': NO_CACHE.test(rel) ? 'no-cache' : 'public, max-age=300, must-revalidate' };
  if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, h); return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = a.body;
  if (a.br && /\bbr\b/.test(ae)) { body = a.br; h['content-encoding'] = 'br'; } else if (a.gz && /\bgzip\b/.test(ae)) { body = a.gz; h['content-encoding'] = 'gzip'; }
  h['content-length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}
const notFound = (res) => { res.writeHead(404, { ...SEC, 'content-type': 'text/plain; charset=utf-8' }); res.end('غير موجود'); };

/* ───── الـAPI: نفس كود Cloudflare ───── */
const MAX_REQ = 7 * 1024 * 1024; // تسجيل صوتي ≈ ٣ دقائق
async function api(req, res, url) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_REQ) { res.writeHead(413); return res.end(); } chunks.push(c); }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'x-real-ip' && k !== 'cf-connecting-ip') headers.set(k, v);
  const ip = E.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  headers.set('x-real-ip', ip || 'local');
  const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const r = await W.fetch(new Request(url, { method: req.method, headers, body }), env);
  const out = Buffer.from(await r.arrayBuffer());
  const h = { ...Object.fromEntries(r.headers), 'x-content-type-options': 'nosniff' };
  if (out.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    const z = zlib.gzipSync(out, { level: 6 }); h['content-encoding'] = 'gzip'; h['content-length'] = z.length; res.writeHead(r.status, h); return res.end(z);
  }
  h['content-length'] = out.length;
  res.writeHead(r.status, h); res.end(out);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/index.html') { res.writeHead(302, { location: '/itrack/' }); return res.end(); }
    if (p === '/itrack') { res.writeHead(301, { location: '/itrack/' }); return res.end(); }
    if (p.endsWith('/')) p += 'index.html';
    if (p.includes('..') || !ALLOW.some((re) => re.test(p))) return notFound(res);
    return sendAsset(req, res, p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
}

const server = TLS
  ? https.createServer({ cert: fs.readFileSync(E.TLS_CERT), key: fs.readFileSync(E.TLS_KEY) }, handler)
  : http.createServer(handler);
server.keepAliveTimeout = 65_000;
server.requestTimeout = 120_000;
const PORT = Number(E.PORT) || (TLS ? 8443 : 8080);
await W.fetch(new Request('http://local/api/health'), env); // ترحيلات القاعدة قبل أول مستخدم
server.listen(PORT, E.HOST || '0.0.0.0', () => {
  console.log(`ITrack: ${TLS ? 'https' : 'http'}://localhost:${PORT}/itrack/  · data: ${DB_FILE} · signup: ${env.SIGNUP} · ai: ${env.AI_URL ? 'on' : 'off'}`);
  if (!TLS && E.TRUST_PROXY !== '1') console.log('تنبيه: بدون HTTPS لا يعمل الميكروفون ولا التثبيت كتطبيق إلا على localhost. ضع TLS_CERT/TLS_KEY أو وكيلًا عكسيًا.');
});
// نسخة احتياطية عند التشغيل ثم كل ٢٤ ساعة
try { backup(); } catch (e) { console.error('backup failed', e.message); }
setInterval(() => { try { backup(); } catch (e) { console.error('backup failed', e.message); } }, 24 * 3600_000).unref();
const stop = () => { server.close(); try { db.sq.close(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
