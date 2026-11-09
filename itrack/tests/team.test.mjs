// اختبار تذكير التقارير والالتزام الأسبوعي/الشهري وتصدير التقارير: node --experimental-sqlite itrack/tests/team.test.mjs
// لا جدول جديد: يستخدم notes وreports الموجودتين. يُختبر النطاق (من يرى من) والحدود والتكرار.
import { makeD1, makeTokens } from './d1shim.mjs';
const W = (await import('../worker/worker.js')).default;
const DB = makeD1();
const { jwk, token } = makeTokens();
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => (String(u).includes('jwks.test') ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(u, o));
const env = { DB, JWKS_URL: 'https://jwks.test/keys' };
let pass = 0, fails = 0;
const ok = (n, v, x) => { if (v) { pass++; console.log('PASS', n); } else { fails++; console.log('FAIL', n, JSON.stringify(x ?? '').slice(0, 600)); } };
const U = {
  gm: { uid: 'u-gm', email: 'gm@t.test' }, mgr: { uid: 'u-mgr', email: 'mgr@t.test' }, e1: { uid: 'u-e1', email: 'e1@t.test' },
  e2: { uid: 'u-e2', email: 'e2@t.test' }, sib: { uid: 'u-sib', email: 'sib@t.test' }, e3: { uid: 'u-e3', email: 'e3@t.test' },
};
let ORG = null;
async function call(who, method, path, body, { org = ORG } = {}) {
  const headers = {};
  if (who) headers.authorization = 'Bearer ' + token(who);
  if (org) headers['x-org'] = org;
  if (body) headers['content-type'] = 'application/json';
  const res = await W.fetch(new Request('https://api.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const T = dayOf(Date.now() + 180 * 60000);
const day = (n) => dayOf(Date.parse(T + 'T00:00:00Z') + n * 864e5);

ORG = (await call(U.gm, 'POST', '/api/orgs', { name: 'جهة الفريق', my_name: 'المدير العام' }, { org: null })).data.id;
const depA = (await call(U.gm, 'POST', '/api/departments', { name: 'المخازن' })).data.id;
const depB = (await call(U.gm, 'POST', '/api/departments', { name: 'المبيعات' })).data.id;
await call(U.gm, 'PUT', '/api/settings', { weekend: [] }); // كل الأيام عمل ⇒ الحساب لا يتأثر بيوم التشغيل
const gmId = (await call(U.gm, 'GET', '/api/bootstrap')).data.me.id;
const inv = async (email, name, role, manager_id, department_id) => (await call(U.gm, 'POST', '/api/members', { email, name, role, manager_id, department_id })).data.id;
const mMgr = await inv('mgr@t.test', 'مدير المخازن', 'manager', gmId, depA);
const m1 = await inv('e1@t.test', 'سالم', 'employee', mMgr, depA);
const m2 = await inv('e2@t.test', 'علي', 'employee', mMgr, depA);
const mSib = await inv('sib@t.test', 'مدير المبيعات', 'manager', gmId, depB);
const m3 = await inv('e3@t.test', 'خالد', 'employee', mSib, depB);
for (const u of Object.values(U)) await call(u, 'GET', '/api/bootstrap');
// انضم الجميع قبل ٥٠ يومًا ليُحسب لهم المتوقَّع
DB.sq.prepare('UPDATE members SET created_at = ?').run(Date.now() - 50 * 864e5);
const addRep = (mid, d, status = 'submitted') => DB.sq.prepare('INSERT INTO reports (id, org_id, member_id, date, status, late, submitted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)').run(`r-${mid}-${d}`, ORG, mid, d, status, Date.now(), Date.now(), Date.now());

/* ───── التذكير ───── */
let r = await call(U.e1, 'POST', '/api/remind', { members: [m2] });
ok('remind: employee refused (no review scope)', r.data.sent === 0 && r.data.denied === 1, r.data);
r = await call(U.mgr, 'POST', '/api/remind', { members: [] });
ok('remind: empty list refused', r.status === 400, r.data);
r = await call(U.mgr, 'POST', '/api/remind', { members: [m3] });
ok('remind: manager cannot remind outside his branch', r.data.sent === 0 && r.data.denied === 1, r.data);
r = await call(U.mgr, 'POST', '/api/remind', { members: [mMgr] });
ok('remind: cannot remind self', r.data.sent === 0 && r.data.denied === 1, r.data);
addRep(m2, T, 'submitted');
r = await call(U.mgr, 'POST', '/api/remind', { members: [m1, m2] });
ok('remind: sends to the one who has not submitted, skips the one who did', r.data.sent === 1 && r.data.done === 1, r.data);
let ib = (await call(U.e1, 'GET', '/api/inbox')).data;
ok('remind: employee gets an in-app note naming the manager', ib.notes.some((n) => n.kind === 'remind' && n.text.includes('مدير المخازن') && n.text.includes('اليوم')), ib.notes);
ok('remind: the one who submitted gets nothing', !(await call(U.e2, 'GET', '/api/inbox')).data.notes.some((n) => n.kind === 'remind'));
r = await call(U.mgr, 'POST', '/api/remind', { members: [m1] });
ok('remind: not repeated within 4 hours', r.data.sent === 0 && r.data.recent === 1, r.data);
r = await call(U.gm, 'POST', '/api/remind', { members: [m3, 'no-such', 42, { $ne: 1 }] });
ok('remind: admin reaches anyone; unknown ids and junk are denied, not crashed', r.status === 200 && r.data.sent === 1 && r.data.denied >= 1, r.data);
ok('remind: audited with count only', DB.sq.prepare("SELECT COUNT(*) c FROM audit WHERE action = 'report.remind'").get().c === 2);
ib = (await call(U.mgr, 'GET', '/api/inbox')).data;
ok('remind: manager gets no note about his own reminder', !ib.notes.some((n) => n.kind === 'remind'));
r = await call(U.gm, 'POST', '/api/remind', { members: Array.from({ length: 500 }, (_, i) => 'x' + i) });
ok('remind: list capped (no 500-id fan-out)', r.status === 200 && r.data.denied <= 200, r.data);
r = await call(null, 'POST', '/api/remind', { members: [m1] });
ok('remind: anonymous refused', r.status === 401, r.status);

/* ───── الالتزام ───── */
// أسبوعان كاملان لـ m1 (أمس وقبله ١٣ يومًا) و٣ أيام فقط لـ m2، ولا شيء لـ m3
for (let i = 1; i <= 14; i++) addRep(m1, day(-i), i % 5 === 0 ? 'approved' : 'submitted');
for (let i = 1; i <= 3; i++) if (!DB.sq.prepare('SELECT 1 FROM reports WHERE member_id = ? AND date = ?').get(m2, day(-i))) addRep(m2, day(-i), 'returned');
addRep(m1, day(-20), 'draft'); // المسودة لا تُحسب
r = await call(U.mgr, 'GET', '/api/compliance');
ok('compliance: manager sees only his branch (one team, 2 people)', r.status === 200 && r.data.teams.length === 1 && r.data.teams[0].n === 2 && r.data.all.n === 2, r.data.teams);
const wk = r.data.teams[0].weekly;
ok('compliance: 8 weekly + 6 monthly windows ending yesterday', wk.length === 8 && r.data.teams[0].monthly.length === 6 && wk[7].to === day(-1) && r.data.until === day(-1), [wk.length, wk[7]]);
ok('compliance: last week = (7 from m1 + 3 from m2) / 14', wk[7].exp === 14 && wk[7].sub === 10 && wk[7].rate === 71, wk[7]);
ok('compliance: week before = 7/14 (m1 only)', wk[6].sub === 7 && wk[6].exp === 14 && wk[6].rate === 50, wk[6]);
ok('compliance: draft report is not counted', r.data.teams[0].monthly[5].sub === 17, r.data.teams[0].monthly[5]);
r = await call(U.gm, 'GET', '/api/compliance');
ok('compliance: admin sees both departments, largest first', r.data.teams.length === 2 && r.data.teams[0].name === 'المخازن' && r.data.teams[0].n === 3 && r.data.all.n === 5, r.data.teams.map((t) => [t.name, t.n]));
ok('compliance: team with no reports has rate 0 (not null) when people were expected', r.data.teams[1].weekly[7].rate === 0 && r.data.teams[1].weekly[7].exp === 14, r.data.teams[1].weekly[7]);
r = await call(U.e1, 'GET', '/api/compliance');
ok('compliance: employee has no team ⇒ empty, no leak', r.status === 200 && r.data.teams.length === 0 && r.data.all.weekly.length === 0, r.data);
// عضو انضم أمس لا يُحسب عليه ما قبله
DB.sq.prepare('UPDATE members SET created_at = ? WHERE id = ?').run(Date.now() - 36 * 3600e3, m3);
r = await call(U.gm, 'GET', '/api/compliance');
const t3 = r.data.teams.find((t) => t.name === 'المبيعات');
ok('compliance: new joiner counted only from his join day (7 for the old member + 1)', t3.weekly[7].exp === 8, t3.weekly[7]);
await call(U.gm, 'PUT', '/api/settings', { weekend: [0, 1, 2, 3, 4, 5, 6].slice(0, 2) });
r = await call(U.gm, 'GET', '/api/compliance');
ok('compliance: weekend days are excluded from expectation', r.data.all.weekly[7].exp < 5 * 7, r.data.all.weekly[7]);
await call(U.gm, 'PUT', '/api/settings', { weekend: [] });

/* ───── تصدير التقارير ───── */
r = await call(U.mgr, 'GET', `/api/export.csv?type=reports&from=${day(-14)}&to=${day(0)}`);
const lines = String(r.data).replace('﻿', '').split('\r\n');
ok('export reports: header + only my branch, drafts excluded', r.status === 200 && lines[0].startsWith('الموظف,الإدارة,التاريخ,الحالة') && lines.length === 1 + 14 + 3 + 1 && !lines.some((l) => l.includes('خالد')), [lines.length, lines[0]]);
ok('export reports: statuses in Arabic', lines.some((l) => l.includes('معتمد')) && lines.some((l) => l.includes('مُعاد للتعديل')));
r = await call(U.e1, 'GET', `/api/export.csv?type=reports&from=${day(-14)}&to=${day(0)}`);
ok('export reports: employee gets only his own rows', !String(r.data).includes('علي') && String(r.data).includes('سالم'), r.status);
r = await call(U.gm, 'GET', `/api/export.csv?type=reports&from=${day(-14)}&to=${day(0)}`);
ok('export reports: formula-injection guarded', !/(^|,)[=+@]/.test(String(r.data).split('\r\n').slice(1).join('\n')), 'ok');

console.log(`\n${pass} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
