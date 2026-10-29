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
// الذكاء الاصطناعي (اختياري، يحتاج ربط Workers AI باسم AI — مجاني ضمن ١٠٬٠٠٠ neuron يوميًا):
//   POST /transcribe   صوت WAV (base64 نصًا خامًا) ← نص عربي (Whisper)
//   POST /parse        نص الملاحظة الصوتية ← مهام/اجتماعات بحقولها، للتأكيد قبل الإضافة
//   POST /minutes      نص اجتماع ← ملخص، حضور، قرارات، مطلوب من كل شخص، مواعيد
//   لا يُحفظ أي صوت أو نص على الخادم؛ يُعالج ويُعاد فورًا.
//
// الأمان: كل طلب يحمل رمز دخول Firebase يُتحقق من توقيعه محليًا (مفاتيح Google العامة)؛
// المستخدم لا يرى ولا يغيّر إلا بياناته. لا أسرار يدوية: مفاتيح VAPID تُولَّد وتُحفظ في D1.
//
// الإعداد (المتغيرات اختيارية): FIREBASE_PROJECT_ID (افتراضيًا track-b87ef)، VAPID_SUBJECT.

const PROJECT = 'track-b87ef';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const MAX_ITEMS = 250;
const PER_RUN = 4; // تنبيهات لكل تشغيل (كل دقيقة) — يبقى ضمن حد ١٠ مللي ثانية للمعالج في الخطة المجانية
// خدمات التنبيهات المعروفة فقط (Apple، Google، Mozilla، Microsoft) — لا يُرسل الخادم لأي عنوان آخر
const PUSH_HOSTS = /^(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|android\.googleapis\.com)$/;
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
    // صف واحد لكل مستخدم يحمل جدوله كاملًا (JSON) ⇒ استعلام واحد بدل مئات (حدود D1 المجانية: ٥٠ استعلامًا لكل تشغيل)
    db.prepare('CREATE TABLE IF NOT EXISTS schedules (uid TEXT PRIMARY KEY, items TEXT NOT NULL, next_at INTEGER, updated INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS sched_next ON schedules(next_at)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sent (uid TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (uid, key, at))'),
    db.prepare('CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, at INTEGER NOT NULL)'),
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
  const stale = Date.now() - jwks.at > 6 * 3600_000;
  const unknown = !jwks.keys.has(kid) && Date.now() - jwks.at > 60_000; // مفتاح مجهول: إعادة جلب مرة في الدقيقة كحد أقصى
  if (stale || unknown) {
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
const cut = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
function cleanItems(items) {
  if (!Array.isArray(items)) return null;
  const now = Date.now();
  const out = [];
  for (const it of items.slice(0, MAX_ITEMS)) {
    if (!it || !str(it.key, 120) || !Number.isFinite(it.at) || typeof it.title !== 'string' || !it.title) continue;
    if (it.at < now - 3600_000 || it.at > now + 40 * 864e5) continue;
    const url = str(it.url, 300) && /^#\/[\w/?=&.-]*$/.test(it.url) ? it.url : '#/today';
    const kind = ['task', 'follow', 'brief', 'close'].includes(it.kind) ? it.kind : 'task';
    out.push({ key: it.key, at: Math.round(it.at), title: cut(it.title, 200), body: cut(it.body, 500), url, kind });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** حد بسيط للطلبات المتكررة (يحمي حصة الخطة المجانية). */
async function limited(db, key, ms) {
  const row = await db.prepare('SELECT at FROM hits WHERE k = ?').bind(key).first();
  if (row && Date.now() - row.at < ms) return true;
  await db.prepare('INSERT INTO hits (k, at) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at').bind(key, Date.now()).run();
  return false;
}

/* ───────── الذكاء الاصطناعي ─────────
   حدود يومية لكل مستخدم تحمي الحصة المجانية المشتركة (١٠٬٠٠٠ neuron/يوم):
   تفريغ الصوت ≈ ٤٧ neuron للدقيقة، والتحليل بضع عشرات لكل طلب. */
const STT = '@cf/openai/whisper-large-v3-turbo';
const LLM = '@cf/meta/llama-4-scout-17b-16e-instruct';
const DAY_LIMITS = { transcribe: 150, parse: 120, minutes: 20 };
const MAX_AUDIO_B64 = 6_000_000; // ≈ ٣ دقائق WAV بجودة 16kHz — التطبيق يقسّم التسجيل الطويل إلى مقاطع

async function quota(db, uid, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `ai:${kind}:${uid}:${day}`;
  // hits.at يُستخدم هنا عدّادًا
  const row = await db.prepare('INSERT INTO hits (k, at) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET at = at + 1 RETURNING at').bind(k).first();
  return (row?.at || 0) > DAY_LIMITS[kind];
}

function pickJson(r) {
  const raw = r?.response ?? r?.result?.response ?? r;
  if (raw && typeof raw === 'object') return raw;
  const t = String(raw || '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

async function llmJson(env, system, user, schema, maxTokens) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  try {
    const r = await env.AI.run(LLM, { messages, max_tokens: maxTokens, temperature: 0.1, response_format: { type: 'json_schema', json_schema: schema } });
    const j = pickJson(r); if (j) return j;
  } catch {}
  const r = await env.AI.run(LLM, { messages, max_tokens: maxTokens, temperature: 0.1 });
  return pickJson(r);
}

const S_STR = { type: 'string' };
const PARSE_SCHEMA = {
  type: 'object', required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', required: ['kind', 'title'], properties: {
    kind: { type: 'string', enum: ['task', 'meeting'] }, title: S_STR, due: S_STR, time: S_STR, duration: { type: 'number' },
    place: S_STR, area: S_STR, assignee: S_STR, important: { type: 'boolean' }, urgent: { type: 'boolean' } } } } },
};
const MINUTES_SCHEMA = {
  type: 'object', required: ['summary', 'decisions', 'actions'],
  properties: {
    summary: S_STR, attendees: { type: 'array', items: S_STR }, decisions: { type: 'array', items: S_STR },
    actions: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: S_STR, owner: S_STR, due: S_STR } } },
    dates: { type: 'array', items: { type: 'object', properties: { what: S_STR, date: S_STR } } },
  },
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const tcut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function cleanParsed(j, areas) {
  const items = Array.isArray(j?.items) ? j.items.slice(0, 12) : [];
  return items.map((it) => ({
    kind: it.kind === 'meeting' ? 'meeting' : 'task',
    title: tcut(it.title, 200),
    due: DATE.test(it.due || '') ? it.due : null,
    time: TIME.test(it.time || '') ? it.time : null,
    duration: Number.isFinite(it.duration) && it.duration > 0 && it.duration <= 600 ? Math.round(it.duration) : null,
    place: tcut(it.place, 120) || null,
    area: areas.includes(it.area) ? it.area : null,
    assignee: tcut(it.assignee, 40) || null,
    important: !!it.important, urgent: !!it.urgent,
  })).filter((it) => it.title);
}

function cleanMinutes(j) {
  const arr = (a, n) => (Array.isArray(a) ? a : []).slice(0, n);
  return {
    summary: tcut(j?.summary, 2000),
    attendees: arr(j?.attendees, 30).map((x) => tcut(x, 60)).filter(Boolean),
    decisions: arr(j?.decisions, 30).map((x) => tcut(x, 400)).filter(Boolean),
    actions: arr(j?.actions, 40).map((a) => ({ title: tcut(a?.title, 200), owner: tcut(a?.owner, 40) || null, due: DATE.test(a?.due || '') ? a.due : null })).filter((a) => a.title),
    dates: arr(j?.dates, 20).map((d) => ({ what: tcut(d?.what, 200), date: DATE.test(d?.date || '') ? d.date : null })).filter((d) => d.what),
  };
}

async function aiRoute(path, req, env, db, uid, url) {
  if (!env.AI) return json({ error: 'ai binding missing' }, 501);
  const kind = path.slice(1);
  if (await quota(db, uid, kind)) return json({ error: 'daily limit' }, 429);

  if (kind === 'transcribe') {
    // الجسم نص base64 خام (لا JSON) ⇒ لا تحليل على المعالج، يُمرّر كما هو
    const audio = await req.text();
    if (!audio || audio.length > MAX_AUDIO_B64 || !/^[A-Za-z0-9+/=]+$/.test(audio.slice(0, 200))) return json({ error: 'bad audio' }, 400);
    const prompt = tcut(url.searchParams.get('hint') || '', 300);
    const r = await env.AI.run(STT, { audio, language: 'ar', vad_filter: true, ...(prompt ? { initial_prompt: prompt } : {}) });
    return json({ text: tcut(r?.text, 20000) });
  }

  const body = await req.json().catch(() => ({}));
  const today = DATE.test(body.today || '') ? body.today : new Date().toISOString().slice(0, 10);
  const weekday = tcut(body.weekday, 20);
  const areas = (Array.isArray(body.areas) ? body.areas : []).map((a) => tcut(a, 40)).filter(Boolean).slice(0, 20);
  const people = (Array.isArray(body.people) ? body.people : []).map((a) => tcut(a, 40)).filter(Boolean).slice(0, 40);

  if (kind === 'parse') {
    const text = tcut(body.text, 4000);
    if (!text) return json({ items: [] });
    const sys = `أنت تحوّل ملاحظة صوتية عربية (قد تكون بلهجة يمنية أو سعودية أو خليجية) إلى عناصر منظمة لتطبيق مهام. أعد JSON فقط بالشكل {"items":[...]}.
اليوم ${today}${weekday ? ` (${weekday})` : ''}. الأسبوع يبدأ السبت.
- kind: "meeting" إن ذُكر اجتماع أو لقاء أو موعد مع أشخاص، وإلا "task".
- title: عنوان قصير بفصحى بسيطة يبدأ بفعل للمهمة، أو «اجتماع مع ...» للاجتماع. لا تخترع تفاصيل لم تُذكر.
- due: تاريخ YYYY-MM-DD فقط إن ذُكر يوم أو تاريخ (بكرة/غدًا، بعد بكرة، الأحد، الأسبوع الجاي = السبت القادم...). وإلا اتركه فارغًا.
- time: HH:MM بنظام ٢٤ ساعة إن ذُكر وقت (الصبح/الصباح ⇒ قبل الظهر، العصر/المغرب/الليل ⇒ بعد الظهر).
- duration بالدقائق للاجتماع إن ذُكرت. place للمكان إن ذُكر.
- area: واحدة من هذه بالضبط إن كان واضحًا: ${areas.join('، ') || '(لا يوجد)'}. وإلا فارغ.
- assignee: اسم الشخص المكلّف إن قال «خلي فلان» أو «كلّف فلان». أشخاص معروفون: ${people.join('، ') || '(لا يوجد)'}.
- important للمهم، urgent للعاجل أو «ضروري اليوم».
- ملاحظة واحدة قد تحوي عدة عناصر: افصلها.`;
    const j = await llmJson(env, sys, text, { name: 'items', schema: PARSE_SCHEMA }, 900);
    return json({ items: cleanParsed(j, areas) });
  }

  if (kind === 'minutes') {
    const text = tcut(body.text, 60000);
    const title = tcut(body.title, 200);
    if (text.length < 20) return json({ error: 'too short' }, 400);
    const sys = `أنت أمين سر محترف تكتب محضر اجتماع عمل بالعربية الفصحى المختصرة من تفريغ صوتي قد يكون بلهجة يمنية ويحوي أخطاء تفريغ. أعد JSON فقط.
اليوم ${today}. ${title ? `موضوع الاجتماع: ${title}.` : ''}
- summary: ملخص من ٢ إلى ٤ جمل.
- attendees: أسماء من ذُكروا أو تحدثوا فقط. لا تخترع أسماء.
- decisions: القرارات المتفق عليها، كل قرار جملة واحدة.
- actions: المطلوب تنفيذه: title يبدأ بفعل، owner اسم المسؤول إن ذُكر (أشخاص معروفون: ${people.join('، ') || '-'})، due بصيغة YYYY-MM-DD إن ذُكر موعد.
- dates: المواعيد القادمة المذكورة (اجتماع لاحق، تسليم...).
- إن لم يُذكر شيء في بند فاتركه مصفوفة فارغة. لا تضف ما لم يُقل.`;
    const j = await llmJson(env, sys, text, { name: 'minutes', schema: MINUTES_SCHEMA }, 2500);
    if (!j) return json({ error: 'model failed' }, 502);
    return json(cleanMinutes(j));
  }
  return json({ error: 'not found' }, 404);
}

/* ───────── المسارات ───────── */
async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const db = env.DB;
  if (!db) return json({ error: 'D1 binding "DB" is missing' }, 500);
  await schema(db);

  if (req.method === 'GET' && url.pathname === '/vapid') return json({ publicKey: (await vapid(db)).pub });
  if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'command-center-push', ai: !!env.AI });
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);

  const uid = await verifyUser(req, env);
  if (!uid) return json({ error: 'unauthorized' }, 401);
  if (['/transcribe', '/parse', '/minutes'].includes(url.pathname)) return aiRoute(url.pathname, req, env, db, uid, url);
  const body = await req.json().catch(() => ({}));

  if (url.pathname === '/subscribe') {
    const s = body.subscription;
    let host = '';
    try { host = new URL(s?.endpoint).hostname; } catch {}
    if (!s || !str(s.endpoint, 1000) || !s.endpoint.startsWith('https://') || !PUSH_HOSTS.test(host) || !str(s.keys?.p256dh, 200) || !str(s.keys?.auth, 100)) return json({ error: 'bad subscription' }, 400);
    await db.prepare('INSERT INTO subs (endpoint, uid, p256dh, auth, device, created, fails) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(endpoint) DO UPDATE SET uid = excluded.uid, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, fails = 0')
      .bind(s.endpoint, uid, s.keys.p256dh, s.keys.auth, str(body.device, 40) ? body.device : null, Date.now()).run();
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM subs WHERE uid = ?').bind(uid).first();
    return json({ ok: true, devices: n });
  }

  if (url.pathname === '/unsubscribe') {
    if (str(body.endpoint, 1000)) await db.prepare('DELETE FROM subs WHERE endpoint = ? AND uid = ?').bind(body.endpoint, uid).run();
    // لا أجهزة باقية ⇒ لا داعي للاحتفاظ بجدوله (عناوين مهامه) على الخادم
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM subs WHERE uid = ?').bind(uid).first();
    if (!n) await db.prepare('DELETE FROM schedules WHERE uid = ?').bind(uid).run();
    return json({ ok: true, devices: n });
  }

  if (url.pathname === '/schedule') {
    const items = cleanItems(body.items);
    if (!items) return json({ error: 'bad items' }, 400);
    // الجدول الجديد يحلّ محل القديم كاملًا؛ ما أُرسل سابقًا محفوظ في جدول sent فلا يُعاد
    const next = items.length ? items[0].at : null;
    await db.prepare('INSERT INTO schedules (uid, items, next_at, updated) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET items = excluded.items, next_at = excluded.next_at, updated = excluded.updated')
      .bind(uid, JSON.stringify(items), next, Date.now()).run();
    return json({ ok: true, scheduled: items.length });
  }

  if (url.pathname === '/test') {
    if (await limited(db, `test:${uid}`, 20_000)) return json({ error: 'slow down' }, 429);
    const subs = (await db.prepare('SELECT * FROM subs WHERE uid = ?').bind(uid).all()).results;
    const payload = { title: 'التنبيهات تعمل ✓', body: 'هكذا ستصلك تذكيرات مهامك، حتى والتطبيق مغلق.', url: '#/today', kind: 'brief', tag: 'test' };
    const res = await Promise.all(subs.map((s) => sendPush(env, db, s, payload).then((r) => r.status).catch(() => 0)));
    return json({ ok: true, devices: subs.length, results: res });
  }

  return json({ error: 'not found' }, 404);
}

/* ───────── الإرسال الدوري (كل دقيقة) ─────────
   • نقرأ فقط المستخدمين الذين حان أقرب تنبيه لهم (next_at).
   • نرسل حتى PER_RUN تنبيهات، والباقي في الدقيقة التالية (حدود الخطة المجانية).
   • التنبيه يُسجَّل «مُرسلًا» بعد نجاح إرساله فقط ⇒ إن توقف التشغيل في المنتصف يُعاد لاحقًا ولا يضيع. */
export async function runDue(env, now = Date.now()) {
  const db = env.DB;
  await schema(db);
  const users = (await db.prepare('SELECT uid, items FROM schedules WHERE next_at IS NOT NULL AND next_at <= ? LIMIT 10').bind(now).all()).results;
  let budget = PER_RUN;
  let sent = 0;
  const dead = new Set();
  for (const u of users) {
    const items = JSON.parse(u.items);
    const done = new Set((await db.prepare('SELECT key, at FROM sent WHERE uid = ? AND at > ?').bind(u.uid, now - 6 * 3600_000).all()).results.map((r) => `${r.key}|${r.at}`));
    const due = items.filter((it) => it.at <= now && it.at > now - 6 * 3600_000 && !done.has(`${it.key}|${it.at}`));
    const batch = due.slice(0, budget);
    if (batch.length) {
      const subs = (await db.prepare('SELECT * FROM subs WHERE uid = ?').bind(u.uid).all()).results;
      const ok = [];
      for (const it of batch) {
        const res = await Promise.all(subs.map((s) => sendPush(env, db, s, { title: it.title, body: it.body, url: it.url, kind: it.kind, tag: it.key })
          .then((r) => { if (r.status === 404 || r.status === 410) dead.add(s.endpoint); return r.ok; })
          .catch(() => false)));
        if (res.some(Boolean) || !subs.length) { ok.push(it); sent++; }
      }
      if (ok.length) await db.batch(ok.map((it) => db.prepare('INSERT OR IGNORE INTO sent (uid, key, at) VALUES (?, ?, ?)').bind(u.uid, it.key, it.at)));
      budget -= batch.length;
    }
    // أقرب تنبيه لم يُرسل بعد لهذا المستخدم
    const left = due.length - batch.length;
    const future = items.find((it) => it.at > now);
    const nextAt = left > 0 ? now : future ? future.at : null;
    await db.prepare('UPDATE schedules SET next_at = ? WHERE uid = ?').bind(nextAt, u.uid).run();
    if (budget <= 0) break;
  }
  if (dead.size) await db.batch([...dead].map((e) => db.prepare('DELETE FROM subs WHERE endpoint = ?').bind(e)));
  if (new Date(now).getUTCMinutes() === 7) await db.prepare('DELETE FROM sent WHERE at < ?').bind(now - 8 * 864e5).run();
  return { sent, dead: dead.size };
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); } catch (e) { return json({ error: String(e?.message || e) }, 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env, event.scheduledTime || Date.now()));
  },
};
