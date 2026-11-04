// ITrack — خادم منصة تتبع إنجاز الموظفين اليومي.
// Cloudflare Worker (الخطة المجانية) + قاعدة D1 (SQLite). ملف واحد بلا مكتبات: يُلصق كما هو في محرّر Cloudflare.
//
// المبادئ:
//   • كل الصلاحيات تُفرض هنا، لا في الواجهة. الواجهة تعرض فقط ما يعيده الخادم.
//   • سجل التدقيق (audit) يُكتب من الخادم فقط ولا يوجد مسار لتعديله أو حذفه.
//   • التوصيف الوظيفي لا يُحذف بنده أبدًا: يُعطَّل (active=0) فتبقى التقارير القديمة مقروءة كما كُتبت.
//   • SQL قياسي ⇒ يُنقل إلى سيرفر الشركة (SQLite/PostgreSQL) دون إعادة كتابة المنطق.
//
// الهوية: رمز دخول Firebase (Authorization: Bearer) يُتحقق من توقيعه محليًا بمفاتيح Google العامة.
// الجهة: ترويسة X-Org. الأدوار: admin (المدير العام/مسؤول الجهة) · manager · employee.
// الرؤية: المسؤول يرى الجميع؛ المدير يرى كل من تحته على أي عمق؛ الموظف يرى نفسه.
//
// الإعداد: ربط D1 باسم DB. متغيرات اختيارية: FIREBASE_PROJECT_ID (افتراضيًا track-b87ef).

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
];

let schemaAt = 0;
async function migrate(db) {
  if (schemaAt === MIGRATIONS.length) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  const row = await db.prepare("SELECT v FROM meta WHERE k = 'schema'").first();
  let v = row ? Number(row.v) : 0;
  while (v < MIGRATIONS.length) {
    await db.batch([...MIGRATIONS[v].map((s) => db.prepare(s)),
      db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(v + 1))]);
    v++;
  }
  schemaAt = v;
}

/* ═════════════ أدوات ═════════════ */
const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-org', 'access-control-max-age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
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
async function identity(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/);
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

/* ═════════════ سياق الطلب: من أنا داخل هذه الجهة ═════════════ */
async function viewer(db, user, orgId) {
  if (!orgId) fail(400, 'no-org', 'لم تُحدَّد الجهة.');
  let me = await db.prepare('SELECT * FROM members WHERE org_id = ? AND (uid = ? OR (uid IS NULL AND email = ?))').bind(orgId, user.uid, user.email).first();
  if (!me || me.status === 'disabled') fail(403, 'not-member', 'لست عضوًا في هذه الجهة.');
  if (!me.uid) {
    // أول دخول بعد الدعوة: نربط الحساب فقط إن ثبتت ملكية البريد
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
  ? { id: m.id, email: m.email, name: m.name, role: m.role, department_id: m.department_id, position_id: m.position_id, manager_id: m.manager_id, status: m.status, joined: !!m.uid }
  : { id: m.id, name: m.name, role: m.role, department_id: m.department_id, position_id: m.position_id }); // المدير المباشر: الاسم فقط
const pubReport = (r) => r && ({ id: r.id, member_id: r.member_id, date: r.date, status: r.status, note: r.note, late: !!r.late, submitted_at: r.submitted_at, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, review_comment: r.review_comment, updated_at: r.updated_at });
const pubItem = (i) => ({ id: i.id, text: i.text, responsibility_id: i.responsibility_id, minutes: i.minutes, state: i.state, blocker: i.blocker });

/* ═════════════ المسارات ═════════════ */
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

route('GET', '/api/health', async () => ({ ok: true, app: 'itrack', schema: MIGRATIONS.length }));

/** حسابي والجهات التي أنتمي إليها (أو دُعيت إليها). */
route('GET', '/api/me', async ({ db, user }) => {
  const { results } = await db.prepare(`SELECT m.id AS member_id, m.name, m.role, m.status, m.uid, o.id, o.name AS org_name
    FROM members m JOIN orgs o ON o.id = m.org_id WHERE (m.uid = ? OR (m.uid IS NULL AND m.email = ?)) AND m.status != 'disabled'`).bind(user.uid, user.email).all();
  return { email: user.email, verified: user.verified, orgs: results.map((r) => ({ id: r.id, name: r.org_name, role: r.role, member_id: r.member_id, my_name: r.name, invited: !r.uid })) };
});

/** إنشاء جهة جديدة: المنشئ يصبح مسؤولها. */
route('POST', '/api/orgs', async ({ db, user, body }) => {
  if (!user.verified) fail(403, 'verify-email', 'أكّد بريدك الإلكتروني أولًا.');
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
  const [mem, deps, pos, resp] = await db.batch([
    db.prepare('SELECT * FROM members WHERE org_id = ? ORDER BY name').bind(v.org_id),
    db.prepare('SELECT id, name, active FROM departments WHERE org_id = ? ORDER BY name').bind(v.org_id),
    db.prepare('SELECT id, title, department_id, summary, version, active FROM positions WHERE org_id = ? ORDER BY title').bind(v.org_id),
    db.prepare('SELECT id, position_id, title, detail, sort, active FROM responsibilities WHERE org_id = ? ORDER BY sort').bind(v.org_id),
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
    db.prepare("INSERT INTO members (id, org_id, email, name, role, department_id, position_id, manager_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invited', ?, ?)")
      .bind(mid, v.org_id, email, f.name, f.role, f.department_id, f.position_id, f.manager_id, t, t),
    auditQ(db, v.org_id, v.id, 'member.invite', 'member', mid, mid, { email, ...f }),
  ]);
  return { id: mid };
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
  for (const k of ['name', 'role', 'department_id', 'position_id', 'manager_id']) if (m[k] !== f[k]) diff[k] = [m[k], f[k]];
  if (m.status !== status) diff.status = [m.status, status];
  if (!Object.keys(diff).length) return { ok: true };
  await db.batch([
    db.prepare('UPDATE members SET name = ?, role = ?, department_id = ?, position_id = ?, manager_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(f.name, f.role, f.department_id, f.position_id, f.manager_id, status, now(), m.id),
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
const OPEN = new Set(['/api/health']);
const NO_ORG = new Set(['/api/me', '/api/orgs']);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return json({ error: 'not-found', message: 'المسار غير موجود.' }, 404);
    try {
      const db = env.DB;
      if (!db) fail(500, 'no-db', 'قاعدة البيانات غير مربوطة (DB).');
      await migrate(db);
      const ctx = { db, env, q: url.searchParams, p: url.pathname.match(r.re).groups || {}, body: {} };
      if (!OPEN.has(url.pathname)) {
        ctx.user = await identity(req, env);
        if (!ctx.user) fail(401, 'auth', 'سجّل الدخول من جديد.');
        if (!NO_ORG.has(url.pathname)) ctx.v = await viewer(db, ctx.user, req.headers.get('x-org'));
      }
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
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
  },
};
