// ITrack — خادم منصة تتبع إنجاز الموظفين اليومي.
// Cloudflare Worker (الخطة المجانية) + قاعدة D1 (SQLite). ملف واحد بلا مكتبات: يُلصق كما هو في محرّر Cloudflare.
//
// المبادئ:
//   • كل الصلاحيات تُفرض هنا، لا في الواجهة. الواجهة تعرض فقط ما يعيده الخادم.
//   • سجل التدقيق (audit) يُكتب من الخادم فقط ولا يوجد مسار لتعديله أو حذفه.
//   • التوصيف الوظيفي لا يُحذف بنده أبدًا: يُعطَّل (active=0) فتبقى التقارير القديمة مقروءة كما كُتبت.
//   • SQL قياسي ⇒ يُنقل إلى سيرفر الشركة (SQLite/PostgreSQL) دون إعادة كتابة المنطق.
//
// الهوية: حسابات داخلية (بريد + كلمة مرور، PBKDF2) وجلسات it_… (Authorization: Bearer).
//   الانضمام لجهة برمز دعوة يصدره المسؤول، ونسيان كلمة المرور برمز إعادة تعيين منه (لا حاجة لخادم بريد).
//   رموز Firebase القديمة ما زالت مقبولة للتوافق (AUTH_FIREBASE=0 يعطّلها).
// الجهة: ترويسة X-Org. الأدوار: admin (المدير العام/مسؤول الجهة) · manager · employee.
// الرؤية: المسؤول يرى الجميع؛ المدير يرى كل من تحته على أي عمق؛ الموظف يرى نفسه.
//
// الإعداد: ربط D1 باسم DB. متغيرات اختيارية:
//   SIGNUP=open|invite (open افتراضيًا؛ invite: أول حساب فقط بلا رمز، والباقي بدعوة — مناسب لسيرفر شركة)
//   ALLOWED_ORIGINS، PBKDF2_ITERS، AUTH_FIREBASE، FIREBASE_PROJECT_ID
//   الذكاء الاصطناعي: ربط Workers AI باسم AI، أو AI_URL + AI_KEY (أي خدمة متوافقة مع OpenAI، محلية أو سحابية)
//   مع AI_STT_MODEL و AI_LLM_MODEL اختياريًا.

const PROJECT = 'track-b87ef';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const ROLES = ['admin', 'manager', 'employee'];
const STATES = ['done', 'progress', 'blocked'];
const MAX_ITEMS = 30; // حد D1 المجاني ٥٠ استعلامًا لكل طلب: الحفظ = بنود + ٣
const MAX_BODY = 64_000;
const LATE_DAYS = 7; // يُسمح بكتابة تقرير متأخر حتى ٧ أيام، ويُعلَّم متأخرًا
const enc = new TextEncoder();
const dec = new TextDecoder();

/* ═════════════ المخطط (ترحيلات مرقّمة) ═════════════ */
const MIGRATIONS = [
  [
    'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS dep_org ON departments(org_id)',
    `CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, department_id TEXT,
      summary TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS pos_org ON positions(org_id)',
    `CREATE TABLE IF NOT EXISTS responsibilities (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, position_id TEXT NOT NULL, title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)`,
    'CREATE INDEX IF NOT EXISTS resp_pos ON responsibilities(position_id)',
    `CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, uid TEXT, name TEXT NOT NULL,
      role TEXT NOT NULL, department_id TEXT, position_id TEXT, manager_id TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (org_id, email))`,
    'CREATE INDEX IF NOT EXISTS mem_uid ON members(uid)',
    'CREATE INDEX IF NOT EXISTS mem_email ON members(email)',
    'CREATE INDEX IF NOT EXISTS mem_mgr ON members(org_id, manager_id)',
    `CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, member_id TEXT NOT NULL, date TEXT NOT NULL,
      status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', late INTEGER NOT NULL DEFAULT 0, submitted_at INTEGER,
      reviewed_by TEXT, reviewed_at INTEGER, review_comment TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (member_id, date))`,
    'CREATE INDEX IF NOT EXISTS rep_day ON reports(org_id, date)',
    `CREATE TABLE IF NOT EXISTS report_items (id TEXT PRIMARY KEY, report_id TEXT NOT NULL, org_id TEXT NOT NULL, member_id TEXT NOT NULL,
      date TEXT NOT NULL, text TEXT NOT NULL, responsibility_id TEXT, minutes INTEGER, state TEXT NOT NULL, blocker TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS item_rep ON report_items(report_id)',
    'CREATE INDEX IF NOT EXISTS item_mem ON report_items(member_id, date)',
    `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, at INTEGER NOT NULL, actor_id TEXT,
      action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, subject_id TEXT, data TEXT NOT NULL DEFAULT '{}')`,
    'CREATE INDEX IF NOT EXISTS audit_ent ON audit(org_id, entity, entity_id)',
    'CREATE INDEX IF NOT EXISTS audit_subj ON audit(org_id, subject_id, at)',
    'CREATE INDEX IF NOT EXISTS audit_at ON audit(org_id, at)',
  ],
  [
    // مساحة العضو الشخصية (مهام/مجالات/أهداف/مراجعات/إعدادات): وثائق JSON خاصة بصاحبها.
    // shared=1 تُضبط من الخادم فقط للمهام التي اختار صاحبها إظهارها لمديريه.
    `CREATE TABLE IF NOT EXISTS pdocs (member_id TEXT NOT NULL, col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (member_id, col, id))`,
    'CREATE INDEX IF NOT EXISTS pdocs_shared ON pdocs(shared, member_id)',
  ],
  [
    // أداء: يخدم ترتيب السحب (member, col, updated_at) ومسار التوقيع بلا مسح كامل
    'CREATE INDEX IF NOT EXISTS pdocs_recent ON pdocs(member_id, col, updated_at DESC)',
  ],
  [
    // حسابات داخلية: لا اعتماد على Firebase ⇒ يعمل على سيرفر أي شركة، حتى بلا إنترنت.
    `CREATE TABLE IF NOT EXISTS accounts (uid TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, salt TEXT NOT NULL,
      iters INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    // الجلسة تُحفظ مُجزّأة (SHA-256) ⇒ تسريب القاعدة لا يكشف رموز دخول صالحة
    `CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, agent TEXT NOT NULL DEFAULT '')`,
    'CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid, seen_at)',
    // رموز الدعوة وإعادة تعيين كلمة المرور (تُصدرها الإدارة بدل البريد الإلكتروني)
    `CREATE TABLE IF NOT EXISTS codes (ch TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, org_id TEXT NOT NULL, member_id TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS codes_member ON codes(member_id)',
    'CREATE TABLE IF NOT EXISTS throttle (k TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS ai_use (k TEXT PRIMARY KEY, n INTEGER NOT NULL)',
  ],
  [
    // الأقسام: مستوى بين الإدارة والموظف (إدارة المبيعات ← قسم الموزعين). اختياري للعضو.
    `CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT NOT NULL, name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS sec_org ON sections(org_id, department_id)',
    'ALTER TABLE members ADD COLUMN section_id TEXT',
  ],
];

const migrated = new WeakSet(); // لكل قاعدة على حدة؛ وعلى Cloudflare ربط واحد فقط فتكفي مرة لكل نسخة
let migratedD1 = false;
async function migrate(db) {
  if (migrated.has(db) || (migratedD1 && db.constructor?.name === 'D1Database')) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  const row = await db.prepare("SELECT v FROM meta WHERE k = 'schema'").first();
  let v = row ? Number(row.v) : 0;
  while (v < MIGRATIONS.length) {
    await db.batch([...MIGRATIONS[v].map((s) => db.prepare(s)),
      db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(v + 1))]);
    v++;
  }
  migrated.add(db); migratedD1 = true;
}

/* ═════════════ أدوات ═════════════ */
// CORS: نسمح فقط لواجهة ITrack (وللتطوير المحلي). للنقل إلى نطاق آخر: متغير ALLOWED_ORIGINS (مفصول بفواصل).
const ORIGINS = ['https://ahmedsharafaddin.github.io'];
const CORS = {
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-org', 'access-control-max-age': '86400', vary: 'Origin',
};
function allowOrigin(origin, env) {
  if (!origin) return null;
  const list = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((x) => x.trim()) : ORIGINS;
  if (list.includes('*') || list.includes(origin)) return origin;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
}
function withCors(res, req, env) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  const o = allowOrigin(req.headers.get('origin'), env);
  if (o) h.set('access-control-allow-origin', o);
  return new Response(res.body, { status: res.status, headers: h });
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
class Fail extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new Fail(status, code, message); };
const id = () => crypto.randomUUID();
const now = () => Date.now();
const low = (e) => String(e || '').trim().toLowerCase();
const text = (v, max, { required = false, label = 'الحقل' } = {}) => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  if (required && !s) fail(400, 'invalid', `${label} مطلوب.`);
  return s;
};
const isEmail = (e) => /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(e) && e.length <= 120;
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => dayOf(Date.parse(d + 'T00:00:00Z') + n * 864e5);
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/* ═════════════ الهوية: رمز Firebase ═════════════ */
let jwks = { at: 0, keys: new Map() };
async function googleKey(kid, env) {
  if (Date.now() - jwks.at > 6 * 3600_000 || (!jwks.keys.has(kid) && Date.now() - jwks.at > 60_000)) {
    const { keys } = await (await fetch(env.JWKS_URL || JWKS_URL)).json();
    jwks = { at: Date.now(), keys: new Map(keys.map((k) => [k.kid, k])) };
  }
  const k = jwks.keys.get(kid);
  return k ? crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']) : null;
}
async function identity(req, env, db) {
  const auth = req.headers.get('authorization') || '';
  const sm = auth.match(/^Bearer (it_[\w-]{20,80})$/);
  if (sm) {
    const th = await sha(sm[1]); const t = now();
    const r = await db.prepare('SELECT s.uid, s.seen_at, a.email FROM sessions s JOIN accounts a ON a.uid = s.uid WHERE s.th = ? AND s.expires_at > ? AND a.disabled = 0').bind(th, t).first();
    if (!r) return null;
    // تمديد الجلسة مرة يوميًا على الأكثر (لا كتابة مع كل طلب)
    if (t - r.seen_at > 864e5) await db.prepare('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE th = ?').bind(t, t + SESSION_DAYS * 864e5, th).run();
    return { uid: r.uid, email: r.email, verified: true, local: true, th };
  }
  if (env.AUTH_FIREBASE === '0') return null;
  const m = auth.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/);
  if (!m) return null;
  const [h, p, s] = m[1].split('.');
  try {
    const head = JSON.parse(dec.decode(b64u(h)));
    const c = JSON.parse(dec.decode(b64u(p)));
    if (head.alg !== 'RS256') return null;
    const key = await googleKey(head.kid, env);
    if (!key || !(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), enc.encode(`${h}.${p}`)))) return null;
    const project = env.FIREBASE_PROJECT_ID || PROJECT;
    const t = Date.now() / 1000;
    if (c.aud !== project || c.iss !== `https://securetoken.google.com/${project}` || !(c.exp > t) || c.iat > t + 300 || !c.sub || !c.email) return null;
    return { uid: c.sub, email: low(c.email), verified: c.email_verified === true };
  } catch { return null; }
}

/* ═════════════ الحسابات الداخلية ═════════════ */
const SESSION_DAYS = 30;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64e = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = async (str) => hex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
const itersOf = (env) => Math.min(Math.max(Number(env.PBKDF2_ITERS) || 100_000, 10_000), 1_000_000); // Cloudflare يقبل حتى ١٠٠ ألف
async function pbkdf2(pass, saltHex, iters) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters }, key, 256));
}
const same = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };
async function hashPass(env, pass) { const salt = hex(rand(16)); const iters = itersOf(env); return { salt, iters, hash: await pbkdf2(pass, salt, iters) }; }
const checkPass = (pass) => {
  if (typeof pass !== 'string' || pass.length < 8) fail(400, 'weak-password', 'كلمة المرور ٨ أحرف على الأقل.');
  if (pass.length > 200) fail(400, 'invalid', 'كلمة المرور طويلة جدًا.');
  return pass;
};
const ipOf = (req) => req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'local';
/** حد المحاولات: يرفض إن تجاوز المفتاح max خلال النافذة. */
async function throttle(db, key, max, windowMs) {
  const r = await db.prepare('SELECT n, until FROM throttle WHERE k = ?').bind(key).first();
  if (r && r.until > now() && r.n >= max) fail(429, 'too-many', 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.');
}
const bump = (db, key, windowMs) => { const t = now(); return db.prepare(`INSERT INTO throttle (k, n, until) VALUES (?1, 1, ?2)
  ON CONFLICT(k) DO UPDATE SET n = CASE WHEN until < ?3 THEN 1 ELSE n + 1 END, until = CASE WHEN until < ?3 THEN ?2 ELSE until END`).bind(key, t + windowMs, t).run(); };
async function newSession(db, uid, req) {
  const tok = 'it_' + b64e(rand(32)); const t = now();
  await db.batch([
    db.prepare('INSERT INTO sessions (th, uid, created_at, seen_at, expires_at, agent) VALUES (?, ?, ?, ?, ?, ?)').bind(await sha(tok), uid, t, t, t + SESSION_DAYS * 864e5, (req.headers.get('user-agent') || '').slice(0, 160)),
    // حتى ٢٠ جهازًا للحساب، والجلسات المنتهية تُحذف
    db.prepare('DELETE FROM sessions WHERE uid = ?1 AND th NOT IN (SELECT th FROM sessions WHERE uid = ?1 ORDER BY seen_at DESC LIMIT 20)').bind(uid),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
  ]);
  return tok;
}
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا 0/O و1/I لتجنّب الخلط عند الإملاء
const newCode = () => [...rand(12)].map((b) => CODE_ABC[b & 31]).join('').replace(/(.{4})(?=.)/g, '$1-');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
const account = (db, email) => db.prepare('SELECT * FROM accounts WHERE email = ?').bind(email).first();
const authOut = async (db, acc, req) => ({ token: await newSession(db, acc.uid, req), user: { uid: acc.uid, email: acc.email } });

/* ═════════════ سياق الطلب: من أنا داخل هذه الجهة ═════════════ */
async function viewer(db, user, orgId) {
  if (!orgId) fail(400, 'no-org', 'لم تُحدَّد الجهة.');
  let me = await db.prepare('SELECT * FROM members WHERE org_id = ? AND (uid = ? OR (uid IS NULL AND email = ?))').bind(orgId, user.uid, user.email).first();
  if (!me || me.status === 'disabled') fail(403, 'not-member', 'لست عضوًا في هذه الجهة.');
  if (!me.uid) {
    // أول دخول بعد الدعوة: الحساب الداخلي يُربط برمز الدعوة فقط (لا يكفي تطابق البريد)،
    // وحساب Firebase القديم يُربط إن كان بريده مؤكَّدًا.
    if (user.local) fail(403, 'need-code', 'أدخل رمز الدعوة الذي أرسله لك مسؤول الجهة.');
    if (!user.verified) fail(403, 'verify-email', 'أكّد بريدك الإلكتروني أولًا.');
    const t = now();
    await db.batch([
      db.prepare("UPDATE members SET uid = ?, status = 'active', updated_at = ? WHERE id = ? AND uid IS NULL").bind(user.uid, t, me.id),
      auditQ(db, orgId, me.id, 'member.join', 'member', me.id, me.id, { email: me.email }),
    ]);
    me = { ...me, uid: user.uid, status: 'active' };
  }
  const subs = await subtree(db, orgId, me.id);
  return { ...me, isAdmin: me.role === 'admin', subs };
}

/** كل من تحت العضو على أي عمق (UNION يمنع الدوران اللانهائي). */
async function subtree(db, orgId, memberId) {
  const { results } = await db.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM members WHERE org_id = ?1 AND manager_id = ?2
      UNION SELECT m.id FROM members m JOIN sub ON m.manager_id = sub.id WHERE m.org_id = ?1)
    SELECT id FROM sub`).bind(orgId, memberId).all();
  return new Set(results.map((r) => r.id));
}
const canSee = (v, mid) => v.isAdmin || v.id === mid || v.subs.has(mid);
const canReview = (v, mid) => v.id !== mid && (v.isAdmin || v.subs.has(mid));
const needAdmin = (v) => { if (!v.isAdmin) fail(403, 'forbidden', 'هذا الإجراء لمسؤول الجهة فقط.'); };

function auditQ(db, orgId, actorId, action, entity, entityId, subjectId, data = {}) {
  return db.prepare('INSERT INTO audit (org_id, at, actor_id, action, entity, entity_id, subject_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(orgId, now(), actorId, action, entity, entityId, subjectId, JSON.stringify(data).slice(0, 8000));
}

/* ═════════════ تحويل الصفوف للواجهة ═════════════ */
const pubMember = (m, full) => (full
  ? { id: m.id, email: m.email, name: m.name, role: m.role, department_id: m.department_id, section_id: m.section_id, position_id: m.position_id, manager_id: m.manager_id, status: m.status, joined: !!m.uid }
  : { id: m.id, name: m.name, role: m.role, department_id: m.department_id, section_id: m.section_id, position_id: m.position_id }); // المدير المباشر: الاسم فقط
const pubReport = (r) => r && ({ id: r.id, member_id: r.member_id, date: r.date, status: r.status, note: r.note, late: !!r.late, submitted_at: r.submitted_at, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, review_comment: r.review_comment, updated_at: r.updated_at });
const pubItem = (i) => ({ id: i.id, text: i.text, responsibility_id: i.responsibility_id, minutes: i.minutes, state: i.state, blocker: i.blocker });

/* ═════════════ المسارات ═════════════ */
const routes = [];
const route = (method, pattern, fn, opt = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, ...opt });

route('GET', '/api/health', async ({ env }) => ({ ok: true, app: 'itrack', schema: MIGRATIONS.length, auth: 'local', signup: env.SIGNUP === 'invite' ? 'invite' : 'open', ai: aiProvider(env) }));

/* ───── الدخول ───── */
route('POST', '/api/auth/signup', async ({ db, env, req, body }) => {
  const email = low(body.email);
  if (!isEmail(email)) fail(400, 'invalid', 'البريد غير صحيح.');
  const pass = checkPass(body.password);
  await throttle(db, 'signup:' + ipOf(req), 20, 3600_000);
  await bump(db, 'signup:' + ipOf(req), 3600_000);
  if (env.SIGNUP === 'invite' && (await db.prepare('SELECT 1 FROM accounts LIMIT 1').first())) fail(403, 'invite-only', 'التسجيل على هذا الخادم بدعوة فقط: استخدم «عندي رمز».');
  if (await account(db, email)) fail(409, 'exists', 'لهذا البريد حساب بالفعل. اختر «دخول».');
  const h = await hashPass(env, pass); const t = now();
  const acc = { uid: 'u_' + id(), email };
  await db.prepare('INSERT INTO accounts (uid, email, hash, salt, iters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(acc.uid, email, h.hash, h.salt, h.iters, t, t).run();
  return authOut(db, acc, req);
});
route('POST', '/api/auth/login', async ({ db, env, req, body }) => {
  const email = low(body.email);
  const key = 'login:' + email;
  await throttle(db, key, 10, 15 * 60_000);
  const acc = isEmail(email) && typeof body.password === 'string' ? await account(db, email) : null;
  if (!acc || acc.disabled || !same(await pbkdf2(body.password, acc.salt, acc.iters), acc.hash)) {
    await bump(db, key, 15 * 60_000);
    fail(401, 'bad-login', 'البريد أو كلمة المرور غير صحيحة.');
  }
  await db.prepare('DELETE FROM throttle WHERE k = ?').bind(key).run();
  if (acc.iters < itersOf(env)) { const h = await hashPass(env, body.password); await db.prepare('UPDATE accounts SET hash = ?, salt = ?, iters = ?, updated_at = ? WHERE uid = ?').bind(h.hash, h.salt, h.iters, now(), acc.uid).run(); }
  return authOut(db, acc, req);
});
/** رمز من المسؤول: دعوة (انضمام للجهة، وينشئ الحساب إن لم يوجد) أو إعادة تعيين كلمة المرور. */
route('POST', '/api/auth/code', async ({ db, env, req, body }) => {
  const email = low(body.email);
  const code = normCode(body.code);
  await throttle(db, 'code:' + ipOf(req), 20, 3600_000);
  const t = now();
  const c = isEmail(email) && code.length === 12 ? await db.prepare('SELECT * FROM codes WHERE ch = ? AND email = ? AND used_at IS NULL AND expires_at > ?').bind(await sha(code), email, t).first() : null;
  if (!c) { await bump(db, 'code:' + ipOf(req), 3600_000); fail(400, 'bad-code', 'الرمز غير صحيح أو منتهٍ، أو البريد لا يطابقه. اطلب رمزًا جديدًا من المسؤول.'); }
  let acc = await account(db, email);
  const stmts = [db.prepare('UPDATE codes SET used_at = ? WHERE ch = ?').bind(t, c.ch)];
  if (acc && c.kind === 'invite' && body.password !== undefined && !acc.disabled && !same(await pbkdf2(String(body.password), acc.salt, acc.iters), acc.hash)) {
    fail(401, 'bad-login', 'لهذا البريد حساب: اكتب كلمة مروره الحالية، أو اطلب من المسؤول رمز إعادة تعيين.');
  }
  if (!acc) {
    const h = await hashPass(env, checkPass(body.password));
    acc = { uid: 'u_' + id(), email };
    stmts.push(db.prepare('INSERT INTO accounts (uid, email, hash, salt, iters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(acc.uid, email, h.hash, h.salt, h.iters, t, t));
  } else if (c.kind === 'reset') {
    const h = await hashPass(env, checkPass(body.password));
    stmts.push(db.prepare('UPDATE accounts SET hash = ?, salt = ?, iters = ?, disabled = 0, updated_at = ? WHERE uid = ?').bind(h.hash, h.salt, h.iters, t, acc.uid));
    stmts.push(db.prepare('DELETE FROM sessions WHERE uid = ?').bind(acc.uid));
  }
  if (c.kind === 'invite') {
    stmts.push(db.prepare("UPDATE members SET uid = ?, status = 'active', updated_at = ? WHERE id = ? AND org_id = ? AND uid IS NULL AND status != 'disabled'").bind(acc.uid, t, c.member_id, c.org_id));
    stmts.push(auditQ(db, c.org_id, c.member_id, 'member.join', 'member', c.member_id, c.member_id, { email }));
  } else stmts.push(auditQ(db, c.org_id, c.member_id, 'member.password', 'member', c.member_id, c.member_id, { by: c.created_by }));
  await db.batch(stmts);
  return { ...(await authOut(db, acc, req)), org: c.org_id, kind: c.kind };
});
route('POST', '/api/auth/logout', async ({ db, user }) => {
  if (user.th) await db.prepare('DELETE FROM sessions WHERE th = ?').bind(user.th).run();
  return { ok: true };
});
route('POST', '/api/auth/password', async ({ db, env, user, body }) => {
  if (!user.local) fail(400, 'invalid', 'هذا الحساب يُدار من مزوّد دخول خارجي.');
  const acc = await db.prepare('SELECT * FROM accounts WHERE uid = ?').bind(user.uid).first();
  if (!acc || !same(await pbkdf2(String(body.old || ''), acc.salt, acc.iters), acc.hash)) fail(401, 'bad-login', 'كلمة المرور الحالية غير صحيحة.');
  const h = await hashPass(env, checkPass(body.password));
  await db.batch([
    db.prepare('UPDATE accounts SET hash = ?, salt = ?, iters = ?, updated_at = ? WHERE uid = ?').bind(h.hash, h.salt, h.iters, now(), acc.uid),
    db.prepare('DELETE FROM sessions WHERE uid = ? AND th != ?').bind(acc.uid, user.th), // الخروج من الأجهزة الأخرى
  ]);
  return { ok: true };
});

/** حسابي والجهات التي أنتمي إليها (أو دُعيت إليها). */
route('GET', '/api/me', async ({ db, user }) => {
  const { results } = await db.prepare(`SELECT m.id AS member_id, m.name, m.role, m.status, m.uid, o.id, o.name AS org_name
    FROM members m JOIN orgs o ON o.id = m.org_id WHERE (m.uid = ? OR (m.uid IS NULL AND m.email = ?)) AND m.status != 'disabled'`).bind(user.uid, user.email).all();
  return { email: user.email, verified: user.verified, orgs: results.map((r) => ({ id: r.id, name: r.org_name, role: r.role, member_id: r.member_id, my_name: r.name, invited: !r.uid })) };
});

/** إنشاء جهة جديدة: المنشئ يصبح مسؤولها. */
route('POST', '/api/orgs', async ({ db, env, user, body }) => {
  if (!user.verified) fail(403, 'verify-email', 'أكّد بريدك الإلكتروني أولًا.');
  if (env.SIGNUP === 'invite') {
    // سيرفر شركة: الجهة الأولى ينشئها أول حساب، وبعدها مسؤولو الجهات فقط
    const any = await db.prepare('SELECT 1 FROM orgs LIMIT 1').first();
    const adm = any && await db.prepare("SELECT 1 FROM members WHERE uid = ? AND role = 'admin' AND status = 'active' LIMIT 1").bind(user.uid).first();
    if (any && !adm) fail(403, 'forbidden', 'إنشاء الجهات على هذا الخادم لمسؤوليه فقط.');
  }
  const name = text(body.name, 80, { required: true, label: 'اسم الجهة' });
  const myName = text(body.my_name, 60, { required: true, label: 'اسمك' });
  const own = await db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE created_by = ?").bind(user.uid).first();
  if (own.n >= 3) fail(429, 'limit', 'الحد ثلاث جهات لكل حساب.');
  const orgId = id(); const mid = id(); const t = now();
  await db.batch([
    db.prepare('INSERT INTO orgs (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').bind(orgId, name, t, user.uid),
    db.prepare("INSERT INTO members (id, org_id, email, uid, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, ?)").bind(mid, orgId, user.email, user.uid, myName, t, t),
    auditQ(db, orgId, mid, 'org.create', 'org', orgId, mid, { name }),
  ]);
  return { id: orgId, member_id: mid };
});

/** كل ما تحتاجه الواجهة عند الفتح، مقيّدًا بما يحق لي رؤيته. */
route('GET', '/api/bootstrap', async ({ db, v }) => {
  const org = await db.prepare('SELECT id, name FROM orgs WHERE id = ?').bind(v.org_id).first();
  const [mem, deps, pos, resp, secs] = await db.batch([
    db.prepare('SELECT * FROM members WHERE org_id = ? ORDER BY name').bind(v.org_id),
    db.prepare('SELECT id, name, active FROM departments WHERE org_id = ? ORDER BY name').bind(v.org_id),
    db.prepare('SELECT id, title, department_id, summary, version, active FROM positions WHERE org_id = ? ORDER BY title').bind(v.org_id),
    db.prepare('SELECT id, position_id, title, detail, sort, active FROM responsibilities WHERE org_id = ? ORDER BY sort').bind(v.org_id),
    db.prepare('SELECT id, department_id, name, active FROM sections WHERE org_id = ? ORDER BY name').bind(v.org_id),
  ]);
  const all = mem.results;
  const visible = all.filter((m) => canSee(v, m.id)).map((m) => pubMember(m, true));
  // مدير الموظف المباشر يظهر بالاسم فقط حتى لو لم يكن ضمن من يراهم
  const ids = new Set(visible.map((m) => m.id));
  for (const m of visible) if (m.manager_id && !ids.has(m.manager_id)) {
    const mg = all.find((x) => x.id === m.manager_id); if (mg) { visible.push(pubMember(mg, false)); ids.add(mg.id); }
  }
  const posIds = new Set(v.isAdmin ? pos.results.map((p) => p.id) : visible.map((m) => m.position_id).filter(Boolean));
  return {
    org, me: { ...pubMember(v, true), subs: [...v.subs] },
    members: visible,
    departments: deps.results,
    sections: secs.results,
    positions: pos.results.filter((p) => posIds.has(p.id)).map((p) => ({ ...p, responsibilities: resp.results.filter((r) => r.position_id === p.id) })),
  };
});

/* ───── الهيكل: إدارات ووظائف (المسؤول) ───── */
route('POST', '/api/departments', async ({ db, v, body }) => {
  needAdmin(v);
  const name = text(body.name, 80, { required: true, label: 'اسم الإدارة' });
  const did = id();
  await db.batch([
    db.prepare('INSERT INTO departments (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').bind(did, v.org_id, name, now()),
    auditQ(db, v.org_id, v.id, 'department.create', 'department', did, null, { name }),
  ]);
  return { id: did };
});
route('PATCH', '/api/departments/:id', async ({ db, v, body, p }) => {
  needAdmin(v);
  const d = await db.prepare('SELECT * FROM departments WHERE id = ? AND org_id = ?').bind(p.id, v.org_id).first();
  if (!d) fail(404, 'not-found', 'الإدارة غير موجودة.');
  const name = body.name !== undefined ? text(body.name, 80, { required: true, label: 'اسم الإدارة' }) : d.name;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : d.active;
  await db.batch([
    db.prepare('UPDATE departments SET name = ?, active = ? WHERE id = ?').bind(name, active, d.id),
    auditQ(db, v.org_id, v.id, 'department.update', 'department', d.id, null, { from: { name: d.name, active: d.active }, to: { name, active } }),
  ]);
  return { ok: true };
});

route('POST', '/api/sections', async ({ db, v, body }) => {
  needAdmin(v);
  const name = text(body.name, 80, { required: true, label: 'اسم القسم' });
  if (!(await db.prepare('SELECT 1 FROM departments WHERE id = ? AND org_id = ?').bind(body.department_id, v.org_id).first())) fail(400, 'invalid', 'الإدارة غير صحيحة.');
  const sid = id();
  await db.batch([
    db.prepare('INSERT INTO sections (id, org_id, department_id, name, created_at) VALUES (?, ?, ?, ?, ?)').bind(sid, v.org_id, body.department_id, name, now()),
    auditQ(db, v.org_id, v.id, 'section.create', 'section', sid, null, { name, department_id: body.department_id }),
  ]);
  return { id: sid };
});
route('PATCH', '/api/sections/:id', async ({ db, v, body, p }) => {
  needAdmin(v);
  const x = await db.prepare('SELECT * FROM sections WHERE id = ? AND org_id = ?').bind(p.id, v.org_id).first();
  if (!x) fail(404, 'not-found', 'القسم غير موجود.');
  const name = body.name !== undefined ? text(body.name, 80, { required: true, label: 'اسم القسم' }) : x.name;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : x.active;
  await db.batch([
    db.prepare('UPDATE sections SET name = ?, active = ? WHERE id = ?').bind(name, active, x.id),
    auditQ(db, v.org_id, v.id, 'section.update', 'section', x.id, null, { from: { name: x.name, active: x.active }, to: { name, active } }),
  ]);
  return { ok: true };
});

/** إنشاء وظيفة أو تعديلها مع مسؤولياتها. المسؤولية المحذوفة تُعطَّل ولا تُمسح. */
async function savePosition(db, v, body, existing) {
  needAdmin(v);
  const title = text(body.title, 100, { required: true, label: 'المسمّى الوظيفي' });
  const summary = text(body.summary, 1000);
  const depId = body.department_id || null;
  if (depId && !(await db.prepare('SELECT 1 FROM departments WHERE id = ? AND org_id = ?').bind(depId, v.org_id).first())) fail(400, 'invalid', 'الإدارة غير صحيحة.');
  const list = Array.isArray(body.responsibilities) ? body.responsibilities.slice(0, 40) : [];
  const pid = existing?.id || id();
  const old = existing ? (await db.prepare('SELECT * FROM responsibilities WHERE position_id = ?').bind(pid).all()).results : [];
  const oldMap = new Map(old.map((r) => [r.id, r]));
  const stmts = [];
  const keep = new Set();
  let changed = !existing || existing.title !== title || existing.summary !== summary || existing.department_id !== depId;
  list.forEach((r, i) => {
    const t = text(r?.title, 160); if (!t) return;
    const d = text(r?.detail, 800);
    const prev = r?.id && oldMap.get(r.id);
    if (prev) {
      keep.add(prev.id);
      if (prev.title !== t || prev.detail !== d || prev.sort !== i || !prev.active) {
        changed = true;
        stmts.push(db.prepare('UPDATE responsibilities SET title = ?, detail = ?, sort = ?, active = 1 WHERE id = ?').bind(t, d, i, prev.id));
      }
    } else {
      changed = true;
      stmts.push(db.prepare('INSERT INTO responsibilities (id, org_id, position_id, title, detail, sort) VALUES (?, ?, ?, ?, ?, ?)').bind(id(), v.org_id, pid, t, d, i));
    }
  });
  for (const r of old) if (!keep.has(r.id) && r.active) { changed = true; stmts.push(db.prepare('UPDATE responsibilities SET active = 0 WHERE id = ?').bind(r.id)); }
  if (!changed) return { id: pid, version: existing.version };
  const version = existing ? existing.version + 1 : 1;
  stmts.unshift(existing
    ? db.prepare('UPDATE positions SET title = ?, summary = ?, department_id = ?, version = ?, updated_at = ? WHERE id = ?').bind(title, summary, depId, version, now(), pid)
    : db.prepare('INSERT INTO positions (id, org_id, title, department_id, summary, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)').bind(pid, v.org_id, title, depId, summary, now()));
  stmts.push(auditQ(db, v.org_id, v.id, existing ? 'position.update' : 'position.create', 'position', pid, null,
    { title, version, responsibilities: list.map((r) => text(r?.title, 160)).filter(Boolean) }));
  await db.batch(stmts);
  return { id: pid, version };
}
route('POST', '/api/positions', ({ db, v, body }) => savePosition(db, v, body, null));
route('PUT', '/api/positions/:id', async ({ db, v, body, p }) => {
  const ex = await db.prepare('SELECT * FROM positions WHERE id = ? AND org_id = ?').bind(p.id, v.org_id).first();
  if (!ex) fail(404, 'not-found', 'الوظيفة غير موجودة.');
  return savePosition(db, v, body, ex);
});

/* ───── الأعضاء (المسؤول) ───── */
async function checkRefs(db, v, f, selfId) {
  if (f.department_id && !(await db.prepare('SELECT 1 FROM departments WHERE id = ? AND org_id = ?').bind(f.department_id, v.org_id).first())) fail(400, 'invalid', 'الإدارة غير صحيحة.');
  if (f.section_id) {
    const sec = await db.prepare('SELECT department_id FROM sections WHERE id = ? AND org_id = ?').bind(f.section_id, v.org_id).first();
    if (!sec) fail(400, 'invalid', 'القسم غير صحيح.');
    if (f.department_id && sec.department_id !== f.department_id) fail(400, 'invalid', 'القسم لا يتبع هذه الإدارة.');
  }
  if (f.position_id && !(await db.prepare('SELECT 1 FROM positions WHERE id = ? AND org_id = ?').bind(f.position_id, v.org_id).first())) fail(400, 'invalid', 'الوظيفة غير صحيحة.');
  if (f.manager_id) {
    if (f.manager_id === selfId) fail(400, 'invalid', 'لا يكون الموظف مدير نفسه.');
    if (!(await db.prepare("SELECT 1 FROM members WHERE id = ? AND org_id = ? AND status != 'disabled'").bind(f.manager_id, v.org_id).first())) fail(400, 'invalid', 'المدير غير صحيح.');
    if (selfId && (await subtree(db, v.org_id, selfId)).has(f.manager_id)) fail(400, 'cycle', 'لا يكون المدير ممن يتبعون هذا الموظف.');
  }
}
const memberFields = (body) => ({
  name: text(body.name, 60, { required: true, label: 'الاسم' }),
  role: ROLES.includes(body.role) ? body.role : 'employee',
  department_id: body.department_id || null,
  section_id: body.section_id || null,
  position_id: body.position_id || null,
  manager_id: body.manager_id || null,
});
route('POST', '/api/members', async ({ db, v, body }) => {
  needAdmin(v);
  const email = low(body.email);
  if (!isEmail(email)) fail(400, 'invalid', 'البريد غير صحيح.');
  const f = memberFields(body);
  await checkRefs(db, v, f, null);
  if (await db.prepare('SELECT 1 FROM members WHERE org_id = ? AND email = ?').bind(v.org_id, email).first()) fail(409, 'exists', 'هذا البريد مضاف مسبقًا.');
  const count = await db.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id = ?').bind(v.org_id).first();
  if (count.n >= 300) fail(429, 'limit', 'الحد ٣٠٠ عضو للجهة في النسخة التجريبية.');
  const mid = id(); const t = now();
  await db.batch([
    db.prepare("INSERT INTO members (id, org_id, email, name, role, department_id, section_id, position_id, manager_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'invited', ?, ?)")
      .bind(mid, v.org_id, email, f.name, f.role, f.department_id, f.section_id, f.position_id, f.manager_id, t, t),
    auditQ(db, v.org_id, v.id, 'member.invite', 'member', mid, mid, { email, ...f }),
  ]);
  return { id: mid, ...(await issueCode(db, v, { id: mid, email, uid: null, status: 'invited' })) };
});
/** رمز دعوة (لمن لم ينضم) أو رمز إعادة تعيين كلمة المرور (لمن انضم). يُعرض مرة واحدة ويُحفظ مجزّأً. */
async function issueCode(db, v, m) {
  if (m.status === 'disabled') fail(400, 'invalid', 'الحساب معطّل.');
  const kind = m.uid ? 'reset' : 'invite';
  if (kind === 'reset') {
    if (!m.uid.startsWith('u_')) fail(400, 'invalid', 'هذا العضو يدخل بحساب خارجي قديم.');
    // لا يعيد مسؤول جهة كلمة مرور حساب ينتمي لجهات أخرى (حماية بين الجهات على نفس الخادم)
    const other = await db.prepare("SELECT 1 FROM members WHERE uid = ? AND org_id != ? AND status != 'disabled' LIMIT 1").bind(m.uid, v.org_id).first();
    if (other) fail(403, 'multi-org', 'هذا الحساب عضو في جهات أخرى؛ لا تُعاد كلمة مروره من هنا.');
  }
  const code = newCode(); const t = now();
  const expires_at = t + (kind === 'invite' ? 14 : 1) * 864e5;
  await db.batch([
    db.prepare('DELETE FROM codes WHERE member_id = ? AND used_at IS NULL').bind(m.id),
    db.prepare('INSERT INTO codes (ch, kind, email, org_id, member_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(await sha(normCode(code)), kind, m.email, v.org_id, m.id, v.id, t, expires_at),
    auditQ(db, v.org_id, v.id, kind === 'invite' ? 'member.code' : 'member.reset', 'member', m.id, m.id, {}),
  ]);
  return { code, kind, expires_at };
}
route('POST', '/api/members/:id/code', async ({ db, v, p }) => {
  needAdmin(v);
  const m = await db.prepare('SELECT * FROM members WHERE id = ? AND org_id = ?').bind(p.id, v.org_id).first();
  if (!m) fail(404, 'not-found', 'العضو غير موجود.');
  return issueCode(db, v, m);
});
route('PATCH', '/api/members/:id', async ({ db, v, body, p }) => {
  needAdmin(v);
  const m = await db.prepare('SELECT * FROM members WHERE id = ? AND org_id = ?').bind(p.id, v.org_id).first();
  if (!m) fail(404, 'not-found', 'العضو غير موجود.');
  const f = memberFields({ ...m, ...body });
  const status = body.status === 'disabled' ? 'disabled' : body.status === 'active' ? (m.uid ? 'active' : 'invited') : m.status;
  await checkRefs(db, v, f, m.id);
  if (m.role === 'admin' && (f.role !== 'admin' || status === 'disabled')) {
    const admins = await db.prepare("SELECT COUNT(*) AS n FROM members WHERE org_id = ? AND role = 'admin' AND status != 'disabled'").bind(v.org_id).first();
    if (admins.n <= 1) fail(400, 'last-admin', 'لا بد من مسؤول واحد نشط على الأقل.');
  }
  const diff = {};
  for (const k of ['name', 'role', 'department_id', 'section_id', 'position_id', 'manager_id']) if (m[k] !== f[k]) diff[k] = [m[k], f[k]];
  if (m.status !== status) diff.status = [m.status, status];
  if (!Object.keys(diff).length) return { ok: true };
  await db.batch([
    db.prepare('UPDATE members SET name = ?, role = ?, department_id = ?, section_id = ?, position_id = ?, manager_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(f.name, f.role, f.department_id, f.section_id, f.position_id, f.manager_id, status, now(), m.id),
    auditQ(db, v.org_id, v.id, 'member.update', 'member', m.id, m.id, diff),
  ]);
  return { ok: true };
});

/* ───── التقارير اليومية ───── */
async function reportOf(db, memberId, date) {
  const r = await db.prepare('SELECT * FROM reports WHERE member_id = ? AND date = ?').bind(memberId, date).first();
  if (!r) return { report: null, items: [] };
  const { results } = await db.prepare('SELECT * FROM report_items WHERE report_id = ? ORDER BY sort').bind(r.id).all();
  return { report: r, items: results };
}
function checkDay(date, today, returned = false) {
  if (!isDay(date)) fail(400, 'invalid', 'التاريخ غير صحيح.');
  const t = isDay(today) ? today : dayOf(now());
  // تاريخ الجهاز قد يسبق توقيت الخادم بيوم (فرق المناطق الزمنية)
  if (date > addDays(dayOf(now()), 1)) fail(400, 'future', 'لا يُكتب تقرير ليوم لم يأتِ.');
  if (!returned && date < addDays(t, -LATE_DAYS)) fail(400, 'too-old', `يُكتب التقرير خلال ${LATE_DAYS} أيام فقط.`);
  return t;
}

/** تقرير عضو ليوم. مسودة غيري لا تُعرض: الحالة فقط. */
route('GET', '/api/report', async ({ db, v, q }) => {
  const mid = q.get('member') || v.id; const date = q.get('date');
  if (!isDay(date)) fail(400, 'invalid', 'التاريخ غير صحيح.');
  if (!canSee(v, mid)) fail(403, 'forbidden', 'لا تملك صلاحية عرض هذا الموظف.');
  const { report, items } = await reportOf(db, mid, date);
  const hidden = report && report.status === 'draft' && mid !== v.id;
  const trail = report && !hidden
    ? (await db.prepare("SELECT a.at, a.action, a.data, m.name AS actor FROM audit a LEFT JOIN members m ON m.id = a.actor_id WHERE a.org_id = ? AND a.entity = 'report' AND a.entity_id = ? ORDER BY a.at").bind(v.org_id, report.id).all()).results
      .map((a) => ({ at: a.at, action: a.action, actor: a.actor, comment: JSON.parse(a.data).comment || '' }))
    : [];
  return { report: hidden ? { status: 'draft', member_id: mid, date } : pubReport(report), items: hidden ? [] : items.map(pubItem), trail, can_review: canReview(v, mid) };
});

/** حفظ تقريري (مسودة أو مُعاد للتعديل). البنود تُستبدل دفعة واحدة. */
route('PUT', '/api/report/:date', async ({ db, v, body, p }) => {
  const date = p.date;
  const { report } = await reportOf(db, v.id, date);
  const today = checkDay(date, body.today, report?.status === 'returned');
  const pos = v.position_id;
  const allowed = new Set(pos ? (await db.prepare('SELECT id FROM responsibilities WHERE position_id = ? AND active = 1').bind(pos).all()).results.map((r) => r.id) : []);
  if (report && !['draft', 'returned'].includes(report.status)) fail(409, 'locked', 'التقرير مرفوع ولا يُعدَّل إلا إذا أُعيد إليك.');
  const raw = Array.isArray(body.items) ? body.items : [];
  if (raw.length > MAX_ITEMS) fail(400, 'too-many', `الحد ${MAX_ITEMS} بندًا لليوم.`);
  const items = raw.map((it, i) => {
    const state = STATES.includes(it?.state) ? it.state : 'done';
    const resp = it?.responsibility_id && allowed.has(it.responsibility_id) ? it.responsibility_id : null;
    const minutes = Number.isInteger(it?.minutes) && it.minutes > 0 && it.minutes <= 960 ? it.minutes : null;
    return { id: typeof it?.id === 'string' && /^[\w-]{8,40}$/.test(it.id) ? it.id : id(), text: text(it?.text, 600), responsibility_id: resp, minutes, state, blocker: state === 'blocked' ? text(it?.blocker, 400) : '', sort: i };
  }).filter((it) => it.text);
  const total = items.reduce((s, x) => s + (x.minutes || 0), 0);
  if (total > 24 * 60) fail(400, 'invalid', 'مجموع الوقت أكثر من ٢٤ ساعة.');
  const note = text(body.note, 2000);
  const t = now();
  const rid = report?.id || id();
  const stmts = [
    report
      ? db.prepare('UPDATE reports SET note = ?, updated_at = ? WHERE id = ?').bind(note, t, rid)
      : db.prepare("INSERT INTO reports (id, org_id, member_id, date, status, note, late, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)").bind(rid, v.org_id, v.id, date, note, date < today ? 1 : 0, t, t),
    db.prepare('DELETE FROM report_items WHERE report_id = ?').bind(rid),
    ...items.map((it) => db.prepare('INSERT INTO report_items (id, report_id, org_id, member_id, date, text, responsibility_id, minutes, state, blocker, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(it.id, rid, v.org_id, v.id, date, it.text, it.responsibility_id, it.minutes, it.state, it.blocker, it.sort)),
  ];
  if (!report) stmts.push(auditQ(db, v.org_id, v.id, 'report.create', 'report', rid, v.id, { date }));
  await db.batch(stmts);
  return { id: rid, status: report?.status || 'draft', updated_at: t, items: items.map(pubItem) };
});

/** رفع التقرير: تُحفظ في السجل نسخة كاملة مما رُفع (دليل لا يتغيّر). */
route('POST', '/api/report/:date/submit', async ({ db, v, body, p }) => {
  const { report, items } = await reportOf(db, v.id, p.date);
  checkDay(p.date, body.today, report?.status === 'returned');
  if (!report || !items.length) fail(400, 'empty', 'أضف بندًا واحدًا على الأقل قبل الرفع.');
  if (!['draft', 'returned'].includes(report.status)) fail(409, 'locked', 'التقرير مرفوع مسبقًا.');
  const t = now();
  await db.batch([
    db.prepare("UPDATE reports SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft','returned')").bind(t, t, report.id),
    auditQ(db, v.org_id, v.id, report.status === 'returned' ? 'report.resubmit' : 'report.submit', 'report', report.id, v.id,
      { date: p.date, note: report.note, items: items.map((i) => ({ text: i.text, responsibility_id: i.responsibility_id, minutes: i.minutes, state: i.state, blocker: i.blocker })) }),
  ]);
  return { status: 'submitted', submitted_at: t };
});

/** المدير (أو من فوقه، أو المسؤول): اعتماد، إعادة للتعديل، أو ملاحظة. */
route('POST', '/api/review', async ({ db, v, body }) => {
  const mid = body.member_id; const date = body.date;
  if (!isDay(date)) fail(400, 'invalid', 'التاريخ غير صحيح.');
  if (!canReview(v, mid)) fail(403, 'forbidden', 'لا تملك صلاحية مراجعة هذا التقرير.');
  const action = body.action;
  const comment = text(body.comment, 1000);
  const r = await db.prepare('SELECT * FROM reports WHERE member_id = ? AND date = ?').bind(mid, date).first();
  if (!r) fail(404, 'not-found', 'لا يوجد تقرير.');
  const t = now();
  let status = r.status;
  if (action === 'approve') { if (r.status !== 'submitted') fail(409, 'state', 'يُعتمد التقرير المرفوع فقط.'); status = 'approved'; }
  else if (action === 'return') { if (r.status !== 'submitted') fail(409, 'state', 'يُعاد التقرير المرفوع فقط.'); if (!comment) fail(400, 'invalid', 'اكتب سبب الإعادة.'); status = 'returned'; }
  else if (action === 'comment') { if (!['submitted', 'approved', 'returned'].includes(r.status) || !comment) fail(400, 'invalid', 'اكتب الملاحظة.'); }
  else fail(400, 'invalid', 'إجراء غير معروف.');
  await db.batch([
    db.prepare('UPDATE reports SET status = ?, reviewed_by = ?, reviewed_at = ?, review_comment = ?, updated_at = ? WHERE id = ?')
      .bind(status, v.id, t, comment || r.review_comment, t, r.id),
    auditQ(db, v.org_id, v.id, `report.${action}`, 'report', r.id, mid, { date, comment }),
  ]);
  return { status };
});

/** لوحة اليوم: حالة كل من يحق لي رؤيته. */
route('GET', '/api/day', async ({ db, v, q }) => {
  const date = q.get('date');
  if (!isDay(date)) fail(400, 'invalid', 'التاريخ غير صحيح.');
  const { results } = await db.prepare(`SELECT r.member_id, r.status, r.late, r.submitted_at, r.reviewed_at,
      COUNT(i.id) AS items, COALESCE(SUM(i.minutes), 0) AS minutes, SUM(CASE WHEN i.state = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM reports r LEFT JOIN report_items i ON i.report_id = r.id WHERE r.org_id = ? AND r.date = ? GROUP BY r.id`).bind(v.org_id, date).all();
  return {
    date,
    rows: results.filter((r) => canSee(v, r.member_id)).map((r) => (r.status === 'draft' && r.member_id !== v.id
      ? { member_id: r.member_id, status: 'draft' }
      : { member_id: r.member_id, status: r.status, late: !!r.late, items: r.items, minutes: r.minutes, blocked: r.blocked || 0, submitted_at: r.submitted_at })),
  };
});

/** سجل عضو لفترة (حتى ٩٢ يومًا) + تغطية مسؤولياته. */
route('GET', '/api/history', async ({ db, v, q }) => {
  const mid = q.get('member') || v.id; const from = q.get('from'); const to = q.get('to');
  if (!isDay(from) || !isDay(to) || from > to || addDays(from, 92) < to) fail(400, 'invalid', 'الفترة غير صحيحة.');
  if (!canSee(v, mid)) fail(403, 'forbidden', 'لا تملك صلاحية عرض هذا الموظف.');
  const own = mid === v.id;
  const [days, cov] = await db.batch([
    db.prepare(`SELECT r.date, r.status, r.late, COUNT(i.id) AS items, COALESCE(SUM(i.minutes), 0) AS minutes,
        SUM(CASE WHEN i.state = 'blocked' THEN 1 ELSE 0 END) AS blocked
      FROM reports r LEFT JOIN report_items i ON i.report_id = r.id WHERE r.member_id = ? AND r.date BETWEEN ? AND ? GROUP BY r.id ORDER BY r.date`).bind(mid, from, to),
    db.prepare(`SELECT i.responsibility_id AS rid, COUNT(*) AS n, COALESCE(SUM(i.minutes), 0) AS minutes FROM report_items i JOIN reports r ON r.id = i.report_id
      WHERE i.member_id = ? AND i.date BETWEEN ? AND ? AND (r.status != 'draft' OR ?) GROUP BY i.responsibility_id`).bind(mid, from, to, own ? 1 : 0),
  ]);
  return {
    days: days.results.map((d) => (d.status === 'draft' && !own ? { date: d.date, status: 'draft' } : { ...d, late: !!d.late })),
    coverage: cov.results,
  };
});

/** صندوق الوارد: تقارير مرفوعة تنتظر مراجعتي (آخر ١٤ يومًا، الأقدم أولًا)، وتقاريري المُعادة لي للتعديل. */
route('GET', '/api/inbox', async ({ db, v, q }) => {
  const t = isDay(q.get('today')) ? q.get('today') : dayOf(now());
  const from = addDays(t, -14);
  const [sub, ret] = await db.batch([
    db.prepare("SELECT member_id, date, submitted_at, late FROM reports WHERE org_id = ? AND status = 'submitted' AND date >= ? AND member_id != ? ORDER BY date, submitted_at LIMIT 300").bind(v.org_id, from, v.id),
    db.prepare("SELECT date, review_comment, reviewed_at FROM reports WHERE member_id = ? AND status = 'returned' ORDER BY date LIMIT 30").bind(v.id),
  ]);
  return {
    review: sub.results.filter((r) => canReview(v, r.member_id)).slice(0, 100).map((r) => ({ member_id: r.member_id, date: r.date, submitted_at: r.submitted_at, late: !!r.late })),
    returned: ret.results,
  };
});

/* ───── المساحة الشخصية ─────
   وثائق JSON لكل عضو (مهام، مجالات، أهداف، مراجعات). لا يراها أحد غير صاحبها،
   إلا مهمة اختار صاحبها `shared:true` فتظهر لمن فوقه فقط (قراءة). لا تدخل سجل التدقيق عمدًا. */
const PCOLS = new Set(['areas', 'goals', 'tasks', 'reviews']);
const MAX_OPS = 40; // حد D1 المجاني ٥٠ استعلامًا لكل طلب
const MAX_DOC = 8000;
const PID = /^[\w.-]{1,64}$/;

/** توقيع خفيف (عدد + آخر تعديل لكل مجموعة) كي لا يسحب العميل كل الوثائق إن لم يتغير شيء. */
route('GET', '/api/p-sig', async ({ db, v }) => {
  const { results } = await db.prepare('SELECT col, COUNT(*) AS n, MAX(updated_at) AS m FROM pdocs WHERE member_id = ? GROUP BY col').bind(v.id).all();
  const sig = {}; for (const c of PCOLS) sig[c] = '0:0';
  for (const r of results) if (PCOLS.has(r.col)) sig[r.col] = `${r.n}:${r.m}`;
  return { sig };
});

route('GET', '/api/p/:col', async ({ db, v, p }) => {
  if (!PCOLS.has(p.col)) fail(404, 'not-found', 'المجموعة غير معروفة.');
  const { results } = await db.prepare('SELECT id, data, updated_at FROM pdocs WHERE member_id = ? AND col = ? ORDER BY updated_at DESC LIMIT 3000').bind(v.id, p.col).all();
  return { docs: results.map((r) => ({ id: r.id, updated_at: r.updated_at, ...JSON.parse(r.data) })) };
});

route('POST', '/api/p', async ({ db, v, body }) => {
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (!ops.length || ops.length > MAX_OPS) fail(400, 'invalid', `من 1 إلى ${MAX_OPS} عملية في الطلب.`);
  const t = now();
  const stmts = ops.map((o) => {
    if (!o || !PCOLS.has(o.col) || typeof o.id !== 'string' || !PID.test(o.id)) fail(400, 'invalid', 'عملية غير صحيحة.');
    if (o.op === 'del') return db.prepare('DELETE FROM pdocs WHERE member_id = ? AND col = ? AND id = ?').bind(v.id, o.col, o.id);
    if (!['set', 'patch'].includes(o.op) || !o.data || typeof o.data !== 'object' || Array.isArray(o.data)) fail(400, 'invalid', 'عملية غير صحيحة.');
    const { id: _i, updated_at: _u, ...data } = o.data;
    const raw = JSON.stringify(data);
    if (raw.length > MAX_DOC) fail(413, 'too-big', 'الوثيقة أكبر من المسموح.');
    const canShare = o.col === 'tasks' ? 1 : 0;
    const merged = o.op === 'patch' ? 'json_patch(pdocs.data, excluded.data)' : 'excluded.data';
    return db.prepare(`INSERT INTO pdocs (member_id, col, id, data, shared, updated_at) VALUES (?1, ?2, ?3, ?4, CASE WHEN ?6 = 1 AND json_extract(?4, '$.shared') = 1 THEN 1 ELSE 0 END, ?5)
      ON CONFLICT(member_id, col, id) DO UPDATE SET data = ${merged}, updated_at = excluded.updated_at,
        shared = CASE WHEN ?6 = 1 AND json_extract(${merged}, '$.shared') = 1 THEN 1 ELSE 0 END`).bind(v.id, o.col, o.id, raw, t, canShare);
  });
  await db.batch(stmts);
  return { ok: true, n: ops.length, at: t };
});

/** المهام التي اختار موظفوها إظهارها لي (من تحتي فقط، قراءة فقط). */
route('GET', '/api/team/tasks', async ({ db, v, q }) => {
  const mid = q.get('member');
  if (mid && !canSee(v, mid)) fail(403, 'forbidden', 'لا تملك صلاحية عرض هذا الموظف.');
  const { results } = mid
    ? await db.prepare("SELECT member_id, id, data, updated_at FROM pdocs WHERE col = 'tasks' AND shared = 1 AND member_id = ? ORDER BY updated_at DESC LIMIT 300").bind(mid).all()
    : await db.prepare("SELECT p.member_id, p.id, p.data, p.updated_at FROM pdocs p JOIN members m ON m.id = p.member_id WHERE p.col = 'tasks' AND p.shared = 1 AND m.org_id = ? ORDER BY p.updated_at DESC LIMIT 1500").bind(v.org_id).all();
  return { tasks: results.filter((r) => r.member_id !== v.id && canSee(v, r.member_id)).slice(0, 300).map((r) => ({ member_id: r.member_id, id: r.id, updated_at: r.updated_at, ...JSON.parse(r.data) })) };
});

/** سجل التدقيق: للمسؤول كاملًا، ولغيره ما يخص من يراهم. */
route('GET', '/api/audit', async ({ db, v, q }) => {
  const mid = q.get('member');
  const limit = Math.min(200, Number(q.get('limit')) || 100);
  let rows;
  if (mid) {
    if (!canSee(v, mid)) fail(403, 'forbidden', 'لا تملك الصلاحية.');
    rows = (await db.prepare('SELECT a.*, m.name AS actor FROM audit a LEFT JOIN members m ON m.id = a.actor_id WHERE a.org_id = ? AND a.subject_id = ? ORDER BY a.at DESC LIMIT ?').bind(v.org_id, mid, limit).all()).results;
  } else {
    needAdmin(v);
    rows = (await db.prepare('SELECT a.*, m.name AS actor FROM audit a LEFT JOIN members m ON m.id = a.actor_id WHERE a.org_id = ? ORDER BY a.at DESC LIMIT ?').bind(v.org_id, limit).all()).results;
  }
  return { rows: rows.map((a) => ({ at: a.at, action: a.action, entity: a.entity, subject_id: a.subject_id, actor: a.actor, data: JSON.parse(a.data) })) };
});

/* ═════════════ التشغيل ═════════════ */
/* ═════════════ الذكاء الاصطناعي: إدخال صوتي ومحضر اجتماع ═════════════
   مزوّدان بنفس الواجهة: Workers AI (ربط AI على Cloudflare، مجاني ضمن حصة يومية) أو أي خدمة متوافقة مع OpenAI
   عبر AI_URL (سحابية مثل OpenAI/Groq، أو محلية على سيرفر الشركة مثل whisper.cpp + Ollama ⇒ لا يخرج الصوت من الشركة).
   لا يُحفظ أي صوت أو نص على الخادم؛ يُعالج ويُعاد فورًا. حدود يومية لكل مستخدم. */
const STT = '@cf/openai/whisper-large-v3-turbo';
const LLM = '@cf/meta/llama-4-scout-17b-16e-instruct';
const DAY_LIMITS = { transcribe: 150, parse: 120, minutes: 20 };
const MAX_AUDIO_B64 = 6_200_000; // ≈ ٣ دقائق WAV 16kHz — التطبيق يقسّم التسجيل الطويل إلى مقاطع
function aiProvider(env) { return env.AI ? 'workers-ai' : env.AI_URL ? 'openai' : null; }
const aiBase = (env) => String(env.AI_URL).replace(/\/$/, '');
const aiHead = (env) => (env.AI_KEY ? { authorization: `Bearer ${env.AI_KEY}` } : {});

async function quota(db, uid, kind) {
  const day = dayOf(now());
  const r = await db.prepare('INSERT INTO ai_use (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n').bind(`${day}:${kind}:${uid}`).first();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM ai_use WHERE k < ?').bind(addDays(day, -3)).run();
  if ((r?.n || 0) > DAY_LIMITS[kind]) fail(429, 'ai-limit', 'وصلت الحد اليومي للذكاء الاصطناعي (يتجدد كل يوم).');
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
  if (env.AI) {
    try {
      const r = await env.AI.run(LLM, { messages, max_tokens: maxTokens, temperature: 0.1, response_format: { type: 'json_schema', json_schema: schema } });
      const j = pickJson(r); if (j) return j;
    } catch {}
    return pickJson(await env.AI.run(LLM, { messages, max_tokens: maxTokens, temperature: 0.1 }));
  }
  const r = await fetch(aiBase(env) + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...aiHead(env) },
    body: JSON.stringify({ model: env.AI_LLM_MODEL || 'gpt-4o-mini', messages, temperature: 0.1, max_tokens: maxTokens, response_format: { type: 'json_object' } }),
  });
  if (!r.ok) fail(502, 'ai-failed', 'تعذّر الوصول لخدمة الذكاء الاصطناعي.');
  return pickJson((await r.json())?.choices?.[0]?.message?.content);
}
async function transcribeAudio(env, audio, hint) {
  if (env.AI) {
    const r = await env.AI.run(STT, { audio, language: 'ar', vad_filter: true, condition_on_previous_text: false, ...(hint ? { initial_prompt: hint } : {}) });
    return tcut(r?.text, 20000);
  }
  const bin = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('file', new Blob([bin], { type: 'audio/wav' }), 'audio.wav');
  fd.append('model', env.AI_STT_MODEL || 'whisper-1'); fd.append('language', 'ar'); fd.append('response_format', 'json');
  if (hint) fd.append('prompt', hint);
  const r = await fetch(aiBase(env) + '/audio/transcriptions', { method: 'POST', headers: aiHead(env), body: fd });
  if (!r.ok) fail(502, 'ai-failed', 'تعذّر تفريغ الصوت.');
  return tcut((await r.json())?.text, 20000);
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

const PARSE_RULES = (today, weekday, areas, people) => `أنت تحوّل ملاحظة صوتية عربية (قد تكون بلهجة يمنية أو سعودية أو خليجية، وقد يحوي التفريغ أخطاء سمع) إلى عناصر منظمة لتطبيق مهام. أعد JSON فقط بالشكل {"items":[...]}.
اليوم ${today}${weekday ? ` (${weekday})` : ''}. الأسبوع يبدأ السبت.
- kind: "meeting" إن ذُكر اجتماع أو لقاء أو موعد مع أشخاص، وإلا "task".
- title: عنوان قصير بفصحى بسيطة يبدأ بفعل للمهمة، أو «اجتماع مع ...» للاجتماع. احذف من العنوان عبارات الوقت والتاريخ («الساعة ١٠ مساءً»، «بكرة») لأنها تذهب لحقليها. لا تخترع تفاصيل لم تُذكر.
- due: تاريخ YYYY-MM-DD إن ذُكر يوم أو تاريخ (بكرة/غدًا، بعد بكرة، الأحد، الأسبوع الجاي = السبت القادم...). إن ذُكر وقت بلا يوم فاجعل due = اليوم (${today}).
- time: HH:MM بنظام ٢٤ ساعة. افهم الأوقات هكذا بدقة:
  «الساعة عشرة مساءً/بالليل» = 22:00، «عشرة الصبح» = 10:00، «ثلاثة العصر» = 15:00، «ثمانية المغرب» = 20:00، «اثنا عشر الظهر» = 12:00، «اثنا عشر ليلًا» = 00:00،
  «ونص» = :30، «وربع» = :15، «إلا ربع» = ناقص ١٥ دقيقة (مثلًا «تسعة إلا ربع صباحًا» = 08:45)، «وثلث» = :20، «إلا ثلث» = ناقص ٢٠ دقيقة.
  إن لم يُذكر صباح أو مساء فاختر الأرجح لوقت العمل (الساعات ١–٦ بعد الظهر، ٧–١١ صباحًا).
- duration بالدقائق للاجتماع إن ذُكرت. place للمكان إن ذُكر.
- area: واحدة من هذه بالضبط إن كان واضحًا: ${areas.join('، ') || '(لا يوجد)'}. وإلا فارغ.
- assignee: اسم الشخص المكلّف إن قال «خلي فلان» أو «كلّف فلان». أشخاص معروفون (صحّح تهجئة الاسم إلى ما يطابقهم): ${people.join('، ') || '(لا يوجد)'}.
- important للمهم، urgent للعاجل أو «ضروري اليوم».
- ملاحظة واحدة قد تحوي عدة عناصر: افصلها.`;

async function parseText(env, text, today, weekday, areas, people) {
  const j = await llmJson(env, PARSE_RULES(today, weekday, areas, people), text, { name: 'items', schema: PARSE_SCHEMA }, 700);
  return cleanParsed(j, areas);
}
const MINUTES_RULES = (today, title, people) => `أنت أمين سر محترف تكتب محضر اجتماع عمل بالعربية الفصحى المختصرة من تفريغ صوتي قد يكون بلهجة يمنية ويحوي أخطاء تفريغ. أعد JSON فقط.
اليوم ${today}. ${title ? `موضوع الاجتماع: ${title}.` : ''}
- summary: ملخص من ٢ إلى ٤ جمل.
- attendees: أسماء من ذُكروا أو تحدثوا فقط. لا تخترع أسماء.
- decisions: القرارات المتفق عليها، كل قرار جملة واحدة.
- actions: المطلوب تنفيذه: title يبدأ بفعل، owner اسم المسؤول إن ذُكر (أشخاص معروفون: ${people.join('، ') || '-'})، due بصيغة YYYY-MM-DD إن ذُكر موعد.
- dates: المواعيد القادمة المذكورة (اجتماع لاحق، تسليم...).
- إن لم يُذكر شيء في بند فاتركه مصفوفة فارغة. لا تضف ما لم يُقل.`;
const okAudio = (audio) => audio && audio.length <= MAX_AUDIO_B64 && /^[A-Za-z0-9+/=]+$/.test(audio.slice(0, 200));
const needAi = (env) => { if (!aiProvider(env)) fail(501, 'no-ai', 'الذكاء الاصطناعي غير مفعّل على هذا الخادم.'); };
const ctxList = (a, n) => (Array.isArray(a) ? a : []).map((x) => tcut(x, 40)).filter(Boolean).slice(0, n);
function aiCtx(src) {
  return { today: DATE.test(src.today || '') ? src.today : dayOf(now()), weekday: tcut(src.weekday, 20), areas: ctxList(src.areas, 20), people: ctxList(src.people, 40) };
}

route('POST', '/api/ai/voice', async ({ db, env, user, raw, q }) => {
  needAi(env);
  await quota(db, user.uid, 'transcribe'); await quota(db, user.uid, 'parse');
  if (!okAudio(raw)) fail(400, 'invalid', 'التسجيل غير صالح.');
  let c = {}; try { c = JSON.parse(q.get('ctx') || '{}'); } catch {}
  const x = aiCtx(c);
  const t = await transcribeAudio(env, raw, tcut(q.get('hint') || '', 400));
  if (!t) return { text: '', items: [] };
  return { text: t, items: await parseText(env, t, x.today, x.weekday, x.areas, x.people) };
}, { raw: MAX_AUDIO_B64, noOrg: true });
route('POST', '/api/ai/transcribe', async ({ db, env, user, raw, q }) => {
  needAi(env); await quota(db, user.uid, 'transcribe');
  if (!okAudio(raw)) fail(400, 'invalid', 'التسجيل غير صالح.');
  return { text: await transcribeAudio(env, raw, tcut(q.get('hint') || '', 400)) };
}, { raw: MAX_AUDIO_B64, noOrg: true });
route('POST', '/api/ai/parse', async ({ db, env, user, body }) => {
  needAi(env); await quota(db, user.uid, 'parse');
  const t = tcut(body.text, 4000); if (!t) return { items: [] };
  const x = aiCtx(body);
  return { items: await parseText(env, t, x.today, x.weekday, x.areas, x.people) };
}, { noOrg: true });
route('POST', '/api/ai/minutes', async ({ db, env, user, body }) => {
  needAi(env); await quota(db, user.uid, 'minutes');
  const t = tcut(body.text, 60000); const title = tcut(body.title, 200);
  if (t.length < 20) fail(400, 'invalid', 'النص قصير جدًا.');
  const x = aiCtx(body);
  const j = await llmJson(env, MINUTES_RULES(x.today, title, x.people), t, { name: 'minutes', schema: MINUTES_SCHEMA }, 2500);
  if (!j) fail(502, 'ai-failed', 'لم يُرجع النموذج محضرًا صالحًا.');
  return cleanMinutes(j);
}, { noOrg: true });

const OPEN = new Set(['/api/health', '/api/auth/signup', '/api/auth/login', '/api/auth/code']);
const NO_ORG = new Set(['/api/me', '/api/orgs', '/api/auth/logout', '/api/auth/password']);

export default {
  async fetch(req, env) { return withCors(await handle(req, env), req, env); },
};

async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(req.url);
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return json({ error: 'not-found', message: 'المسار غير موجود.' }, 404);
  try {
    const db = env.DB;
    if (!db) fail(500, 'no-db', 'قاعدة البيانات غير مربوطة (DB).');
    await migrate(db);
    const ctx = { db, env, req, q: url.searchParams, p: url.pathname.match(r.re).groups || {}, body: {} };
    if (!OPEN.has(url.pathname)) {
      ctx.user = await identity(req, env, db);
      if (!ctx.user) fail(401, 'auth', 'سجّل الدخول من جديد.');
      if (!NO_ORG.has(url.pathname) && !r.noOrg) ctx.v = await viewer(db, ctx.user, req.headers.get('x-org'));
    }
    if (r.raw) {
      // الصوت: نص base64 خام حتى ~٦ ميغابايت، يُمرَّر دون تحليل JSON
      ctx.raw = await req.text();
      if (ctx.raw.length > r.raw) fail(413, 'too-big', 'التسجيل أطول من المسموح.');
    } else if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const raw = await req.text();
      if (raw.length > MAX_BODY) fail(413, 'too-big', 'الطلب أكبر من المسموح.');
      try { ctx.body = raw ? JSON.parse(raw) : {}; } catch { fail(400, 'invalid', 'صيغة الطلب غير صحيحة.'); }
      if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) fail(400, 'invalid', 'صيغة الطلب غير صحيحة.');
    }
    return json(await r.fn(ctx));
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ error: 'server', message: 'خطأ في الخادم. حاول مرة أخرى.' }, 500);
  }
}
