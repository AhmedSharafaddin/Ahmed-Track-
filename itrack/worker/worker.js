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
  [
    // الإسناد والمتابعة: إعدادات الجهة (مفاتيح التشغيل)، واجبات دورية من التوصيف، تعليقات، مرفقات، تنبيهات، مفاتيح تكامل، تقويم.
    "ALTER TABLE orgs ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE responsibilities ADD COLUMN freq TEXT NOT NULL DEFAULT ''", // '' | daily | weekly | monthly
    'ALTER TABLE responsibilities ADD COLUMN prio INTEGER NOT NULL DEFAULT 1', // 1 عادية · 2 مهمة · 3 حرجة
    'ALTER TABLE responsibilities ADD COLUMN est INTEGER',
    'ALTER TABLE responsibilities ADD COLUMN freq_at INTEGER', // متى صارت دورية (لا يُحاسَب الموظف على ما قبلها)
    `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
      author_id TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', file_id TEXT, at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS com_task ON comments(owner_id, task_id, at)',
    `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, task_id TEXT NOT NULL, by_id TEXT NOT NULL,
      kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS files_task ON files(owner_id, task_id)',
    'CREATE INDEX IF NOT EXISTS files_at ON files(org_id, at)',
    `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL,
      owner_id TEXT, task_id TEXT, text TEXT NOT NULL, by_id TEXT, at INTEGER NOT NULL, read_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS notes_mem ON notes(member_id, at)',
    `CREATE TABLE IF NOT EXISTS api_keys (kh TEXT PRIMARY KEY, kp TEXT NOT NULL, org_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0)`,
    'CREATE INDEX IF NOT EXISTS keys_org ON api_keys(org_id)',
    'CREATE TABLE IF NOT EXISTS feeds (th TEXT PRIMARY KEY, org_id TEXT NOT NULL, member_id TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS feeds_mem ON feeds(member_id)',
  ],
  [
    // المشاريع: وعاء للمهام المسندة (المهمة تنتمي لمشروع عبر asg.project). لا حذف: الأرشفة فقط ⇒ قابلة للتراجع.
    `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', due TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS proj_org ON projects(org_id, status)',
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
  // مفتاح تكامل (نظام خارجي): يعمل باسم العضو الذي أصدره، وعلى مسارات التكامل فقط
  const km = auth.match(/^Bearer (itk_[\w-]{20,80})$/);
  if (km) {
    const k = await db.prepare('SELECT * FROM api_keys WHERE kh = ? AND revoked = 0').bind(await sha(km[1])).first();
    return k ? { uid: 'key:' + k.kh.slice(0, 12), email: '', verified: true, key: k } : null;
  }
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
const WEAK_PASS = new Set(['12345678', '123456789', '1234567890', '87654321', '987654321', 'password', 'password1', 'passw0rd', 'qwertyui', 'qwerty123', 'abcd1234', 'abcdefgh', 'iloveyou', '11223344', '12341234', 'admin123', 'admin1234', 'letmein1', 'welcome1', '00000000', '777777777', '12345678910', 'asastelecom', 'asas1234', 'asas12345', '1q2w3e4r']);
const checkPass = (pass) => {
  if (typeof pass !== 'string' || pass.length < 8) fail(400, 'weak-password', 'كلمة المرور ٨ أحرف على الأقل.');
  if (pass.length > 200) fail(400, 'invalid', 'كلمة المرور طويلة جدًا.');
  if (WEAK_PASS.has(pass.toLowerCase()) || /^(.)\1+$/.test(pass)) fail(400, 'weak-password', 'كلمة المرور شائعة جدًا. اختر غيرها.');
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
route('GET', '/api/bootstrap', async (ctx) => {
  const { db, v } = ctx;
  const org = await db.prepare('SELECT id, name FROM orgs WHERE id = ?').bind(v.org_id).first();
  const set = await getSet(ctx);
  const [mem, deps, pos, resp, secs] = await db.batch([
    db.prepare('SELECT * FROM members WHERE org_id = ? ORDER BY name').bind(v.org_id),
    db.prepare('SELECT id, name, active FROM departments WHERE org_id = ? ORDER BY name').bind(v.org_id),
    db.prepare('SELECT id, title, department_id, summary, version, active FROM positions WHERE org_id = ? ORDER BY title').bind(v.org_id),
    db.prepare('SELECT id, position_id, title, detail, sort, active, freq, prio, est FROM responsibilities WHERE org_id = ? ORDER BY sort').bind(v.org_id),
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
    settings: pubSet(set), ai: !!aiProvider(ctx.env),
  };
}, { api: true });

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
    // واجب دوري: يظهر تلقائيًا في مهام كل من يشغل الوظيفة (يوميًا/أسبوعيًا/شهريًا)
    const freq = FREQS.includes(r?.freq) ? r.freq : '';
    const prio = int(r?.prio, 1, 3, 1);
    const est = int(r?.est, 5, 960, null);
    const prev = r?.id && oldMap.get(r.id);
    if (prev) {
      keep.add(prev.id);
      if (prev.title !== t || prev.detail !== d || prev.sort !== i || !prev.active || (prev.freq || '') !== freq || (prev.prio || 1) !== prio || (prev.est ?? null) !== est) {
        changed = true;
        const fat = freq && freq !== (prev.freq || '') ? now() : prev.freq_at ?? null;
        stmts.push(db.prepare('UPDATE responsibilities SET title = ?, detail = ?, sort = ?, active = 1, freq = ?, prio = ?, est = ?, freq_at = ? WHERE id = ?').bind(t, d, i, freq, prio, est, fat, prev.id));
      }
    } else {
      changed = true;
      stmts.push(db.prepare('INSERT INTO responsibilities (id, org_id, position_id, title, detail, sort, freq, prio, est, freq_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id(), v.org_id, pid, t, d, i, freq, prio, est, freq ? now() : null));
    }
  });
  for (const r of old) if (!keep.has(r.id) && r.active) { changed = true; stmts.push(db.prepare('UPDATE responsibilities SET active = 0 WHERE id = ?').bind(r.id)); }
  if (!changed) return { id: pid, version: existing.version };
  const version = existing ? existing.version + 1 : 1;
  stmts.unshift(existing
    ? db.prepare('UPDATE positions SET title = ?, summary = ?, department_id = ?, version = ?, updated_at = ? WHERE id = ?').bind(title, summary, depId, version, now(), pid)
    : db.prepare('INSERT INTO positions (id, org_id, title, department_id, summary, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)').bind(pid, v.org_id, title, depId, summary, now()));
  stmts.push(auditQ(db, v.org_id, v.id, existing ? 'position.update' : 'position.create', 'position', pid, null,
    { title, version, responsibilities: list.map((r) => text(r?.title, 160) && [text(r?.title, 160), FREQS.includes(r?.freq) ? r.freq : ''].filter(Boolean).join(' · ')).filter(Boolean) }));
  dutyMemo.clear(); // تغيّر التوصيف ⇒ تُراجع الواجبات عند القراءة التالية
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
route('POST', '/api/report/:date/submit', async (ctx) => {
  const { db, v, body, p } = ctx;
  const { report, items } = await reportOf(db, v.id, p.date);
  emit(ctx, 'report.submitted', { member: { id: v.id, name: v.name }, date: p.date, items: items.length }, `${v.name} رفع تقرير ${p.date} (${items.length} بند)`);
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

/** تذكير بالتقرير اليومي: إشعار داخلي لمن لم يرفع تقريره. للمدير على من يتبعه وللمسؤول على الجميع.
 *  لا جدول جديد (جدول notes الموجود). لا يُذكَّر من رفع تقريره، ولا من ذُكِّر خلال ٤ ساعات، ولا من لم ينضم بعد. */
const REMIND_GAP = 4 * 3600e3;
route('POST', '/api/remind', async (ctx) => {
  const { db, v, body } = ctx;
  const set = await getSet(ctx);
  const date = isDay(body.date) ? body.date : orgToday(set);
  const ids = [...new Set(Array.isArray(body.members) ? body.members.filter((x) => typeof x === 'string' && x.length <= 64) : [])].slice(0, 200);
  if (!ids.length) fail(400, 'invalid', 'اختر موظفًا واحدًا على الأقل.');
  const js = JSON.stringify(ids); const t = now();
  const [mq, rq, nq] = await db.batch([
    db.prepare("SELECT id, status FROM members WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))").bind(v.org_id, js),
    db.prepare("SELECT member_id, status FROM reports WHERE org_id = ? AND date = ? AND member_id IN (SELECT value FROM json_each(?))").bind(v.org_id, date, js),
    db.prepare("SELECT DISTINCT member_id FROM notes WHERE org_id = ? AND kind = 'remind' AND at > ? AND member_id IN (SELECT value FROM json_each(?))").bind(v.org_id, t - REMIND_GAP, js),
  ]);
  const done = new Set(rq.results.filter((r) => ['submitted', 'approved'].includes(r.status)).map((r) => r.member_id));
  const recent = new Set(nq.results.map((r) => r.member_id));
  const out = { sent: 0, done: 0, recent: 0, denied: 0 }; const rows = [];
  for (const m of mq.results) {
    if (!canReview(v, m.id) || m.status !== 'active') { out.denied++; continue; }
    if (done.has(m.id)) { out.done++; continue; }
    if (recent.has(m.id)) { out.recent++; continue; }
    rows.push({ m: m.id, k: 'remind', o: m.id, t: '', x: `ذكّرك ${v.name} برفع تقرير ${date === orgToday(set) ? 'اليوم' : date}`, b: v.id });
  }
  out.denied += ids.length - mq.results.length;
  if (rows.length) await db.batch([notesQ(db, v.org_id, rows), auditQ(db, v.org_id, v.id, 'report.remind', 'report', date, null, { date, count: rows.length })]);
  out.sent = rows.length;
  return out;
});

/** الالتزام برفع التقارير لكل فريق (إدارة): أسبوعيًا (٨ نوافذ × ٧ أيام) وشهريًا (٦ نوافذ × ٣٠ يومًا)، حتى أمس.
 *  المتوقَّع = كل عضو فعّال × أيام العمل منذ انضمامه (يُستثنى العطلة والمشاهد نفسه). المرفوع = تقارير بحالة مرفوع/معتمد/مُعاد. */
route('GET', '/api/compliance', async (ctx) => {
  const { db, v } = ctx;
  const set = await getSet(ctx);
  const last = addDays(orgToday(set), -1); const WK = 8, MO = 6;
  const start = addDays(last, -(MO * 30 - 1));
  const { results: mem } = await db.prepare("SELECT id, department_id, created_at FROM members WHERE org_id = ? AND status = 'active'").bind(v.org_id).all();
  const scope = mem.filter((m) => m.id !== v.id && canSee(v, m.id));
  if (!scope.length) return { until: last, teams: [], all: { weekly: [], monthly: [] } };
  const { results: reps } = await db.prepare("SELECT member_id, date FROM reports WHERE org_id = ? AND date BETWEEN ? AND ? AND status IN ('submitted','approved','returned') AND member_id IN (SELECT value FROM json_each(?))")
    .bind(v.org_id, start, last, JSON.stringify(scope.map((m) => m.id))).all();
  const got = new Set(reps.map((r) => `${r.member_id}|${r.date}`));
  const days = []; for (let d = start; d <= last; d = addDays(d, 1)) if (!isOff(set, d)) days.push(d);
  const joined = new Map(scope.map((m) => [m.id, localDay(set, m.created_at)]));
  const win = (n, size) => Array.from({ length: n }, (_, i) => { const to = addDays(last, -(n - 1 - i) * size); return { from: addDays(to, -(size - 1)), to }; });
  const calc = (ms, ws) => ws.map((w) => { let exp = 0, sub = 0;
    for (const d of days) { if (d < w.from || d > w.to) continue; for (const m of ms) { if (joined.get(m.id) > d) continue; exp++; if (got.has(`${m.id}|${d}`)) sub++; } }
    return { from: w.from, to: w.to, exp, sub, rate: exp ? Math.round((sub / exp) * 100) : null }; });
  const W = win(WK, 7), Mo = win(MO, 30); const by = new Map();
  for (const m of scope) { const k = m.department_id || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(m); }
  const { results: deps } = await db.prepare('SELECT id, name FROM departments WHERE org_id = ?').bind(v.org_id).all();
  const nm = new Map(deps.map((d) => [d.id, d.name]));
  return { until: last, teams: [...by.entries()].map(([k, ms]) => ({ id: k, name: nm.get(k) || 'بلا إدارة', n: ms.length, weekly: calc(ms, W), monthly: calc(ms, Mo) })).sort((a, b) => b.n - a.n),
    all: { n: scope.length, weekly: calc(scope, W), monthly: calc(scope, Mo) } };
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
route('GET', '/api/inbox', async (ctx) => {
  const { db, v, q } = ctx;
  const set = await getSet(ctx);
  const t = isDay(q.get('today')) ? q.get('today') : orgToday(set);
  const from = addDays(t, -14);
  const [sub, ret, nts, mine, rep] = await db.batch([
    db.prepare("SELECT member_id, date, submitted_at, late FROM reports WHERE org_id = ? AND status = 'submitted' AND date >= ? AND member_id != ? ORDER BY date, submitted_at LIMIT 300").bind(v.org_id, from, v.id),
    db.prepare("SELECT date, review_comment, reviewed_at FROM reports WHERE member_id = ? AND status = 'returned' ORDER BY date LIMIT 30").bind(v.id),
    db.prepare('SELECT id, kind, owner_id, task_id, text, by_id, at, read_at FROM notes WHERE member_id = ? ORDER BY at DESC LIMIT 40').bind(v.id),
    db.prepare("SELECT id, data FROM pdocs WHERE member_id = ? AND col = 'tasks' AND (id LIKE 'a.%' OR id LIKE 'd.%')").bind(v.id),
    db.prepare("SELECT status FROM reports WHERE member_id = ? AND date = ?").bind(v.id, t),
  ]);
  // تنبيهات محسوبة لحظة القراءة (بلا Cron ⇒ تعمل على Cloudflare وعلى سيرفر الجهة بنفس الطريقة)
  const alerts = [];
  const R = set.rules;
  for (const r of mine.results) {
    const x = JSON.parse(r.data); if (isDone(x)) continue;
    if (R.overdue && x.due && x.due < t) alerts.push({ kind: 'overdue', task_id: r.id, title: x.title, due: x.due });
    else if (R.dueSoon && x.due && x.due <= addDays(t, 1) && x.asg?.kind === 'assign') alerts.push({ kind: 'soon', task_id: r.id, title: x.title, due: x.due });
    if (R.returned && x.rv?.state === 'returned') alerts.push({ kind: 'returned', task_id: r.id, title: x.title, note: x.rv.note });
  }
  const hour = new Date(now() + set.tz * 60000).getUTCHours();
  if (R.report && set.reportHour >= 0 && !isOff(set, t) && hour >= set.reportHour && !['submitted', 'approved'].includes(rep.results[0]?.status)) alerts.push({ kind: 'report', date: t });
  let team = null;
  if (v.isAdmin || v.subs.size) {
    const list = (await teamAsg(ctx, {})).filter((x) => x.asg.kind === 'assign' || !isDone(x));
    const open = list.filter((x) => !isDone(x));
    team = {
      overdue: R.overdue ? open.filter((x) => x.due && x.due < t).length : 0,
      blocked: R.blocked ? open.filter((x) => x.blocked).slice(0, 10).map((x) => ({ member_id: x.member_id, id: x.id, title: x.title, blocked: x.blocked })) : [],
      pending: list.filter((x) => isDone(x) && x.rv?.state === 'pending' && canReview(v, x.member_id)).slice(0, 30).map((x) => ({ member_id: x.member_id, id: x.id, title: x.title, doneAt: x.doneAt })),
    };
  }
  if (Math.random() < 0.01) await db.prepare('DELETE FROM notes WHERE org_id = ? AND at < ?').bind(v.org_id, now() - 120 * 864e5).run();
  return {
    review: sub.results.filter((r) => canReview(v, r.member_id)).slice(0, 100).map((r) => ({ member_id: r.member_id, date: r.date, submitted_at: r.submitted_at, late: !!r.late })),
    returned: ret.results,
    notes: nts.results, unread: nts.results.filter((x) => !x.read_at).length, alerts, team,
  };
});
route('POST', '/api/notes/read', async ({ db, v, body }) => {
  const ids = Array.isArray(body.ids) ? body.ids.filter(Number.isInteger).slice(0, 100) : [];
  if (body.all) await db.prepare('UPDATE notes SET read_at = ? WHERE member_id = ? AND read_at IS NULL').bind(now(), v.id).run();
  else if (ids.length) await db.prepare('UPDATE notes SET read_at = ? WHERE member_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))').bind(now(), v.id, JSON.stringify(ids)).run();
  return { ok: true };
});

/* ───── المساحة الشخصية ─────
   وثائق JSON لكل عضو (مهام، مجالات، أهداف، مراجعات). لا يراها أحد غير صاحبها،
   إلا مهمة اختار صاحبها `shared:true` فتظهر لمن فوقه فقط (قراءة). لا تدخل سجل التدقيق عمدًا. */
const PCOLS = new Set(['areas', 'goals', 'tasks', 'reviews']);
const MAX_OPS = 40; // حد D1 المجاني ٥٠ استعلامًا لكل طلب
const MAX_DOC = 8000;
const PID = /^[\w.-]{1,64}$/;

/** توقيع خفيف (عدد + آخر تعديل لكل مجموعة) كي لا يسحب العميل كل الوثائق إن لم يتغير شيء. */
route('GET', '/api/p-sig', async (ctx) => {
  const { db, v } = ctx;
  await ensureDuties(db, await getSet(ctx), v.org_id, [v.id]);
  const { results } = await db.prepare('SELECT col, COUNT(*) AS n, MAX(updated_at) AS m FROM pdocs WHERE member_id = ? GROUP BY col').bind(v.id).all();
  const sig = {}; for (const c of PCOLS) sig[c] = '0:0';
  for (const r of results) if (PCOLS.has(r.col)) sig[r.col] = `${r.n}:${r.m}`;
  return { sig };
});

route('GET', '/api/p/:col', async (ctx) => {
  const { db, v, p } = ctx;
  if (!PCOLS.has(p.col)) fail(404, 'not-found', 'المجموعة غير معروفة.');
  if (p.col === 'tasks') await ensureDuties(db, await getSet(ctx), v.org_id, [v.id]);
  const { results } = await db.prepare('SELECT id, data, updated_at FROM pdocs WHERE member_id = ? AND col = ? ORDER BY updated_at DESC LIMIT 3000').bind(v.id, p.col).all();
  return { docs: results.map((r) => ({ id: r.id, updated_at: r.updated_at, ...JSON.parse(r.data) })) };
});

/* المهمة المسندة أو الواجب داخل مهام الموظف: يعمل عليها بكل أدوات «مهامي» (اليوم، المصفوفة، التركيز، الخطوات)،
   لكن ما حدده المدير محمي هنا. لا نرفض الطلب (المزامنة تُسقط الدفعة المرفوضة كاملة): نعيد الحقول المحمية لقيمتها
   ونغيّر updated_at فيسحب الجهاز النسخة الصحيحة في المزامنة التالية. */
const SRV_KEYS = ['asg', 'rv', 'doneAt', 'photos', 'warn'];
const LOCK_KEYS = ['title', 'due', 'time', 'important', 'urgent', 'repeat', 'shared', 'est', ...SRV_KEYS];
function mergePatch(a, b) { // RFC 7396 مثل json_patch في SQLite
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = a && typeof a === 'object' && !Array.isArray(a) ? { ...a } : {};
  for (const [k, x] of Object.entries(b)) { if (x === null) delete out[k]; else out[k] = mergePatch(out[k], x); }
  return out;
}
/** تنفيذ الموظف: الحالة والنسبة والتعثّر وتفاصيل الإنجاز. يعيد الأحداث الناتجة. */
function applyExec(old, next, t) {
  for (const k of LOCK_KEYS) { if (k in old) next[k] = old[k]; else delete next[k]; }
  next.prog = Math.min(100, Math.max(0, Math.round(Number(next.prog) || 0)));
  next.rpt = tcut(next.rpt, 1000);
  next.blocked = tcut(next.blocked, 400);
  const ev = [];
  const was = isDone(old); const now_ = isDone(next);
  if (now_ && !was) {
    if (old.asg.photo && !(old.photos || []).length) { next.status = old.status; next.completedAt = old.completedAt ?? null; next.warn = 'photo'; }
    else { next.doneAt = t; next.prog = 100; next.blocked = ''; next.rv = old.asg.review ? { state: 'pending' } : null; delete next.warn; ev.push('done'); }
  } else if (!now_ && was) {
    next.doneAt = null; if (next.rv?.state !== 'returned') next.rv = null; ev.push('reopen');
  }
  if (next.blocked && next.blocked !== (old.blocked || '')) ev.push('blocked');
  return ev;
}

route('POST', '/api/p', async (ctx) => {
  const { db, v, body } = ctx;
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (!ops.length || ops.length > MAX_OPS) fail(400, 'invalid', `من 1 إلى ${MAX_OPS} عملية في الطلب.`);
  const t = now();
  const tids = [...new Set(ops.filter((o) => o?.col === 'tasks' && typeof o.id === 'string' && PID.test(o.id)).map((o) => o.id))];
  const prev = new Map();
  if (tids.length) {
    const { results } = await db.prepare("SELECT id, data FROM pdocs WHERE member_id = ? AND col = 'tasks' AND id IN (SELECT value FROM json_each(?))").bind(v.id, JSON.stringify(tids)).all();
    for (const r of results) prev.set(r.id, JSON.parse(r.data));
  }
  const stmts = []; const audits = []; const notes = [];
  let set = null;
  for (const o of ops) {
    if (!o || !PCOLS.has(o.col) || typeof o.id !== 'string' || !PID.test(o.id)) fail(400, 'invalid', 'عملية غير صحيحة.');
    if (o.op !== 'del' && (!['set', 'patch'].includes(o.op) || !o.data || typeof o.data !== 'object' || Array.isArray(o.data))) fail(400, 'invalid', 'عملية غير صحيحة.');
    const old = o.col === 'tasks' ? prev.get(o.id) : null;
    if (old?.asg) {
      if (o.op === 'del') { stmts.push(db.prepare("UPDATE pdocs SET updated_at = ? WHERE member_id = ? AND col = 'tasks' AND id = ?").bind(t, v.id, o.id)); continue; }
      const { id: _i, updated_at: _u, ...data } = o.data;
      const next = o.op === 'patch' ? mergePatch(old, data) : data;
      const ev = applyExec(old, next, t);
      const raw = JSON.stringify(next);
      if (raw.length > MAX_DOC) fail(413, 'too-big', 'الوثيقة أكبر من المسموح.');
      prev.set(o.id, next);
      stmts.push(db.prepare("UPDATE pdocs SET data = ?, shared = 1, updated_at = ? WHERE member_id = ? AND col = 'tasks' AND id = ?").bind(raw, t, v.id, o.id));
      if (ev.length) {
        set ||= await getSet(ctx);
        const ref = tref(v.id, o.id); const by = old.asg.by || v.manager_id; const kind = old.asg.kind;
        for (const e of ev) {
          audits.push({ a: `task.${e}`, e: ref, s: v.id, d: { title: old.title, kind, ...(e === 'blocked' ? { reason: next.blocked } : {}), ...(e === 'done' && next.rpt ? { rpt: next.rpt } : {}) } });
          // الواجب الدوري المنجز لا يُشغل المدير يوميًا؛ التعثّر يصله دائمًا
          if (e === 'done' && kind === 'assign' && by && set.rules.done) notes.push({ m: by, k: 'done', o: v.id, t: o.id, x: `${v.name} أنجز: ${old.title}${old.asg.review ? ' (بانتظار اعتمادك)' : ''}`, b: v.id });
          if (e === 'blocked' && by && set.rules.blocked) notes.push({ m: by, k: 'blocked', o: v.id, t: o.id, x: `${v.name} متعثّر في «${old.title}»: ${next.blocked}`, b: v.id });
          if (e === 'done' || e === 'blocked') emit(ctx, `task.${e}`, { member: { id: v.id, name: v.name }, task: { id: o.id, title: old.title, kind, due: old.due }, ...(e === 'blocked' ? { reason: next.blocked } : { report: next.rpt || '' }) },
            e === 'done' ? `✔ ${v.name} أنجز «${old.title}»` : `⚠ ${v.name} متعثّر في «${old.title}»: ${next.blocked}`);
        }
      }
      continue;
    }
    if (o.col === 'tasks' && /^[ad]\./.test(o.id)) continue; // معرّفات محجوزة للمهام المسندة والواجبات
    if (o.op === 'del') { stmts.push(db.prepare('DELETE FROM pdocs WHERE member_id = ? AND col = ? AND id = ?').bind(v.id, o.col, o.id)); continue; }
    const { id: _i, updated_at: _u, ...data } = o.data;
    if (o.col === 'tasks') for (const k of SRV_KEYS) delete data[k]; // لا تُزوَّر مهمة مسندة أو اعتماد
    const raw = JSON.stringify(data);
    if (raw.length > MAX_DOC) fail(413, 'too-big', 'الوثيقة أكبر من المسموح.');
    const canShare = o.col === 'tasks' ? 1 : 0;
    const merged = o.op === 'patch' ? 'json_patch(pdocs.data, excluded.data)' : 'excluded.data';
    stmts.push(db.prepare(`INSERT INTO pdocs (member_id, col, id, data, shared, updated_at) VALUES (?1, ?2, ?3, ?4, CASE WHEN ?6 = 1 AND json_extract(?4, '$.shared') = 1 THEN 1 ELSE 0 END, ?5)
      ON CONFLICT(member_id, col, id) DO UPDATE SET data = ${merged}, updated_at = excluded.updated_at,
        shared = CASE WHEN ?6 = 1 AND json_extract(${merged}, '$.shared') = 1 THEN 1 ELSE 0 END`).bind(v.id, o.col, o.id, raw, t, canShare));
  }
  if (audits.length) stmts.push(auditsQ(db, v.org_id, v.id, audits));
  if (notes.length) stmts.push(notesQ(db, v.org_id, notes));
  if (stmts.length) await db.batch(stmts);
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

/* ═════════════ إعدادات الجهة ومفاتيح التشغيل ═════════════
   كل ما يحتاج قرارًا من تقنية المعلومات (الذكاء الاصطناعي، الربط الخارجي، مفاتيح API، التقويم) له مفتاح هنا.
   المعطّل لا يُحذف كوده: الخادم يرفض مساره فقط. الافتراضي: كل ما قد يخرج من شبكة الجهة معطّل. */
const FEATS = ['ai', 'comments', 'photos', 'webhooks', 'api', 'ics'];
const RULES = ['assigned', 'done', 'blocked', 'returned', 'comment', 'overdue', 'dueSoon', 'report'];
const EVENTS = ['task.assigned', 'task.done', 'task.blocked', 'task.approved', 'task.returned', 'task.cancelled', 'comment.created', 'report.submitted'];
const FREQS = ['daily', 'weekly', 'monthly'];
const DEF_SET = {
  weekend: [5], tz: 180, dayMin: 420, reportHour: 16, photoDays: 180,
  feat: { ai: false, comments: true, photos: true, webhooks: false, api: false, ics: false },
  rules: Object.fromEntries(RULES.map((k) => [k, true])), hooks: [],
};
const int = (x, lo, hi, d) => (Number.isInteger(x) && x >= lo && x <= hi ? x : d);
function mergeSet(raw) {
  let s = {}; try { s = JSON.parse(raw || '{}') || {}; } catch {}
  return { ...DEF_SET, ...s, feat: { ...DEF_SET.feat, ...(s.feat || {}) }, rules: { ...DEF_SET.rules, ...(s.rules || {}) }, hooks: Array.isArray(s.hooks) ? s.hooks : [] };
}
async function getSet(ctx) {
  if (!ctx.set) {
    const r = await ctx.db.prepare('SELECT name, settings FROM orgs WHERE id = ?').bind(ctx.v.org_id).first();
    ctx.set = mergeSet(r?.settings); ctx.orgName = r?.name || '';
  }
  return ctx.set;
}
const pubSet = (s) => ({ weekend: s.weekend, tz: s.tz, dayMin: s.dayMin, reportHour: s.reportHour, photoDays: s.photoDays, feat: s.feat, rules: s.rules });
async function needFeat(ctx, k, msg) { if (!(await getSet(ctx)).feat[k]) fail(403, 'feature-off', msg || 'هذه الميزة معطّلة في إعدادات الجهة.'); }
function cleanSet(b, cur) {
  const o = mergeSet(JSON.stringify(cur));
  if (Array.isArray(b.weekend)) o.weekend = [...new Set(b.weekend.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].slice(0, 3);
  o.tz = int(b.tz, -720, 840, o.tz); o.dayMin = int(b.dayMin, 60, 960, o.dayMin);
  o.reportHour = int(b.reportHour, -1, 23, o.reportHour); o.photoDays = int(b.photoDays, 7, 3650, o.photoDays);
  for (const k of FEATS) if (typeof b.feat?.[k] === 'boolean') o.feat[k] = b.feat[k];
  for (const k of RULES) if (typeof b.rules?.[k] === 'boolean') o.rules[k] = b.rules[k];
  if (Array.isArray(b.hooks)) {
    const old = new Map(o.hooks.map((h) => [h.id, h]));
    o.hooks = b.hooks.slice(0, 5).map((h) => {
      let u; try { u = new URL(String(h?.url || '')); } catch { return null; }
      if (!['https:', 'http:'].includes(u.protocol) || u.href.length > 400 || u.username || u.password) return null;
      if (hookHostBlocked(u.hostname)) fail(400, 'invalid', 'عنوان الربط غير مسموح (جهاز الخادم نفسه أو خدمة البيانات الوصفية). استخدم عنوان النظام المستهدف.');
      const prev = old.get(h.id);
      return { id: prev?.id || id(), name: text(h.name, 60), url: u.href, events: (Array.isArray(h.events) ? h.events : []).filter((e) => EVENTS.includes(e)), on: h.on !== false, secret: prev?.secret || 'whs_' + b64e(rand(24)) };
    }).filter(Boolean);
  }
  return o;
}
/** حماية SSRF للـWebhooks: يُحجب ما يصل لجهاز الخادم نفسه أو لخدمات البيانات الوصفية السحابية (وفيها أسرار الجهاز).
 *  الشبكة الداخلية (10.x / 192.168.x) مسموحة عمدًا لأن الربط مع ERP أو n8n داخل الجهة حالة استخدام مقصودة؛ يضبطها جدار الـIT.
 *  ملاحظة: لا يمكن من هنا منع اسم نطاق يُحلّ لعنوان محجوب (DNS rebinding)؛ الحل الكامل جدار صادر على سيرفر الجهة. */
function hookHostBlocked(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal' || h === 'instance-data') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); // المحلّل يحوّل الصيغ العشرية والسداسية إلى نقطية قبل وصولنا
  if (m) { const a = +m[1], b = +m[2]; return a === 127 || a === 0 || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); }
  return /^(::1?|fe[89ab][0-9a-f:]*|::ffff:.*|fd00:ec2:.*)$/.test(h);
}
const hookSafe = (url) => { try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && !hookHostBlocked(u.hostname); } catch { return false; } };
const adminSet = (ctx, s) => ({ ...s, events: EVENTS, ai_server: aiProvider(ctx.env) });
route('GET', '/api/settings', async (ctx) => { const s = await getSet(ctx); return ctx.v.isAdmin ? adminSet(ctx, s) : pubSet(s); });
route('PUT', '/api/settings', async (ctx) => {
  const { db, v, body } = ctx;
  needAdmin(v);
  const cur = await getSet(ctx);
  const next = cleanSet(body, cur);
  const diff = {};
  for (const k of ['weekend', 'tz', 'dayMin', 'reportHour', 'photoDays', 'feat', 'rules']) if (JSON.stringify(cur[k]) !== JSON.stringify(next[k])) diff[k] = [cur[k], next[k]];
  const hk = (s) => JSON.stringify(s.hooks.map((h) => [h.url, h.events, h.on]));
  if (hk(cur) !== hk(next)) diff.hooks = next.hooks.map((h) => `${h.on ? '' : '(معطّل) '}${h.url}`);
  if (Object.keys(diff).length) {
    await db.batch([
      db.prepare('UPDATE orgs SET settings = ? WHERE id = ?').bind(JSON.stringify(next), v.org_id),
      auditQ(db, v.org_id, v.id, 'settings.update', 'org', v.org_id, null, diff),
    ]);
  }
  ctx.set = next; dutyMemo.clear();
  return adminSet(ctx, next);
});

/* ───── الأيام بتوقيت الجهة ───── */
const wdOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const isOff = (s, d) => s.weekend.includes(wdOf(d));
const localDay = (s, ms) => dayOf(ms + s.tz * 60000);
const orgToday = (s) => localDay(s, now());
/** فترة الواجب التي يقع فيها اليوم. الأسبوع يبدأ السبت؛ الموعد آخر يوم عمل في الفترة. */
function period(freq, d, s) {
  if (freq === 'daily') return isOff(s, d) ? null : { key: d, start: d, due: d };
  let start, end;
  if (freq === 'weekly') { start = addDays(d, -((wdOf(d) + 1) % 7)); end = addDays(start, 6); }
  else if (freq === 'monthly') { start = d.slice(0, 8) + '01'; end = dayOf(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)); }
  else return null;
  let due = end; while (due > start && isOff(s, due)) due = addDays(due, -1);
  return { key: (freq === 'weekly' ? 'w' : 'm') + start, start, due };
}
function workDays(s, from, to) { let n = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (!isOff(s, d)) n++; return n; }

/* ───── المهام المسندة والواجبات: أدوات مشتركة ───── */
const baseTask = (f) => ({
  title: '', notes: '', areaId: null, goalId: null, urgent: false, important: false, due: null, status: 'todo',
  focusDate: null, focusOrder: 0, slips: 0, completedAt: null, steps: [], repeat: null, assignee: null, assignedAt: null, followUp: null,
  time: null, remind: null, intent: '', est: null, snoozes: 0, snoozeUntil: null, shared: true, createdAt: new Date().toISOString(), ...f,
});
// الأولوية = مربع المصفوفة نفسه (لا نظام ثانٍ): حرجة = مهمة وعاجلة، مهمة = مهمة، عادية = غير ذلك
const fromPrio = (p) => ({ important: p >= 2, urgent: p >= 3 });
const prioOf = (t) => (t.important ? (t.urgent ? 3 : 2) : t.urgent ? 2 : 1);
const tref = (owner, tid) => `${owner}/${tid}`;
const isDone = (t) => t.status === 'done';
const emit = (ctx, event, data, msg) => (ctx.events ||= []).push({ event, data, text: msg });
const notesQ = (db, orgId, rows) => db.prepare(`INSERT INTO notes (org_id, member_id, kind, owner_id, task_id, text, by_id, at)
  SELECT ?1, json_extract(value, '$.m'), json_extract(value, '$.k'), json_extract(value, '$.o'), json_extract(value, '$.t'), json_extract(value, '$.x'), json_extract(value, '$.b'), ?2 FROM json_each(?3)`)
  .bind(orgId, now(), JSON.stringify(rows.map((r) => ({ ...r, x: tcut(r.x, 300) }))));
const auditsQ = (db, orgId, actorId, rows) => db.prepare(`INSERT INTO audit (org_id, at, actor_id, action, entity, entity_id, subject_id, data)
  SELECT ?1, ?2, ?3, json_extract(value, '$.a'), 'task', json_extract(value, '$.e'), json_extract(value, '$.s'), json_extract(value, '$.d') FROM json_each(?4)`)
  .bind(orgId, now(), actorId, JSON.stringify(rows.map((r) => ({ ...r, d: JSON.stringify(r.d || {}).slice(0, 8000) }))));

/** واجبات التوصيف: تُولَّد عند القراءة بمعرّف ثابت لكل فترة (بلا Cron)، وتُزال المفتوحة من فترة مضت إن لم يُلمس شيء منها
   (تبقى محسوبة «فائتة» في المؤشرات من التوصيف نفسه). */
const dutyMemo = new Map();
async function ensureDuties(db, set, orgId, mids) {
  const day = orgToday(set);
  const todo = mids.filter((m) => !dutyMemo.has(`${m}|${day}`));
  if (!todo.length) return;
  const { results } = await db.prepare(`SELECT m.id AS mid, r.id AS rid, r.title, r.detail, r.freq, r.prio, r.est FROM members m
    JOIN responsibilities r ON r.position_id = m.position_id AND r.active = 1 AND r.freq != ''
    WHERE m.org_id = ? AND m.status != 'disabled' AND m.id IN (SELECT value FROM json_each(?))`).bind(orgId, JSON.stringify(todo)).all();
  const t = now();
  const rows = [];
  for (const x of results) {
    const p = period(x.freq, day, set); if (!p) continue;
    rows.push({ m: x.mid, id: `d.${x.rid}.${p.key}`, d: JSON.stringify(baseTask({ title: x.title, due: p.due, est: x.est || null, ...fromPrio(x.prio || 1),
      asg: { kind: 'duty', rid: x.rid, freq: x.freq, period: p.key, start: p.start, by: null, at: t, desc: x.detail || '', review: false, photo: false } })) });
  }
  const stmts = [db.prepare(`DELETE FROM pdocs WHERE col = 'tasks' AND id LIKE 'd.%' AND member_id IN (SELECT value FROM json_each(?1))
    AND json_extract(data, '$.due') < ?2 AND json_extract(data, '$.status') != 'done' AND json_extract(data, '$.photos') IS NULL
    AND COALESCE(json_extract(data, '$.prog'), 0) = 0 AND COALESCE(json_extract(data, '$.rpt'), '') = '' AND COALESCE(json_extract(data, '$.blocked'), '') = ''`).bind(JSON.stringify(todo), day)];
  if (rows.length) stmts.push(db.prepare(`INSERT INTO pdocs (member_id, col, id, data, shared, updated_at)
    SELECT json_extract(value, '$.m'), 'tasks', json_extract(value, '$.id'), json_extract(value, '$.d'), 1, ?1 FROM json_each(?2) WHERE 1
    ON CONFLICT(member_id, col, id) DO NOTHING`).bind(t, JSON.stringify(rows)));
  await db.batch(stmts);
  if (dutyMemo.size > 5000) dutyMemo.clear();
  for (const m of todo) dutyMemo.set(`${m}|${day}`, 1);
}

/** المهام المسندة والواجبات لمن أراهم (بلا مهامي أنا). */
async function teamAsg(ctx, { member, kind } = {}) {
  const { db, v } = ctx;
  if (member && !canSee(v, member)) fail(403, 'forbidden', 'لا تملك صلاحية عرض هذا الموظف.');
  const { results } = member
    ? await db.prepare("SELECT member_id, id, data, updated_at FROM pdocs WHERE member_id = ? AND col = 'tasks' AND (id LIKE 'a.%' OR id LIKE 'd.%')").bind(member).all()
    : await db.prepare("SELECT p.member_id, p.id, p.data, p.updated_at FROM pdocs p JOIN members m ON m.id = p.member_id WHERE m.org_id = ? AND p.col = 'tasks' AND (p.id LIKE 'a.%' OR p.id LIKE 'd.%') LIMIT 8000").bind(v.org_id).all();
  return results.filter((r) => r.member_id !== v.id && canSee(v, r.member_id))
    .map((r) => ({ member_id: r.member_id, id: r.id, updated_at: r.updated_at, ...JSON.parse(r.data) }))
    .filter((x) => x.asg && (!kind || x.asg.kind === kind));
}
const pubTask = (x) => ({
  member_id: x.member_id, id: x.id, title: x.title, due: x.due, time: x.time || null, status: x.status, prio: prioOf(x), est: x.est || null,
  spent: x.spent || 0, prog: x.prog || 0, blocked: x.blocked || '', rpt: x.rpt || '', photos: x.photos || [], rv: x.rv || null,
  asg: x.asg, doneAt: x.doneAt || null, warn: x.warn || null, steps: (x.steps || []).map((s) => ({ title: s.title, done: !!s.done })), updated_at: x.updated_at,
});
async function loadTask(db, owner, tid) {
  const r = await db.prepare("SELECT data, shared, updated_at FROM pdocs WHERE member_id = ? AND col = 'tasks' AND id = ?").bind(owner, tid).first();
  return r ? { t: JSON.parse(r.data), shared: !!r.shared, updated_at: r.updated_at } : null;
}
const saveTaskQ = (db, owner, tid, t) => db.prepare("UPDATE pdocs SET data = ?, updated_at = ? WHERE member_id = ? AND col = 'tasks' AND id = ?").bind(JSON.stringify(t), now(), owner, tid);
/** مهمة مسندة/واجب لموظف تحتي (للمدير، ولمن فوقه، وللمسؤول). */
async function managedTask(ctx) {
  const { db, v, p } = ctx;
  if (!canReview(v, p.owner)) fail(403, 'forbidden', 'لا تملك صلاحية على مهام هذا الموظف.');
  const x = await loadTask(db, p.owner, p.tid);
  if (!x || !x.t.asg) fail(404, 'not-found', 'المهمة غير موجودة.');
  return x.t;
}
/** من يقرأ المهمة ويعلّق عليها: صاحبها، ومن فوقه إن كانت ظاهرة لهم. */
async function taskAccess(ctx, owner, tid) {
  const { db, v } = ctx;
  if (owner !== v.id && !canSee(v, owner)) fail(403, 'forbidden', 'لا تملك صلاحية على هذه المهمة.');
  const x = await loadTask(db, owner, tid);
  if (!x) fail(404, 'not-found', 'المهمة غير موجودة.');
  if (owner !== v.id && !x.shared) fail(403, 'forbidden', 'هذه المهمة خاصة بصاحبها.');
  return x;
}

/* ───── الإسناد: المدير ينشئ مهمة تصل لمهام الموظف مباشرة ───── */
function asgFields(b, old = null) {
  const has = (k) => b[k] !== undefined;
  let due = old ? old.due ?? null : null;
  if (has('due')) { if (b.due === null || b.due === '') due = null; else if (isDay(b.due)) due = b.due; else fail(400, 'invalid', 'الموعد غير صحيح.'); }
  return {
    title: has('title') || !old ? text(b.title, 200, { required: true, label: 'عنوان المهمة' }) : old.title,
    desc: has('desc') ? text(b.desc, 2000) : old?.asg?.desc || '',
    due,
    time: has('time') ? (TIME.test(b.time || '') ? b.time : null) : old?.time ?? null,
    prio: has('prio') ? int(b.prio, 1, 3, 1) : old ? prioOf(old) : 1,
    est: has('est') ? int(b.est, 5, 960, null) : old?.est ?? null,
    review: has('review') ? !!b.review : !!old?.asg?.review,
    photo: has('photo') ? !!b.photo : !!old?.asg?.photo,
  };
}
route('POST', '/api/assign', async (ctx) => {
  const { db, v, body } = ctx;
  const to = [...new Set(Array.isArray(body.to) ? body.to.filter((x) => typeof x === 'string') : [])];
  if (!to.length || to.length > 50) fail(400, 'invalid', 'اختر من موظف واحد إلى ٥٠.');
  for (const mid of to) if (!canReview(v, mid)) fail(403, 'forbidden', 'تُسند المهام لمن يتبعك فقط.');
  const { results: ms } = await db.prepare('SELECT id, name, status FROM members WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))').bind(v.org_id, JSON.stringify(to)).all();
  if (ms.length !== to.length || ms.some((m) => m.status === 'disabled')) fail(400, 'invalid', 'موظف غير صحيح أو معطّل.');
  const f = asgFields(body);
  const proj = body.project ? await projectFor(ctx, body.project) : null;
  const steps = (Array.isArray(body.steps) ? body.steps : []).map((s) => text(s, 160)).filter(Boolean).slice(0, 12);
  const t = now(); const group = id();
  const rows = ms.map((m) => {
    const tid = 'a.' + id();
    return { m: m.id, id: tid, name: m.name, d: JSON.stringify(baseTask({
      title: f.title, due: f.due, time: f.time, est: f.est, ...fromPrio(f.prio),
      steps: steps.map((s) => ({ id: id().slice(0, 8), title: s, done: false })),
      asg: { kind: 'assign', by: v.id, byName: v.name, at: t, desc: f.desc, review: f.review, photo: f.photo, group, n: ms.length, ...(proj ? { project: proj.id, projectName: proj.name } : {}) },
    })) };
  });
  const set = await getSet(ctx);
  const stmts = [
    db.prepare(`INSERT INTO pdocs (member_id, col, id, data, shared, updated_at) SELECT json_extract(value, '$.m'), 'tasks', json_extract(value, '$.id'), json_extract(value, '$.d'), 1, ?1 FROM json_each(?2)`).bind(t, JSON.stringify(rows)),
    auditsQ(db, v.org_id, v.id, rows.map((r) => ({ a: 'task.assign', e: tref(r.m, r.id), s: r.m, d: { title: f.title, due: f.due, prio: f.prio } }))),
  ];
  if (set.rules.assigned) stmts.push(notesQ(db, v.org_id, rows.map((r) => ({ m: r.m, k: 'assigned', o: r.m, t: r.id, x: `أسند إليك ${v.name}: ${f.title}`, b: v.id }))));
  await db.batch(stmts);
  emit(ctx, 'task.assigned', { by: { id: v.id, name: v.name }, title: f.title, due: f.due, prio: f.prio, to: rows.map((r) => ({ member_id: r.m, name: r.name, task_id: r.id })) },
    `📌 ${v.name} أسند «${f.title}» إلى ${rows.map((r) => r.name).join('، ')}${f.due ? ` (موعدها ${f.due})` : ''}`);
  return { ids: rows.map((r) => ({ member_id: r.m, id: r.id })), group };
}, { api: true });

route('PATCH', '/api/assign/:owner/:tid', async (ctx) => {
  const { db, v, p, body } = ctx;
  const t = await managedTask(ctx);
  if (t.asg.kind !== 'assign') fail(400, 'invalid', 'الواجب الدوري يُعدَّل من التوصيف الوظيفي.');
  const f = asgFields(body, t);
  const next = { ...t, title: f.title, due: f.due, time: f.time, est: f.est, ...fromPrio(f.prio), asg: { ...t.asg, desc: f.desc, review: f.review, photo: f.photo } };
  if (body.project !== undefined) {
    const pr = body.project ? await projectFor(ctx, body.project) : null;
    const a = { ...next.asg }; delete a.project; delete a.projectName;
    if (pr) { a.project = pr.id; a.projectName = pr.name; }
    next.asg = a;
  }
  const diff = {};
  if ((t.asg.project || null) !== (next.asg.project || null)) diff.project = [t.asg.projectName || null, next.asg.projectName || null];
  for (const k of ['title', 'due', 'time', 'est']) if ((t[k] ?? null) !== (next[k] ?? null)) diff[k] = [t[k] ?? null, next[k] ?? null];
  if (prioOf(t) !== f.prio) diff.prio = [prioOf(t), f.prio];
  for (const k of ['desc', 'review', 'photo']) if ((t.asg[k] ?? '') !== (next.asg[k] ?? '')) diff[k] = [t.asg[k] ?? null, next.asg[k]];
  if (!Object.keys(diff).length) return { ok: true };
  const set = await getSet(ctx);
  const stmts = [saveTaskQ(db, p.owner, p.tid, next), auditsQ(db, v.org_id, v.id, [{ a: 'task.edit', e: tref(p.owner, p.tid), s: p.owner, d: diff }])];
  if (set.rules.assigned) stmts.push(notesQ(db, v.org_id, [{ m: p.owner, k: 'edited', o: p.owner, t: p.tid, x: `عدّل ${v.name} المهمة: ${next.title}`, b: v.id }]));
  await db.batch(stmts);
  return { ok: true };
}, { api: true });

route('POST', '/api/assign/:owner/:tid/cancel', async (ctx) => {
  const { db, v, p } = ctx;
  const t = await managedTask(ctx);
  if (t.asg.kind !== 'assign') fail(400, 'invalid', 'الواجب الدوري يُلغى من التوصيف الوظيفي.');
  const set = await getSet(ctx);
  const stmts = [
    db.prepare("DELETE FROM pdocs WHERE member_id = ? AND col = 'tasks' AND id = ?").bind(p.owner, p.tid),
    db.prepare('DELETE FROM files WHERE owner_id = ? AND task_id = ?').bind(p.owner, p.tid),
    db.prepare('DELETE FROM comments WHERE owner_id = ? AND task_id = ?').bind(p.owner, p.tid),
    auditsQ(db, v.org_id, v.id, [{ a: 'task.cancel', e: tref(p.owner, p.tid), s: p.owner, d: { title: t.title } }]),
  ];
  if (set.rules.assigned) stmts.push(notesQ(db, v.org_id, [{ m: p.owner, k: 'cancelled', o: p.owner, t: p.tid, x: `ألغى ${v.name} المهمة: ${t.title}`, b: v.id }]));
  await db.batch(stmts);
  emit(ctx, 'task.cancelled', { by: { id: v.id, name: v.name }, member_id: p.owner, task: { id: p.tid, title: t.title } }, `✖ ${v.name} ألغى «${t.title}»`);
  return { ok: true };
}, { api: true });

/** اعتماد المنجز، أو إعادته بملاحظة (تعود مفتوحة عند الموظف). */
route('POST', '/api/assign/:owner/:tid/review', async (ctx) => {
  const { db, v, p, body } = ctx;
  const t = await managedTask(ctx);
  const note = text(body.note, 1000); const t0 = now();
  if (!isDone(t)) fail(409, 'state', 'تُراجع المهمة بعد أن يرفعها الموظف منجزة.');
  let next;
  if (body.action === 'approve') next = { ...t, rv: { state: 'ok', by: v.id, byName: v.name, at: t0, note } };
  else if (body.action === 'return') {
    if (!note) fail(400, 'invalid', 'اكتب ما المطلوب تعديله.');
    next = { ...t, status: 'todo', completedAt: null, doneAt: null, prog: Math.min(t.prog || 0, 90), rv: { state: 'returned', by: v.id, byName: v.name, at: t0, note } };
  } else fail(400, 'invalid', 'إجراء غير معروف.');
  const set = await getSet(ctx);
  const ok = body.action === 'approve';
  const stmts = [saveTaskQ(db, p.owner, p.tid, next), auditsQ(db, v.org_id, v.id, [{ a: ok ? 'task.approve' : 'task.return', e: tref(p.owner, p.tid), s: p.owner, d: { title: t.title, note } }])];
  if (set.rules.returned) stmts.push(notesQ(db, v.org_id, [{ m: p.owner, k: ok ? 'approved' : 'returned', o: p.owner, t: p.tid, x: ok ? `اعتمد ${v.name}: ${t.title}` : `أعاد ${v.name} «${t.title}» للتعديل: ${note}`, b: v.id }]));
  await db.batch(stmts);
  emit(ctx, ok ? 'task.approved' : 'task.returned', { by: { id: v.id, name: v.name }, member_id: p.owner, task: { id: p.tid, title: t.title }, note }, ok ? `✔ ${v.name} اعتمد «${t.title}»` : `↩ ${v.name} أعاد «${t.title}»: ${note}`);
  return { status: next.status, rv: next.rv };
}, { api: true });

/** المهام المسندة والواجبات لفريقي. kind=assign|duty، member، state=open|done */
route('GET', '/api/assigned', async (ctx) => {
  const { q } = ctx;
  const member = q.get('member') || null;
  const kind = ['assign', 'duty'].includes(q.get('kind')) ? q.get('kind') : null;
  const set = await getSet(ctx);
  const scope = member ? [member] : [...(ctx.v.isAdmin ? (await ctx.db.prepare("SELECT id FROM members WHERE org_id = ? AND status = 'active'").bind(ctx.v.org_id).all()).results.map((r) => r.id) : ctx.v.subs)];
  await ensureDuties(ctx.db, set, ctx.v.org_id, scope.filter((x) => x !== ctx.v.id));
  let list = await teamAsg(ctx, { member, kind });
  const st = q.get('state');
  if (st === 'open') list = list.filter((x) => !isDone(x)); else if (st === 'done') list = list.filter(isDone);
  const { results: cc } = await ctx.db.prepare('SELECT owner_id, task_id, COUNT(*) AS n FROM comments WHERE org_id = ? GROUP BY owner_id, task_id').bind(ctx.v.org_id).all();
  const cmap = new Map(cc.map((r) => [tref(r.owner_id, r.task_id), r.n]));
  return { today: orgToday(set), tasks: list.slice(0, 3000).map((x) => ({ ...pubTask(x), comments: cmap.get(tref(x.member_id, x.id)) || 0 })) };
}, { api: true });

/* ═════════════ المشاريع ═════════════
   المشروع وعاء للمهام المسندة: اسم وهدف وموعد ومسؤول. المهمة تنتمي لمشروع واحد عبر asg.project (مقفولة على الموظف كبقية asg).
   ما يراه كل شخص: المسؤول كل شيء، والمدير ما يتبعه من مهام، والموظف مهامه هو فقط. فالنسب تُحسب على المرئي ويُعلن ذلك في الواجهة.
   من يُنشئ: المسؤول أو المدير. من يعدّل أو يؤرشف: صاحب المشروع أو المسؤول. من يُسند داخله: أي مدير (لمن يتبعه فقط، كالإسناد العادي). */
const PSTAT = ['active', 'done', 'archived'];
const needMgr = (v) => { if (v.role === 'employee') fail(403, 'forbidden', 'إدارة المشاريع للمدير والمسؤول.'); };
async function projectFor(ctx, pid) {
  const pr = typeof pid === 'string' ? await ctx.db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').bind(pid, ctx.v.org_id).first() : null;
  if (!pr) fail(400, 'invalid', 'المشروع غير موجود.');
  if (pr.status !== 'active') fail(400, 'invalid', 'المشروع مغلق أو مؤرشف؛ أعد تفعيله أولًا.');
  return pr;
}
async function projTasks(ctx, pid) {
  const { db, v } = ctx;
  const { results } = pid
    ? await db.prepare("SELECT p.member_id, p.id, p.data, p.updated_at FROM pdocs p JOIN members m ON m.id = p.member_id WHERE m.org_id = ? AND p.col = 'tasks' AND p.id LIKE 'a.%' AND json_extract(p.data, '$.asg.project') = ? LIMIT 3000").bind(v.org_id, pid).all()
    : await db.prepare("SELECT p.member_id, p.id, p.data, p.updated_at FROM pdocs p JOIN members m ON m.id = p.member_id WHERE m.org_id = ? AND p.col = 'tasks' AND p.id LIKE 'a.%' AND json_extract(p.data, '$.asg.project') IS NOT NULL LIMIT 8000").bind(v.org_id).all();
  return results.filter((r) => canSee(v, r.member_id)).map((r) => ({ member_id: r.member_id, id: r.id, updated_at: r.updated_at, ...JSON.parse(r.data) }));
}
/** نسبة الإنجاز موزونة بالأولوية (حرجة ٣، مهمة ٢، عادية ١): المنجز ١٠٠٪ والمفتوح بنسبته المعلنة (حتى ٩٩٪). */
function projStats(list, today) {
  const s = { total: list.length, done: 0, open: 0, overdue: 0, blocked: 0, review: 0, pct: 0, next: null, health: 'empty' };
  let w = 0, got = 0;
  for (const x of list) {
    const wt = prioOf(x); w += wt;
    if (isDone(x)) { s.done++; got += wt * 100; if (x.asg?.review && x.rv?.state !== 'ok') s.review++; continue; }
    got += wt * Math.min(99, Math.max(0, x.prog || 0)); s.open++;
    if (x.due && x.due < today) s.overdue++;
    if (x.blocked) s.blocked++;
    if (x.due && (!s.next || x.due < s.next)) s.next = x.due;
  }
  s.pct = w ? Math.round(got / w) : 0;
  s.health = !s.total ? 'empty' : s.done === s.total ? 'done' : s.overdue ? 'late' : s.blocked ? 'blocked' : 'ok';
  return s;
}
const pubProj = (p, ownerName) => ({ id: p.id, name: p.name, descr: p.descr, owner_id: p.owner_id, owner: ownerName || null, status: p.status, due: p.due || null, created_at: p.created_at });
const projFields = (b, old = null) => {
  const has = (k) => b[k] !== undefined;
  let due = old ? old.due ?? null : null;
  if (has('due')) { if (b.due === null || b.due === '') due = null; else if (isDay(b.due)) due = b.due; else fail(400, 'invalid', 'الموعد غير صحيح.'); }
  const status = has('status') ? (PSTAT.includes(b.status) ? b.status : fail(400, 'invalid', 'حالة غير معروفة.')) : old?.status || 'active';
  return { name: has('name') || !old ? text(b.name, 80, { required: true, label: 'اسم المشروع' }) : old.name, descr: has('descr') ? text(b.descr, 1000) : old?.descr || '', due, status };
};
route('GET', '/api/projects', async (ctx) => {
  const { db, v, q } = ctx;
  const set = await getSet(ctx); const today = orgToday(set);
  const { results: ps } = await db.prepare('SELECT p.*, m.name AS owner_name FROM projects p LEFT JOIN members m ON m.id = p.owner_id WHERE p.org_id = ? ORDER BY p.created_at DESC LIMIT 500').bind(v.org_id).all();
  const tasks = await projTasks(ctx, null);
  const by = new Map(); for (const x of tasks) { const k = x.asg.project; (by.get(k) || by.set(k, []).get(k)).push(x); }
  const want = q.get('status') || 'active';
  const list = ps.filter((p) => (want === 'all' || p.status === want) && (v.isAdmin || p.owner_id === v.id || by.has(p.id)))
    .map((p) => ({ ...pubProj(p, p.owner_name), stats: projStats(by.get(p.id) || [], today), mine: p.owner_id === v.id }));
  return { today, projects: list, can_create: v.role !== 'employee', scope: v.isAdmin ? 'all' : v.subs.size ? 'branch' : 'own' };
}, { api: true });
route('POST', '/api/projects', async (ctx) => {
  const { db, v, body } = ctx;
  needMgr(v);
  const f = projFields(body);
  const pid = id(); const t = now();
  await db.batch([
    db.prepare('INSERT INTO projects (id, org_id, name, descr, owner_id, status, due, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(pid, v.org_id, f.name, f.descr, v.id, 'active', f.due, t, t),
    auditQ(db, v.org_id, v.id, 'project.create', 'project', pid, null, { name: f.name, due: f.due }),
  ]);
  return { id: pid };
}, { api: true });
route('GET', '/api/projects/:id', async (ctx) => {
  const { db, v, p } = ctx;
  const pr = await db.prepare('SELECT p.*, m.name AS owner_name FROM projects p LEFT JOIN members m ON m.id = p.owner_id WHERE p.id = ? AND p.org_id = ?').bind(p.id, v.org_id).first();
  const tasks = pr ? await projTasks(ctx, p.id) : [];
  if (!pr || !(v.isAdmin || pr.owner_id === v.id || tasks.length)) fail(404, 'not-found', 'المشروع غير موجود.');
  const set = await getSet(ctx); const today = orgToday(set);
  const { results: mem } = await db.prepare('SELECT id, name FROM members WHERE org_id = ?').bind(v.org_id).all();
  const nm = new Map(mem.map((m) => [m.id, m.name]));
  const per = new Map(); for (const x of tasks) (per.get(x.member_id) || per.set(x.member_id, []).get(x.member_id)).push(x);
  const { results: cc } = await db.prepare('SELECT owner_id, task_id, COUNT(*) AS n FROM comments WHERE org_id = ? GROUP BY owner_id, task_id').bind(v.org_id).all();
  const cmap = new Map(cc.map((r) => [tref(r.owner_id, r.task_id), r.n]));
  return {
    today, project: pubProj(pr, pr.owner_name), stats: projStats(tasks, today),
    members: [...per].map(([mid, l]) => ({ member_id: mid, name: nm.get(mid) || '—', ...projStats(l, today) })).sort((a, b) => a.pct - b.pct),
    tasks: tasks.slice(0, 1500).map((x) => ({ ...pubTask(x), member: nm.get(x.member_id) || '—', comments: cmap.get(tref(x.member_id, x.id)) || 0 })),
    can_edit: v.isAdmin || pr.owner_id === v.id, can_assign: pr.status === 'active' && v.role !== 'employee',
    scope: v.isAdmin ? 'all' : v.subs.size ? 'branch' : 'own',
  };
}, { api: true });
route('PATCH', '/api/projects/:id', async (ctx) => {
  const { db, v, p, body } = ctx;
  const pr = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').bind(p.id, v.org_id).first();
  if (!pr) fail(404, 'not-found', 'المشروع غير موجود.');
  if (!(v.isAdmin || pr.owner_id === v.id)) fail(403, 'forbidden', 'يعدّل المشروع صاحبه أو المسؤول.');
  const f = projFields(body, pr);
  const diff = {};
  for (const k of ['name', 'descr', 'due', 'status']) if ((pr[k] ?? null) !== (f[k] ?? null)) diff[k] = [pr[k] ?? null, f[k] ?? null];
  if (!Object.keys(diff).length) return { ok: true };
  const t = now();
  const stmts = [
    db.prepare('UPDATE projects SET name = ?, descr = ?, due = ?, status = ?, updated_at = ? WHERE id = ? AND org_id = ?').bind(f.name, f.descr, f.due, f.status, t, p.id, v.org_id),
    auditQ(db, v.org_id, v.id, 'project.update', 'project', p.id, null, diff),
  ];
  // الاسم منسوخ داخل مهام الموظفين (ليظهر لهم دون استعلام إضافي) ⇒ تتبع إعادة التسمية
  if (diff.name) stmts.push(db.prepare("UPDATE pdocs SET data = json_set(data, '$.asg.projectName', ?1), updated_at = ?2 WHERE col = 'tasks' AND id LIKE 'a.%' AND json_extract(data, '$.asg.project') = ?3 AND member_id IN (SELECT id FROM members WHERE org_id = ?4)").bind(f.name, t, p.id, v.org_id));
  await db.batch(stmts);
  return { ok: true };
}, { api: true });

/** تفاصيل مهمة: لصاحبها، ولمن فوقه إن كانت ظاهرة. مع التعليقات والمرفقات وسجلها. */
route('GET', '/api/task/:owner/:tid', async (ctx) => {
  const { db, v, p } = ctx;
  const x = await taskAccess(ctx, p.owner, p.tid);
  const [com, fs, tr] = await db.batch([
    db.prepare('SELECT c.id, c.author_id, c.body, c.file_id, c.at, m.name AS author FROM comments c LEFT JOIN members m ON m.id = c.author_id WHERE c.owner_id = ? AND c.task_id = ? ORDER BY c.at LIMIT 300').bind(p.owner, p.tid),
    db.prepare('SELECT id, kind, mime, size, by_id, at FROM files WHERE owner_id = ? AND task_id = ? ORDER BY at').bind(p.owner, p.tid),
    db.prepare("SELECT a.at, a.action, a.data, m.name AS actor FROM audit a LEFT JOIN members m ON m.id = a.actor_id WHERE a.org_id = ? AND a.entity = 'task' AND a.entity_id = ? ORDER BY a.at LIMIT 200").bind(v.org_id, tref(p.owner, p.tid)),
  ]);
  return {
    task: { ...pubTask({ member_id: p.owner, id: p.tid, updated_at: x.updated_at, ...x.t }), ...(p.owner === v.id ? { notes: x.t.notes || '' } : {}) },
    comments: com.results, files: fs.results,
    trail: tr.results.map((a) => ({ at: a.at, action: a.action, actor: a.actor, data: JSON.parse(a.data) })),
    can_review: !!x.t.asg && canReview(v, p.owner), can_edit: !!x.t.asg && x.t.asg.kind === 'assign' && canReview(v, p.owner),
  };
}, { api: true });

/* ───── التعليقات: النقاش داخل المهمة بدل واتساب ───── */
route('POST', '/api/task/:owner/:tid/comments', async (ctx) => {
  const { db, v, p, body } = ctx;
  await needFeat(ctx, 'comments', 'التعليقات معطّلة في إعدادات الجهة.');
  const x = await taskAccess(ctx, p.owner, p.tid);
  const b = text(body.body, 2000);
  const fileId = typeof body.file === 'string' ? body.file : null;
  if (!b && !fileId) fail(400, 'invalid', 'اكتب التعليق.');
  if (fileId && !(await db.prepare('SELECT 1 FROM files WHERE id = ? AND owner_id = ? AND task_id = ? AND by_id = ?').bind(fileId, p.owner, p.tid, v.id).first())) fail(400, 'invalid', 'المرفق غير صحيح.');
  const { results: prev } = await db.prepare('SELECT DISTINCT author_id FROM comments WHERE owner_id = ? AND task_id = ?').bind(p.owner, p.tid).all();
  // يُنبَّه: صاحب المهمة، ومن أسندها، ومن علّق قبل، ومن ذُكر بـ@اسمه إن كان يملك رؤيتها
  const targets = new Set([p.owner, x.t.asg?.by, ...prev.map((r) => r.author_id)].filter(Boolean));
  if (b.includes('@')) {
    const { results: mem } = await db.prepare("SELECT id, name, role FROM members WHERE org_id = ? AND status = 'active'").bind(v.org_id).all();
    for (const m of mem.filter((m) => b.includes('@' + m.name) && !targets.has(m.id)).slice(0, 5)) {
      if (m.id === p.owner || m.role === 'admin' || (await subtree(db, v.org_id, m.id)).has(p.owner)) targets.add(m.id);
    }
  }
  targets.delete(v.id);
  const set = await getSet(ctx);
  const cid = id(); const t = now();
  const stmts = [db.prepare('INSERT INTO comments (id, org_id, owner_id, task_id, author_id, body, file_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(cid, v.org_id, p.owner, p.tid, v.id, b, fileId, t)];
  if (set.rules.comment && targets.size) stmts.push(notesQ(db, v.org_id, [...targets].map((m) => ({ m, k: 'comment', o: p.owner, t: p.tid, x: `${v.name} على «${x.t.title}»: ${b || '(صورة)'}`, b: v.id }))));
  await db.batch(stmts);
  emit(ctx, 'comment.created', { by: { id: v.id, name: v.name }, member_id: p.owner, task: { id: p.tid, title: x.t.title }, body: b }, `💬 ${v.name} على «${x.t.title}»: ${b}`);
  return { id: cid, at: t };
});

/* ───── المرفقات: صور إثبات الإنجاز (تُضغط في الجهاز قبل الرفع) ───── */
const MAX_FILE = 400_000;
const MIME = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const MAX_PHOTOS = 4;
route('POST', '/api/files', async (ctx) => {
  const { db, v, q, req, bin } = ctx;
  const owner = q.get('owner') || v.id; const tid = q.get('task') || '';
  const kind = q.get('kind') === 'comment' ? 'comment' : 'photo';
  await needFeat(ctx, kind === 'photo' ? 'photos' : 'comments', kind === 'photo' ? 'صور الإنجاز معطّلة في إعدادات الجهة.' : 'التعليقات معطّلة في إعدادات الجهة.');
  const mime = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const sig = MIME[mime];
  if (!sig) fail(400, 'invalid', 'الصور فقط: JPEG أو PNG أو WebP.');
  if (!bin?.length || sig.some((b, i) => bin[i] !== b)) fail(400, 'invalid', 'الملف ليس صورة صالحة.');
  const x = await taskAccess(ctx, owner, tid);
  if (kind === 'photo') {
    if (owner !== v.id) fail(403, 'forbidden', 'صاحب المهمة فقط يرفق صور الإنجاز.');
    if (!x.t.asg) fail(400, 'invalid', 'صور الإنجاز للمهام المسندة والواجبات.');
    if ((x.t.photos || []).length >= MAX_PHOTOS) fail(400, 'too-many', `الحد ${MAX_PHOTOS} صور للمهمة.`);
  }
  const set = await getSet(ctx);
  const fid = id(); const t = now();
  const stmts = [db.prepare('INSERT INTO files (id, org_id, owner_id, task_id, by_id, kind, mime, size, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(fid, v.org_id, owner, tid, v.id, kind, mime, bin.length, blobArg(bin), t)];
  if (kind === 'photo') {
    const next = { ...x.t, photos: [...(x.t.photos || []), fid] };
    if (next.warn === 'photo') delete next.warn;
    stmts.push(saveTaskQ(db, owner, tid, next));
  }
  // الاحتفاظ: الصور الأقدم من المدة المحددة تُحذف (قاعدة Cloudflare المجانية محدودة الحجم)
  if (Math.random() < 0.05) stmts.push(db.prepare('DELETE FROM files WHERE org_id = ? AND at < ?').bind(v.org_id, t - set.photoDays * 864e5));
  await db.batch(stmts);
  return { id: fid, size: bin.length };
}, { bin: MAX_FILE });
route('GET', '/api/files/:fid', async (ctx) => {
  const { db, v, p } = ctx;
  const f = await db.prepare('SELECT * FROM files WHERE id = ? AND org_id = ?').bind(p.fid, v.org_id).first();
  if (!f) fail(404, 'not-found', 'المرفق غير موجود أو انتهت مدة الاحتفاظ به.');
  await taskAccess(ctx, f.owner_id, f.task_id);
  return new Response(toBytes(f.data), { headers: { 'content-type': f.mime, 'cache-control': 'private, max-age=604800, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
});
route('POST', '/api/files/:fid/delete', async (ctx) => {
  const { db, v, p } = ctx;
  const f = await db.prepare('SELECT * FROM files WHERE id = ? AND org_id = ?').bind(p.fid, v.org_id).first();
  if (!f || f.by_id !== v.id) fail(404, 'not-found', 'المرفق غير موجود.');
  const x = await loadTask(db, f.owner_id, f.task_id);
  const stmts = [db.prepare('DELETE FROM files WHERE id = ?').bind(f.id)];
  if (x && f.kind === 'photo') {
    if (isDone(x.t)) fail(409, 'locked', 'لا تُحذف صور مهمة منجزة. أعد فتحها أولًا.');
    stmts.push(saveTaskQ(db, f.owner_id, f.task_id, { ...x.t, photos: (x.t.photos || []).filter((z) => z !== f.id) }));
  }
  await db.batch(stmts);
  return { ok: true };
});
// D1 يقبل ArrayBuffer للـBLOB ويعيده مصفوفة أرقام؛ node:sqlite (سيرفر الجهة) يقبل ويعيد Uint8Array
let isD1 = false;
const blobArg = (u8) => (isD1 ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) : u8);
const toBytes = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));

/* ═════════════ المؤشرات: ما يراه المدير ═════════════
   تُحسب في الخادم من المهام المسندة والواجبات فقط (المهام الشخصية خارجها)، وبقواعد معلنة لا بنموذج غامض:
   • الإنجاز = المنجز ÷ (المنجز + ما فات موعده ولم يُنجز). ما لم يحن موعده لا يُحسب على أحد.
   • الالتزام بالموعد = المنجز في موعده ÷ المنجز. • الموزون: حرجة ×٣، مهمة ×٢، عادية ×١.
   • الحِمل = المتبقي المقدّر من المفتوح (تقدير غائب = ٦٠ د) ÷ ساعات العمل في الأيام السبعة القادمة.
   • خطر التأخير: فات الموعد، أو مرّ نصف الوقت والإنجاز أقل بكثير، أو بقي يوم والإنجاز دون النصف، أو متعثّرة. */
async function computeMetrics(ctx, from, to, member) {
  const { db, v } = ctx;
  const set = await getSet(ctx);
  const today = orgToday(set);
  const { results: mem } = await db.prepare("SELECT id, name, position_id, department_id, section_id, manager_id, created_at FROM members WHERE org_id = ? AND status != 'disabled'").bind(v.org_id).all();
  const scope = mem.filter((m) => m.id !== v.id && canSee(v, m.id) && (!member || m.id === member));
  if (member && !scope.length) fail(403, 'forbidden', 'لا تملك صلاحية عرض هذا الموظف.');
  await ensureDuties(db, set, v.org_id, scope.map((m) => m.id));
  const [tk, rs, rp] = await db.batch([
    db.prepare("SELECT p.member_id, p.id, p.data FROM pdocs p JOIN members m ON m.id = p.member_id WHERE m.org_id = ? AND p.col = 'tasks' AND (p.id LIKE 'a.%' OR p.id LIKE 'd.%') LIMIT 20000").bind(v.org_id),
    db.prepare("SELECT id, position_id, title, freq, prio, freq_at FROM responsibilities WHERE org_id = ? AND active = 1 AND freq != ''").bind(v.org_id),
    db.prepare("SELECT member_id, date FROM reports WHERE org_id = ? AND date BETWEEN ? AND ? AND status IN ('submitted', 'approved', 'returned')").bind(v.org_id, from, to),
  ]);
  const ids = new Set(scope.map((m) => m.id));
  const byM = new Map(scope.map((m) => [m.id, []]));
  for (const r of tk.results) if (ids.has(r.member_id)) { const x = JSON.parse(r.data); if (x.asg) byM.get(r.member_id).push({ ...x, id: r.id, member_id: r.member_id }); }
  const repN = new Map(); for (const r of rp.results) repN.set(r.member_id, (repN.get(r.member_id) || 0) + 1);
  const dl = (ms) => localDay(set, ms);
  const ws0 = period('weekly', today, set).start;
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(ws0, -7 * (7 - i)));
  const wIdx = (d) => { for (let i = weeks.length - 1; i >= 0; i--) if (d >= weeks[i]) return d <= addDays(weeks[i], 6) ? i : -1; return -1; };
  const capDays = workDays(set, today, addDays(today, 6));
  const team = { points: weeks.map(() => 0) };
  const risks = [];
  const out = scope.map((m) => {
    const all = byM.get(m.id);
    const A = all.filter((x) => x.asg.kind === 'assign');
    const D = all.filter((x) => x.asg.kind === 'duty');
    const st = { elig: 0, done: 0, ontime: 0, wElig: 0, wDone: 0, reviewed: 0, approved: 0 };
    const add = (w, done, ontime, elig) => { if (!elig) return; st.elig++; st.wElig += w; if (done) { st.done++; st.wDone += w; if (ontime) st.ontime++; } };
    const inR = (k) => k >= from && k <= to;
    const trend = weeks.map(() => 0);
    for (const x of all) if (isDone(x) && x.doneAt) { const i = wIdx(dl(x.doneAt)); if (i >= 0) { trend[i] += prioOf(x); team.points[i] += prioOf(x); } }
    const a = { due: 0, done: 0, ontime: 0, overdue: 0, open: 0 };
    for (const x of A) {
      const done = isDone(x);
      // المنجزة تُنسب ليوم إنجازها، والمفتوحة لموعدها (أو يوم إسنادها إن لم يكن لها موعد)
      const key = done && x.doneAt ? dl(x.doneAt) : x.due || dl(x.asg.at);
      if (!done) { a.open++; if (x.due && x.due < today) a.overdue++; }
      if (!inR(key)) continue;
      const elig = done || (x.due && x.due < today);
      if (elig) a.due++;
      const ontime = done && (!x.due || dl(x.doneAt || 0) <= x.due);
      if (done) { a.done++; if (ontime) a.ontime++; if (x.asg.review) { st.reviewed++; if (x.rv?.state === 'ok') st.approved++; } }
      add(prioOf(x), done, ontime, elig);
    }
    // الواجبات: المتوقع من التوصيف نفسه (لا من الوثائق) ⇒ الفائت يُحسب حتى لو لم يفتح الموظف التطبيق
    const dmap = new Map(D.map((x) => [x.id, x]));
    const joined = dl(m.created_at);
    const d = { expected: 0, done: 0, ontime: 0, missed: 0 };
    for (const r of rs.results.filter((r) => r.position_id === m.position_id)) {
      const floor = [from, joined, r.freq_at ? dl(r.freq_at) : from].sort().pop();
      const seen = new Set();
      for (let day = floor; day <= to && day <= today; day = addDays(day, 1)) {
        const pr = period(r.freq, day, set); if (!pr || seen.has(pr.key)) continue;
        seen.add(pr.key);
        if (pr.due < floor || pr.due > to) continue;
        const x = dmap.get(`d.${r.id}.${pr.key}`);
        const done = !!x && isDone(x);
        const elig = done || pr.due < today;
        if (!elig) continue;
        d.expected++;
        const ontime = done && dl(x.doneAt || 0) <= pr.due;
        if (done) { d.done++; if (ontime) d.ontime++; } else d.missed++;
        add(r.prio || 1, done, ontime, true);
      }
    }
    // الحِمل وخطر التأخير
    const open = all.filter((x) => !isDone(x));
    const remain = open.filter((x) => !x.due || x.due <= addDays(today, 6)).reduce((s, x) => s + Math.max((x.est || 60) - (x.spent || 0), 15), 0);
    const cap = set.dayMin * Math.max(capDays, 1);
    let blocked = 0, lag = 0;
    for (const x of open.filter((y) => y.asg.kind === 'assign' || y.blocked)) {
      const why = [];
      if (x.blocked) { why.push('blocked'); blocked++; }
      if (x.due && x.due < today) why.push('overdue');
      else if (x.due) {
        const end = Date.parse(x.due + 'T23:59:00Z') - set.tz * 60000;
        const frac = end > x.asg.at ? (now() - x.asg.at) / (end - x.asg.at) : 1;
        if (frac >= 0.5 && (x.prog || 0) < frac * 100 - 30) { why.push('lag'); lag++; }
        else if (x.due <= addDays(today, 1) && (x.prog || 0) < 50) why.push('soon');
      }
      if (why.length) risks.push({ member_id: m.id, id: x.id, title: x.title, due: x.due, prog: x.prog || 0, prio: prioOf(x), why, blocked: x.blocked || '' });
    }
    const pct = (p, q) => (q ? Math.round((p / q) * 100) : null);
    const repExp = workDays(set, [from, joined].sort().pop(), to < today ? to : today);
    const res = {
      member_id: m.id,
      completion: pct(st.done, st.elig), weighted: pct(st.wDone, st.wElig), ontime: pct(st.ontime, st.done),
      approval: st.reviewed ? pct(st.approved, st.reviewed) : null,
      assigned: a, duties: d,
      load: { minutes: remain, capacity: cap, pct: pct(remain, cap) },
      reports: { days: repN.get(m.id) || 0, expected: repExp, pct: pct(Math.min(repN.get(m.id) || 0, repExp), repExp) },
      blocked, lag, trend,
    };
    const score = a.overdue * 2 + blocked * 2 + lag + ((res.load.pct || 0) > 110 ? 2 : 0) + (res.completion !== null && res.completion < 60 ? 2 : 0) + (d.missed > 2 ? 1 : 0);
    res.risk = score >= 4 ? 'high' : score >= 2 ? 'med' : 'ok';
    res.score = score;
    return res;
  });
  const sev = { blocked: 4, overdue: 3, lag: 2, soon: 1 };
  risks.sort((x, y) => Math.max(...y.why.map((w) => sev[w])) - Math.max(...x.why.map((w) => sev[w])) || y.prio - x.prio || (x.due || '9').localeCompare(y.due || '9'));
  return { from, to, today, weeks, members: out, team, risks: risks.slice(0, 40), byM };
}
function rangeOf(q, set) {
  const t = orgToday(set);
  const to = isDay(q.get('to')) ? q.get('to') : t;
  const from = isDay(q.get('from')) ? q.get('from') : addDays(to, -29);
  if (from > to || addDays(from, 366) < to) fail(400, 'invalid', 'الفترة غير صحيحة (حتى سنة).');
  return { from, to };
}
route('GET', '/api/metrics', async (ctx) => {
  const { from, to } = rangeOf(ctx.q, await getSet(ctx));
  const { byM, ...m } = await computeMetrics(ctx, from, to, ctx.q.get('member'));
  return m;
}, { api: true });

/* ───── تصدير CSV (يفتح في Excel بالعربية) ───── */
const csvCell = (x) => { let s = x === null || x === undefined ? '' : String(x); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
route('GET', '/api/export.csv', async (ctx) => {
  const { db, v, q } = ctx;
  const set = await getSet(ctx);
  const { from, to } = rangeOf(q, set);
  const type = ['tasks', 'reports'].includes(q.get('type')) ? q.get('type') : 'people';
  if (type === 'reports') { // تقارير الفترة: صف لكل (موظف، يوم) لمن أراه؛ المسودات لا تُصدَّر
    const { results } = await db.prepare(`SELECT m.id AS mid, m.name, d.name AS dep, r.date, r.status, r.late, COUNT(i.id) AS items, COALESCE(SUM(i.minutes), 0) AS minutes,
        SUM(CASE WHEN i.state = 'blocked' THEN 1 ELSE 0 END) AS blocked
      FROM reports r JOIN members m ON m.id = r.member_id LEFT JOIN departments d ON d.id = m.department_id LEFT JOIN report_items i ON i.report_id = r.id
      WHERE r.org_id = ? AND r.date BETWEEN ? AND ? AND r.status != 'draft' GROUP BY r.id ORDER BY r.date, m.name LIMIT 20000`).bind(v.org_id, from, to).all();
    const SS = { submitted: 'بانتظار المراجعة', approved: 'معتمد', returned: 'مُعاد للتعديل' };
    const rows = [['الموظف', 'الإدارة', 'التاريخ', 'الحالة', 'متأخر', 'عدد البنود', 'الدقائق', 'بنود متعثرة']].concat(results.filter((r) => canSee(v, r.mid)).map((r) => [r.name, r.dep || '', r.date, SS[r.status] || r.status, r.late ? 'نعم' : 'لا', r.items, r.minutes, r.blocked || 0]));
    return new Response(csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="itrack-reports-${from}_${to}.csv"`, 'cache-control': 'no-store' } });
  }
  const M = await computeMetrics(ctx, from, to, q.get('member'));
  const { results: mem } = await db.prepare('SELECT m.id, m.name, d.name AS dep, s.name AS sec, p.title AS pos FROM members m LEFT JOIN departments d ON d.id = m.department_id LEFT JOIN sections s ON s.id = m.section_id LEFT JOIN positions p ON p.id = m.position_id WHERE m.org_id = ?').bind(v.org_id).all();
  const who = new Map(mem.map((m) => [m.id, m]));
  const PR = { 1: 'عادية', 2: 'مهمة', 3: 'حرجة' };
  const ST = { done: 'منجزة', todo: 'مفتوحة', waiting: 'بانتظار جهة أخرى' };
  let rows;
  if (type === 'people') {
    rows = [['الموظف', 'الإدارة', 'القسم', 'الوظيفة', 'الإنجاز %', 'الموزون %', 'في الموعد %', 'الاعتماد %', 'مسندة مستحقة', 'مسندة منجزة', 'متأخرة الآن', 'واجبات متوقعة', 'واجبات منجزة', 'واجبات فائتة', 'متعثرة', 'الحمل %', 'التقارير', 'أيام العمل', 'مستوى الخطر']]
      .concat(M.members.map((x) => { const m = who.get(x.member_id) || {}; return [m.name, m.dep, m.sec, m.pos, x.completion, x.weighted, x.ontime, x.approval, x.assigned.due, x.assigned.done, x.assigned.overdue, x.duties.expected, x.duties.done, x.duties.missed, x.blocked, x.load.pct, x.reports.days, x.reports.expected, { high: 'مرتفع', med: 'متوسط', ok: 'طبيعي' }[x.risk]]; }));
  } else {
    rows = [['الموظف', 'الإدارة', 'النوع', 'المهمة', 'المشروع', 'الأولوية', 'أسندها', 'الموعد', 'الحالة', 'النسبة %', 'أُنجزت', 'في الموعد', 'الاعتماد', 'التعثر', 'تفاصيل الإنجاز', 'التقدير (د)', 'الفعلي (د)']];
    for (const [mid, list] of M.byM) for (const x of list) {
      const key = isDone(x) && x.doneAt ? localDay(set, x.doneAt) : x.due || localDay(set, x.asg.at);
      if (key < from || key > to) continue;
      const m = who.get(mid) || {};
      const dd = x.doneAt ? localDay(set, x.doneAt) : '';
      rows.push([m.name, m.dep, x.asg.kind === 'duty' ? 'واجب دوري' : 'مسندة', x.title, x.asg.projectName || '', PR[prioOf(x)], x.asg.byName || 'التوصيف', x.due, ST[x.status] || x.status, x.prog || 0, dd,
        dd ? (!x.due || dd <= x.due ? 'نعم' : 'لا') : '', x.rv?.state === 'ok' ? 'معتمدة' : x.rv?.state === 'pending' ? 'بانتظار' : x.rv?.state === 'returned' ? 'مُعادة' : '', x.blocked || '', x.rpt || '', x.est || '', x.spent || '']);
    }
  }
  return new Response(csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="itrack-${type}-${from}_${to}.csv"`, 'cache-control': 'no-store' } });
}, { api: true });

/* ═════════════ التكامل ═════════════
   ثلاث طرق، كل واحدة بمفتاح في الإعدادات:
   ١) Webhooks موقّعة (HMAC-SHA256) تصل لأي نظام: Slack/Teams/Google Chat (حقل text) أو ERP أو n8n.
   ٢) مفاتيح API (itk_…) لنظام خارجي يقرأ المؤشرات ويُسند مهام، باسم المسؤول الذي أصدرها وعلى مسارات محددة فقط.
   ٣) رابط تقويم (ICS) يشترك فيه الموظف من Outlook أو Google Calendar أو تقويم الجوال. */
async function hmacHex(secret, body) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(body)));
}
async function deliver(ctx) {
  if (!ctx.events?.length || !ctx.v) return;
  const set = await getSet(ctx);
  if (!set.feat.webhooks) return;
  const hooks = set.hooks.filter((h) => h.on);
  if (!hooks.length) return;
  const jobs = [];
  for (const ev of ctx.events) for (const h of hooks) {
    if (h.events.length && !h.events.includes(ev.event)) continue;
    if (!hookSafe(h.url)) continue; // دفاع إضافي: قد يكون الرابط حُفظ قبل إضافة الحجب
    const body = JSON.stringify({ event: ev.event, at: now(), org: { id: ctx.v.org_id, name: ctx.orgName }, data: ev.data, text: ev.text });
    jobs.push(hmacHex(h.secret, body).then((sig) => fetch(h.url, { method: 'POST', body, redirect: 'manual', // لا نتبع التحويلات: رابط عام قد يحوّل إلى عنوان داخلي
      headers: { 'content-type': 'application/json', 'user-agent': 'ITrack-Webhook/1', 'x-itrack-event': ev.event, 'x-itrack-signature': 'sha256=' + sig },
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined })).catch(() => {}));
  }
  const all = Promise.all(jobs);
  if (ctx.exec?.waitUntil) ctx.exec.waitUntil(all); else await all;
}
route('POST', '/api/settings/hooks/:hid/test', async (ctx) => {
  needAdmin(ctx.v);
  const set = await getSet(ctx);
  const h = set.hooks.find((x) => x.id === ctx.p.hid);
  if (!h) fail(404, 'not-found', 'الرابط غير موجود.');
  const body = JSON.stringify({ event: 'test', at: now(), org: { id: ctx.v.org_id, name: ctx.orgName }, data: {}, text: `اختبار ربط ITrack من ${ctx.v.name}` });
  if (!hookSafe(h.url)) return { ok: false, status: 0, error: 'عنوان غير مسموح.' };
  try {
    const r = await fetch(h.url, { method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/json', 'user-agent': 'ITrack-Webhook/1', 'x-itrack-event': 'test', 'x-itrack-signature': 'sha256=' + await hmacHex(h.secret, body) }, signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined });
    // ننقل حالة HTTP فقط؛ نص الخطأ الخام يكشف للمسؤول الفرق بين «منفذ مغلق» و«مهلة» فيصلح لمسح الشبكة الداخلية
    return { ok: r.ok, status: r.status };
  } catch { return { ok: false, status: 0, error: 'تعذّر الاتصال بالعنوان.' }; }
});

route('GET', '/api/keys', async (ctx) => {
  needAdmin(ctx.v);
  const { results } = await ctx.db.prepare('SELECT k.kh, k.kp, k.name, k.created_at, k.last_at, k.revoked, m.name AS owner FROM api_keys k LEFT JOIN members m ON m.id = k.member_id WHERE k.org_id = ? ORDER BY k.created_at DESC').bind(ctx.v.org_id).all();
  return { keys: results.map((k) => ({ id: k.kh, prefix: k.kp, name: k.name, owner: k.owner, created_at: k.created_at, last_at: k.last_at, revoked: !!k.revoked })) };
});
route('POST', '/api/keys', async (ctx) => {
  const { db, v, body } = ctx;
  needAdmin(v);
  await needFeat(ctx, 'api', 'فعّل «مفاتيح API» من إعدادات التكامل أولًا.');
  const name = text(body.name, 60, { required: true, label: 'اسم النظام' });
  const n_ = await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND revoked = 0').bind(v.org_id).first();
  if (n_.n >= 10) fail(429, 'limit', 'الحد ١٠ مفاتيح فعّالة.');
  const key = 'itk_' + b64e(rand(30)); const kh = await sha(key);
  await db.batch([
    db.prepare('INSERT INTO api_keys (kh, kp, org_id, member_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(kh, key.slice(0, 10), v.org_id, v.id, name, now()),
    auditQ(db, v.org_id, v.id, 'key.create', 'key', kh.slice(0, 16), null, { name }),
  ]);
  return { key, id: kh };
});
route('POST', '/api/keys/:kh/revoke', async (ctx) => {
  const { db, v, p } = ctx;
  needAdmin(v);
  const k = await db.prepare('SELECT name FROM api_keys WHERE kh = ? AND org_id = ?').bind(p.kh, v.org_id).first();
  if (!k) fail(404, 'not-found', 'المفتاح غير موجود.');
  await db.batch([db.prepare('UPDATE api_keys SET revoked = 1 WHERE kh = ?').bind(p.kh), auditQ(db, v.org_id, v.id, 'key.revoke', 'key', p.kh.slice(0, 16), null, { name: k.name })]);
  return { ok: true };
});

/* ───── تقويم: رابط سري لكل موظف ───── */
route('POST', '/api/ics', async (ctx) => {
  const { db, v } = ctx;
  await needFeat(ctx, 'ics', 'رابط التقويم معطّل في إعدادات الجهة.');
  const tok = 'ic_' + b64e(rand(24));
  await db.batch([
    db.prepare('DELETE FROM feeds WHERE member_id = ?').bind(v.id), // رابط جديد يلغي القديم
    db.prepare('INSERT INTO feeds (th, org_id, member_id, created_at) VALUES (?, ?, ?, ?)').bind(await sha(tok), v.org_id, v.id, now()),
  ]);
  return { path: `/api/ics/${tok}.ics` };
});
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsFold = (l) => { const out = []; let s = l; while (s.length > 60) { out.push(s.slice(0, 60)); s = ' ' + s.slice(60); } out.push(s); return out.join('\r\n'); };
route('GET', '/api/ics/:tok', async ({ db, p }) => {
  const tok = p.tok.replace(/\.ics$/, '');
  if (!/^ic_[\w-]{20,60}$/.test(tok)) fail(404, 'not-found', 'غير موجود.');
  const f = await db.prepare("SELECT f.member_id, o.settings FROM feeds f JOIN orgs o ON o.id = f.org_id JOIN members m ON m.id = f.member_id AND m.status = 'active' WHERE f.th = ?").bind(await sha(tok)).first();
  if (!f) fail(404, 'not-found', 'غير موجود.');
  const set = mergeSet(f.settings);
  if (!set.feat.ics) fail(403, 'feature-off', 'رابط التقويم معطّل.');
  const { results } = await db.prepare("SELECT id, data FROM pdocs WHERE member_id = ? AND col = 'tasks' ORDER BY updated_at DESC LIMIT 2000").bind(f.member_id).all();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ITrack//AR', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:ITrack'];
  for (const r of results) {
    const x = JSON.parse(r.data);
    if (isDone(x) || !isDay(x.due || '')) continue;
    const d = x.due.replace(/-/g, '');
    L.push('BEGIN:VEVENT', `UID:${r.id}@itrack`, `DTSTAMP:${stamp}`);
    if (TIME.test(x.time || '')) {
      const st = Date.parse(`${x.due}T${x.time}:00Z`); const en = st + (x.duration || x.est || 30) * 60000;
      const f2 = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15);
      L.push(`DTSTART:${f2(st)}`, `DTEND:${f2(en)}`); // وقت محلي عائم = وقت الجهاز
    } else L.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(x.due, 1).replace(/-/g, '')}`);
    L.push(icsFold(`SUMMARY:${icsEsc((x.asg ? (x.asg.kind === 'duty' ? '↻ ' : '📌 ') : '') + x.title)}`));
    if (x.asg?.desc) L.push(icsFold(`DESCRIPTION:${icsEsc(x.asg.desc)}`));
    L.push('END:VEVENT');
    if (L.length > 6000) break;
  }
  L.push('END:VCALENDAR');
  return new Response(L.join('\r\n') + '\r\n', { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' } });
}, { open: true });

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
/** طبقتان: الخادم (هل ربطت تقنية المعلومات مزوّدًا؟) ثم الجهة (هل فعّله المسؤول؟). الجهة مطلوبة دائمًا كي لا يُتجاوز مفتاحها. */
async function needAi(ctx) {
  if (!aiProvider(ctx.env)) fail(501, 'no-ai', 'الذكاء الاصطناعي غير مفعّل على هذا الخادم.');
  await needFeat(ctx, 'ai', 'الذكاء الاصطناعي معطّل في إعدادات الجهة.');
}
const ctxList = (a, n) => (Array.isArray(a) ? a : []).map((x) => tcut(x, 40)).filter(Boolean).slice(0, n);
function aiCtx(src) {
  return { today: DATE.test(src.today || '') ? src.today : dayOf(now()), weekday: tcut(src.weekday, 20), areas: ctxList(src.areas, 20), people: ctxList(src.people, 40) };
}

route('POST', '/api/ai/voice', async (ctx) => {
  const { db, env, user, raw, q } = ctx;
  await needAi(ctx);
  await quota(db, user.uid, 'transcribe'); await quota(db, user.uid, 'parse');
  if (!okAudio(raw)) fail(400, 'invalid', 'التسجيل غير صالح.');
  let c = {}; try { c = JSON.parse(q.get('ctx') || '{}'); } catch {}
  const x = aiCtx(c);
  const t = await transcribeAudio(env, raw, tcut(q.get('hint') || '', 400));
  if (!t) return { text: '', items: [] };
  return { text: t, items: await parseText(env, t, x.today, x.weekday, x.areas, x.people) };
}, { raw: MAX_AUDIO_B64 });
route('POST', '/api/ai/transcribe', async (ctx) => {
  const { db, env, user, raw, q } = ctx;
  await needAi(ctx); await quota(db, user.uid, 'transcribe');
  if (!okAudio(raw)) fail(400, 'invalid', 'التسجيل غير صالح.');
  return { text: await transcribeAudio(env, raw, tcut(q.get('hint') || '', 400)) };
}, { raw: MAX_AUDIO_B64 });
route('POST', '/api/ai/parse', async (ctx) => {
  const { db, env, user, body } = ctx;
  await needAi(ctx); await quota(db, user.uid, 'parse');
  const t = tcut(body.text, 4000); if (!t) return { items: [] };
  const x = aiCtx(body);
  return { items: await parseText(env, t, x.today, x.weekday, x.areas, x.people) };
});
route('POST', '/api/ai/minutes', async (ctx) => {
  const { db, env, user, body } = ctx;
  await needAi(ctx); await quota(db, user.uid, 'minutes');
  const t = tcut(body.text, 60000); const title = tcut(body.title, 200);
  if (t.length < 20) fail(400, 'invalid', 'النص قصير جدًا.');
  const x = aiCtx(body);
  const j = await llmJson(env, MINUTES_RULES(x.today, title, x.people), t, { name: 'minutes', schema: MINUTES_SCHEMA }, 2500);
  if (!j) fail(502, 'ai-failed', 'لم يُرجع النموذج محضرًا صالحًا.');
  return cleanMinutes(j);
});
/** تقسيم مهمة كبيرة إلى خطوات صغيرة قابلة للتنفيذ (اقتراح يراجعه الإنسان قبل الحفظ). */
const STEPS_SCHEMA = { type: 'object', required: ['steps'], properties: { steps: { type: 'array', items: S_STR } } };
route('POST', '/api/ai/steps', async (ctx) => {
  const { db, env, user, body } = ctx;
  await needAi(ctx); await quota(db, user.uid, 'parse');
  const title = tcut(body.title, 200); if (!title) fail(400, 'invalid', 'اكتب عنوان المهمة.');
  const j = await llmJson(env, `أنت مساعد تخطيط عمل. قسّم المهمة إلى ٣–٧ خطوات عملية مرتبة، كل خطوة تبدأ بفعل وتُنجز في جلسة واحدة (أقل من ساعتين)، بالعربية الفصحى المختصرة. لا تضف ما لا يلزم. أعد JSON فقط بالشكل {"steps":[...]}.`,
    `المهمة: ${title}${body.desc ? `\nالتفاصيل: ${tcut(body.desc, 2000)}` : ''}`, { name: 'steps', schema: STEPS_SCHEMA }, 500);
  return { steps: (Array.isArray(j?.steps) ? j.steps : []).map((s) => tcut(String(s), 160)).filter(Boolean).slice(0, 8) };
});
/** تلخيص نقاش مهمة طويل: ما اتُّفق عليه، وما بقي مفتوحًا. */
const SUM_SCHEMA = { type: 'object', required: ['summary'], properties: { summary: S_STR, open: { type: 'array', items: S_STR } } };
route('POST', '/api/ai/summary', async (ctx) => {
  const { db, env, user, body } = ctx;
  await needAi(ctx); await quota(db, user.uid, 'minutes');
  const x = await taskAccess(ctx, String(body.owner || ''), String(body.task || ''));
  const { results } = await db.prepare('SELECT c.body, m.name FROM comments c LEFT JOIN members m ON m.id = c.author_id WHERE c.owner_id = ? AND c.task_id = ? ORDER BY c.at LIMIT 200').bind(body.owner, body.task).all();
  if (results.length < 2 && !x.t.rpt) fail(400, 'invalid', 'لا يوجد نقاش كافٍ للتلخيص.');
  const thread = results.map((r) => `${r.name || '—'}: ${r.body}`).join('\n').slice(0, 20000);
  const j = await llmJson(env, 'لخّص نقاش مهمة عمل بالعربية في جملتين إلى أربع: ما الوضع، وما اتُّفق عليه. ثم open: ما بقي معلّقًا أو ينتظر أحدًا. لا تخترع. أعد JSON فقط.',
    `المهمة: ${x.t.title}\n${x.t.asg?.desc ? `الوصف: ${x.t.asg.desc}\n` : ''}${x.t.rpt ? `تقرير الموظف: ${x.t.rpt}\n` : ''}النقاش:\n${thread}`, { name: 'summary', schema: SUM_SCHEMA }, 600);
  if (!j) fail(502, 'ai-failed', 'لم يُرجع النموذج ملخصًا صالحًا.');
  return { summary: tcut(j.summary, 1500), open: (Array.isArray(j.open) ? j.open : []).map((s) => tcut(String(s), 300)).filter(Boolean).slice(0, 8) };
});

const OPEN = new Set(['/api/health', '/api/auth/signup', '/api/auth/login', '/api/auth/code']);
const NO_ORG = new Set(['/api/me', '/api/orgs', '/api/auth/logout', '/api/auth/password']);

export default {
  async fetch(req, env, exec) { return withCors(await handle(req, env, exec), req, env); },
};

async function handle(req, env, exec) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(req.url);
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return json({ error: 'not-found', message: 'المسار غير موجود.' }, 404);
  try {
    const db = env.DB;
    if (!db) fail(500, 'no-db', 'قاعدة البيانات غير مربوطة (DB).');
    await migrate(db);
    isD1 = db.constructor?.name === 'D1Database';
    const ctx = { db, env, req, exec, q: url.searchParams, p: url.pathname.match(r.re).groups || {}, body: {} };
    if (!OPEN.has(url.pathname) && !r.open) {
      ctx.user = await identity(req, env, db);
      if (!ctx.user) fail(401, 'auth', 'سجّل الدخول من جديد.');
      if (ctx.user.key) {
        // مفتاح تكامل: الجهة من المفتاح نفسه، والمسارات المعلَّمة api فقط، وبمفتاح «api» مفعّل
        const k = ctx.user.key;
        if (!r.api) fail(403, 'forbidden', 'هذا المسار غير متاح لمفاتيح التكامل.');
        const me = await db.prepare("SELECT * FROM members WHERE id = ? AND org_id = ? AND status = 'active'").bind(k.member_id, k.org_id).first();
        if (!me) fail(403, 'forbidden', 'صاحب المفتاح لم يعد نشطًا.');
        ctx.v = { ...me, isAdmin: me.role === 'admin', subs: await subtree(db, me.org_id, me.id), viaKey: true };
        await needFeat(ctx, 'api', 'مفاتيح التكامل معطّلة في إعدادات الجهة.');
        await throttle(db, 'key:' + k.kh, 3000, 3600_000); await bump(db, 'key:' + k.kh, 3600_000);
        if (now() - (k.last_at || 0) > 3600_000) await db.prepare('UPDATE api_keys SET last_at = ? WHERE kh = ?').bind(now(), k.kh).run();
      } else if (!NO_ORG.has(url.pathname) && !r.noOrg) ctx.v = await viewer(db, ctx.user, req.headers.get('x-org'));
    }
    if (ctx.v && ctx.p.owner === 'me') ctx.p.owner = ctx.v.id; // «مهامي» لا تعرف معرّف العضو: me = أنا
    if (r.bin) {
      ctx.bin = new Uint8Array(await req.arrayBuffer());
      if (ctx.bin.length > r.bin) fail(413, 'too-big', 'الصورة أكبر من المسموح بعد الضغط.');
    } else if (r.raw) {
      // الصوت: نص base64 خام حتى ~٦ ميغابايت، يُمرَّر دون تحليل JSON
      ctx.raw = await req.text();
      if (ctx.raw.length > r.raw) fail(413, 'too-big', 'التسجيل أطول من المسموح.');
    } else if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const raw = await req.text();
      if (raw.length > MAX_BODY) fail(413, 'too-big', 'الطلب أكبر من المسموح.');
      try { ctx.body = raw ? JSON.parse(raw) : {}; } catch { fail(400, 'invalid', 'صيغة الطلب غير صحيحة.'); }
      if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) fail(400, 'invalid', 'صيغة الطلب غير صحيحة.');
    }
    const out = await r.fn(ctx);
    const res = out instanceof Response ? out : json(out);
    if (ctx.events?.length) await deliver(ctx).catch(() => {}); // Webhooks بعد نجاح العملية فقط
    return res;
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ error: 'server', message: 'خطأ في الخادم. حاول مرة أخرى.' }, 500);
  }
}
