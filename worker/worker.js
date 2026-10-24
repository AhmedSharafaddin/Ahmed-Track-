// خادم تنبيهات مركز القيادة — Cloudflare Worker (الخطة المجانية) + قاعدة D1.
// ملف واحد بلا مكتبات خارجية: يُلصق كما هو في محرّر Cloudflare.
//
// ما يفعله:
//   GET  /vapid        المفتاح العام لتنبيهات الويب (يُنشأ تلقائيًا أول مرة ويُحفظ في D1)
//   POST /subscribe    تسجيل جهاز (يتطلب رمز دخول Firebase)
//   POST /unsubscribe  إلغاء جهاز
//   POST /schedule     استبدال جدول تنبيهات المستخدم بالكامل (يرسله التطبيق عند كل تغيير)
//   POST /test         تنبيه تجريبي فوري لكل أجهزة المستخدم
//   كل دقيقة (Cron)    يرسل ما حان وقته، ويحذف الأجهزة التي لم تعد صالحة
//
// الأمان: كل طلب يحمل رمز دخول Firebase يُتحقق من توقيعه محليًا (مفاتيح Google العامة)؛
// المستخدم لا يرى ولا يغيّر إلا بياناته. لا أسرار يدوية: مفاتيح VAPID تُولَّد وتُحفظ في D1.
//
// الإعداد (المتغيرات اختيارية): FIREBASE_PROJECT_ID (افتراضيًا track-b87ef)، VAPID_SUBJECT.

const PROJECT = 'track-b87ef';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const MAX_ITEMS = 300;
const enc = new TextEncoder();

/* ───────── أدوات ───────── */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '86400' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });

/* ───────── قاعدة البيانات ───────── */
let schemaReady = false;
async function schema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, uid TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT, created INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE INDEX IF NOT EXISTS subs_uid ON subs(uid)'),
    db.prepare('CREATE TABLE IF NOT EXISTS reminders (uid TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, key, at))'),
    db.prepare('CREATE INDEX IF NOT EXISTS rem_due ON reminders(sent, at)'),
  ]);
  schemaReady = true;
}

/* ───────── مفاتيح VAPID (تُولَّد مرة واحدة) ───────── */
let vapidCache = null;
async function vapid(db) {
  if (vapidCache) return vapidCache;
  const row = await db.prepare("SELECT v FROM kv WHERE k = 'vapid'").first();
  let data = row ? JSON.parse(row.v) : null;
  if (!data) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    data = { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    // INSERT OR IGNORE ثم قراءة: إن سبقنا طلب متزامن نستخدم مفتاحه هو
    await db.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('vapid', ?)").bind(JSON.stringify(data)).run();
    data = JSON.parse((await db.prepare("SELECT v FROM kv WHERE k = 'vapid'").first()).v);
  }
  const key = await crypto.subtle.importKey('jwk', data.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  vapidCache = { key, pub: data.pub, jwts: new Map() };
  return vapidCache;
}

async function vapidAuth(env, db, endpoint) {
  const v = await vapid(db);
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const hit = v.jwts.get(aud);
  if (hit && hit.exp - now > 3600) return `vapid t=${hit.jwt}, k=${v.pub}`;
  const exp = now + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT || 'https://github.com/AhmedSharafaddin' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(`${head}.${body}`));
  const jwt = `${head}.${body}.${b64u(sig)}`;
  v.jwts.set(aud, { jwt, exp });
  return `vapid t=${jwt}, k=${v.pub}`;
}

/* ───────── تشفير محتوى التنبيه (RFC 8291 · aes128gcm) ───────── */
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

export async function encryptPayload(sub, plaintext) {
  const uaPub = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = آخر سجل
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function sendPush(env, db, sub, payload) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(env, db, sub.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '43200',
      urgency: payload.kind === 'task' ? 'high' : 'normal',
    },
    body,
  });
}

/* ───────── التحقق من رمز دخول Firebase ───────── */
let jwks = { at: 0, keys: new Map() };
async function googleKey(kid, env) {
  if (!jwks.keys.has(kid) || Date.now() - jwks.at > 6 * 3600_000) {
    const res = await fetch(env.JWKS_URL || JWKS_URL);
    const { keys } = await res.json();
    jwks = { at: Date.now(), keys: new Map(keys.map((k) => [k.kid, k])) };
  }
  const jwk = jwks.keys.get(kid);
  return jwk ? crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']) : null;
}

async function verifyUser(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const [h, p, s] = m[1].split('.');
  if (!s) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(unb64u(h)));
    const claims = JSON.parse(new TextDecoder().decode(unb64u(p)));
    if (head.alg !== 'RS256') return null;
    const key = await googleKey(head.kid, env);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(s), enc.encode(`${h}.${p}`));
    const project = env.FIREBASE_PROJECT_ID || PROJECT;
    const now = Date.now() / 1000;
    if (!ok || claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}`) return null;
    if (!(claims.exp > now) || claims.iat > now + 300 || !claims.sub) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/* ───────── التحقق من المدخلات ───────── */
const str = (v, max) => typeof v === 'string' && v.length <= max;
function cleanItems(items) {
  if (!Array.isArray(items)) return null;
  const now = Date.now();
  const out = [];
  for (const it of items.slice(0, MAX_ITEMS)) {
    if (!it || !str(it.key, 120) || !Number.isFinite(it.at) || !str(it.title, 300) || (it.body != null && !str(it.body, 600))) continue;
    if (it.at < now - 3600_000 || it.at > now + 40 * 864e5) continue;
    const url = str(it.url, 300) && it.url.startsWith('#') ? it.url : '#/today';
    const kind = ['task', 'follow', 'brief', 'close'].includes(it.kind) ? it.kind : 'task';
    out.push({ key: it.key, at: Math.round(it.at), payload: JSON.stringify({ title: it.title, body: it.body || '', url, kind, tag: it.key }) });
  }
  return out;
}

/* ───────── المسارات ───────── */
async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const db = env.DB;
  if (!db) return json({ error: 'D1 binding "DB" is missing' }, 500);
  await schema(db);

  if (req.method === 'GET' && url.pathname === '/vapid') return json({ publicKey: (await vapid(db)).pub });
  if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'command-center-push' });
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);

  const uid = await verifyUser(req, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => ({}));

  if (url.pathname === '/subscribe') {
    const s = body.subscription;
    if (!s || !str(s.endpoint, 1000) || !s.endpoint.startsWith('https://') || !str(s.keys?.p256dh, 200) || !str(s.keys?.auth, 100)) return json({ error: 'bad subscription' }, 400);
    await db.prepare('INSERT INTO subs (endpoint, uid, p256dh, auth, device, created, fails) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(endpoint) DO UPDATE SET uid = excluded.uid, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, fails = 0')
      .bind(s.endpoint, uid, s.keys.p256dh, s.keys.auth, str(body.device, 40) ? body.device : null, Date.now()).run();
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM subs WHERE uid = ?').bind(uid).first();
    return json({ ok: true, devices: n });
  }

  if (url.pathname === '/unsubscribe') {
    if (str(body.endpoint, 1000)) await db.prepare('DELETE FROM subs WHERE endpoint = ? AND uid = ?').bind(body.endpoint, uid).run();
    return json({ ok: true });
  }

  if (url.pathname === '/schedule') {
    const items = cleanItems(body.items);
    if (!items) return json({ error: 'bad items' }, 400);
    // الجدول الجديد يحلّ محل غير المرسَل؛ المرسَل سابقًا بنفس المفتاح والوقت لا يُعاد (INSERT OR IGNORE)
    const stmts = [db.prepare('DELETE FROM reminders WHERE uid = ? AND sent = 0').bind(uid)];
    for (const it of items) stmts.push(db.prepare('INSERT OR IGNORE INTO reminders (uid, key, at, payload) VALUES (?, ?, ?, ?)').bind(uid, it.key, it.at, it.payload));
    stmts.push(db.prepare('DELETE FROM reminders WHERE uid = ? AND at < ?').bind(uid, Date.now() - 8 * 864e5));
    await db.batch(stmts);
    return json({ ok: true, scheduled: items.length });
  }

  if (url.pathname === '/test') {
    const subs = (await db.prepare('SELECT * FROM subs WHERE uid = ?').bind(uid).all()).results;
    const payload = { title: 'التنبيهات تعمل ✓', body: 'هكذا ستصلك تذكيرات مهامك، حتى والتطبيق مغلق.', url: '#/today', kind: 'brief', tag: 'test' };
    const res = await Promise.all(subs.map((s) => sendPush(env, db, s, payload).then((r) => r.status).catch(() => 0)));
    return json({ ok: true, devices: subs.length, results: res });
  }

  return json({ error: 'not found' }, 404);
}

/* ───────── الإرسال الدوري (كل دقيقة) ───────── */
export async function runDue(env, now = Date.now()) {
  const db = env.DB;
  await schema(db);
  const due = (await db.prepare('SELECT uid, key, at, payload FROM reminders WHERE sent = 0 AND at <= ? AND at > ? ORDER BY at LIMIT 25').bind(now, now - 6 * 3600_000).all()).results;
  if (!due.length) return { sent: 0 };
  // نعلّمها مُرسلة أولًا: إن تأخّر التشغيل أو تكرر لا يصل التنبيه مرتين
  await db.batch(due.map((r) => db.prepare('UPDATE reminders SET sent = 1 WHERE uid = ? AND key = ? AND at = ?').bind(r.uid, r.key, r.at)));
  const uids = [...new Set(due.map((r) => r.uid))];
  const subsBy = new Map();
  for (const u of uids) subsBy.set(u, (await db.prepare('SELECT * FROM subs WHERE uid = ?').bind(u).all()).results);

  let sent = 0;
  const dead = [];
  const failed = [];
  await Promise.all(due.flatMap((r) => (subsBy.get(r.uid) || []).map(async (s) => {
    try {
      const res = await sendPush(env, db, s, JSON.parse(r.payload));
      if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
      else if (res.ok) sent++;
      else failed.push(s.endpoint);
    } catch { failed.push(s.endpoint); }
  })));
  const stmts = [
    ...dead.map((e) => db.prepare('DELETE FROM subs WHERE endpoint = ?').bind(e)),
    ...failed.map((e) => db.prepare('UPDATE subs SET fails = fails + 1 WHERE endpoint = ?').bind(e)),
  ];
  if (failed.length) stmts.push(db.prepare('DELETE FROM subs WHERE fails > 50'));
  if (stmts.length) await db.batch(stmts);
  return { sent, dead: dead.length, failed: failed.length };
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); } catch (e) { return json({ error: String(e?.message || e) }, 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env, event.scheduledTime || Date.now()));
  },
};
