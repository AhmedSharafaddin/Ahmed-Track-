// اختبار خادم ITrack كاملًا: node --experimental-sqlite itrack/tests/worker.test.mjs
import { makeD1, makeTokens } from './d1shim.mjs';
const W = (await import('../worker/worker.js')).default;
const DB = makeD1();
const { jwk, token } = makeTokens();
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => (String(u).includes('jwks.test') ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(u, o));
const env = { DB, JWKS_URL: 'https://jwks.test/keys' };
let pass = 0, fail = 0;
const ok = (n, v, x) => { if (v) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, JSON.stringify(x ?? '').slice(0, 500)); } };
const U = {
  gm: { uid: 'u-gm', email: 'GM@Org.test' }, mgr: { uid: 'u-mgr', email: 'mgr@org.test' }, sup: { uid: 'u-sup', email: 'sup@org.test' },
  emp: { uid: 'u-emp', email: 'emp@org.test' }, emp2: { uid: 'u-emp2', email: 'emp2@org.test' }, out: { uid: 'u-out', email: 'out@other.test' },
  fake: { uid: 'u-fake', email: 'emp2@org.test', verified: false },
};
let ORG = null;
async function call(who, method, path, body, org = ORG) {
  const headers = { 'content-type': 'application/json' };
  if (who) headers.authorization = 'Bearer ' + (typeof who === 'string' ? who : token(who));
  if (org) headers['x-org'] = org;
  const res = await W.fetch(new Request('https://api.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, data: await res.json() };
}
const today = new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

ok('health open', (await call(null, 'GET', '/api/health')).data.ok === true);
ok('no token → 401', (await call(null, 'GET', '/api/me')).status === 401);
ok('bad token → 401', (await call('a.b.c', 'GET', '/api/me')).status === 401);
ok('expired token → 401', (await call(token({ ...U.gm, exp: -10 }), 'GET', '/api/me')).status === 401);
ok('unverified cannot create org', (await call({ ...U.gm, verified: false }, 'POST', '/api/orgs', { name: 'x', my_name: 'y' })).status === 403);
let r = await call(U.gm, 'POST', '/api/orgs', { name: 'إدارة الخدمات', my_name: 'المدير العام' });
ok('create org', r.status === 200 && r.data.id, r); ORG = r.data.id;
r = await call(U.gm, 'GET', '/api/me');
ok('me lists org as admin (email lowercased)', r.data.email === 'gm@org.test' && r.data.orgs[0].role === 'admin', r.data);

// الهيكل
const dep = (await call(U.gm, 'POST', '/api/departments', { name: 'اللوجستيات' })).data.id;
r = await call(U.gm, 'POST', '/api/positions', { title: 'أمين مخزن', department_id: dep, summary: 'إدارة المخزون', responsibilities: [{ title: 'استلام الشحنات ومطابقتها' }, { title: 'تحديث سجل المخزون', detail: 'يوميًا' }, { title: '' }] });
ok('create position', r.status === 200 && r.data.version === 1, r); const pos = r.data.id;
let boot = (await call(U.gm, 'GET', '/api/bootstrap')).data;
const resp = boot.positions[0].responsibilities;
ok('empty responsibility dropped', resp.length === 2, resp);

// الأعضاء: مدير ← مشرف ← موظفان
const inv = async (email, name, role, manager_id, position_id = null) => (await call(U.gm, 'POST', '/api/members', { email, name, role, manager_id, department_id: dep, position_id })).data.id;
const mMgr = await inv('mgr@org.test', 'مدير الإدارة', 'manager', null);
const gmId = boot.me.id;
await call(U.gm, 'PATCH', `/api/members/${mMgr}`, { manager_id: gmId });
const mSup = await inv('SUP@org.test', 'المشرف', 'manager', mMgr);
const mEmp = await inv('emp@org.test', 'الموظف الأول', 'employee', mSup, pos);
const mEmp2 = await inv('emp2@org.test', 'الموظف الثاني', 'employee', mMgr, pos);
ok('duplicate invite 409', (await call(U.gm, 'POST', '/api/members', { email: 'Emp@org.test', name: 'x' })).status === 409);
ok('non-admin cannot invite', (await call(U.mgr, 'POST', '/api/members', { email: 'z@org.test', name: 'z' })).status === 403);
ok('cycle rejected', (await call(U.gm, 'PATCH', `/api/members/${mMgr}`, { manager_id: mEmp })).data.error === 'cycle');
ok('self-manager rejected', (await call(U.gm, 'PATCH', `/api/members/${mEmp}`, { manager_id: mEmp })).status === 400);
ok('last admin protected', (await call(U.gm, 'PATCH', `/api/members/${gmId}`, { role: 'employee' })).data.error === 'last-admin');

// الانضمام: رمز غير مؤكد لا يربط الحساب
ok('unverified invitee blocked', (await call(U.fake, 'GET', '/api/bootstrap')).data.error === 'verify-email');
ok('outsider not member', (await call(U.out, 'GET', '/api/bootstrap')).data.error === 'not-member');
r = await call(U.emp, 'GET', '/api/bootstrap');
ok('employee joins and sees only self + manager name', r.status === 200 && r.data.members.length === 2 && r.data.members.find((m) => m.id === mSup)?.email === undefined, r.data.members);
ok('employee sees own position JD', r.data.positions.length === 1 && r.data.positions[0].responsibilities.length === 2);
ok('fake uid cannot take joined seat', (await call({ uid: 'u-thief', email: 'emp@org.test' }, 'GET', '/api/bootstrap')).data.error === 'not-member');
for (const u of [U.mgr, U.sup, U.emp2]) await call(u, 'GET', '/api/bootstrap');
r = await call(U.mgr, 'GET', '/api/bootstrap');
ok('manager sees whole subtree (depth 2)', ['mgr', mSup, mEmp, mEmp2].length && [mSup, mEmp, mEmp2].every((x) => r.data.me.subs.includes(x)) && r.data.members.length === 5, r.data.members.map((m) => m.name));
r = await call(U.sup, 'GET', '/api/bootstrap');
ok('supervisor sees only his employee', r.data.me.subs.length === 1 && r.data.me.subs[0] === mEmp && !r.data.members.find((m) => m.id === mEmp2));

// التقرير اليومي
const items = [
  { text: 'استلمت شحنة المورد وطابقتها مع الفاتورة', responsibility_id: resp[0].id, minutes: 60, state: 'done' },
  { text: 'جرد الرف ب', responsibility_id: resp[1].id, minutes: 45, state: 'progress' },
  { text: 'تأخر تسليم الطابعة', state: 'blocked', blocker: 'المورد لم يرد' },
  { text: 'بند بمسؤولية مزيّفة', responsibility_id: 'not-mine-123', minutes: 9999 },
];
r = await call(U.emp, 'PUT', `/api/report/${today}`, { today, note: 'نقص كراتين', items });
ok('save draft', r.status === 200 && r.data.status === 'draft' && r.data.items.length === 4, r);
ok('foreign responsibility + absurd minutes dropped', r.data.items[3].responsibility_id === null && r.data.items[3].minutes === null);
ok('blocker kept only when blocked', r.data.items[2].blocker === 'المورد لم يرد' && r.data.items[0].blocker === '');
ok('future day rejected', (await call(U.emp, 'PUT', `/api/report/${day(3)}`, { items })).data.error === 'future');
ok('too old rejected', (await call(U.emp, 'PUT', `/api/report/${day(-10)}`, { today, items })).data.error === 'too-old');
r = await call(U.sup, 'GET', `/api/report?member=${mEmp}&date=${today}`);
ok('manager cannot read draft content', r.data.report.status === 'draft' && r.data.items.length === 0 && r.data.report.note === undefined, r.data);
r = await call(U.sup, 'GET', `/api/day?date=${today}`);
ok('day board shows draft without numbers', r.data.rows.length === 1 && r.data.rows[0].status === 'draft' && r.data.rows[0].items === undefined, r.data);
ok('cannot review draft', (await call(U.sup, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'approve' })).data.error === 'state');
r = await call(U.emp, 'POST', `/api/report/${today}/submit`, { today });
ok('submit', r.data.status === 'submitted', r);
ok('locked after submit', (await call(U.emp, 'PUT', `/api/report/${today}`, { today, items })).data.error === 'locked');
ok('double submit rejected', (await call(U.emp, 'POST', `/api/report/${today}/submit`, { today })).status === 409);
r = await call(U.sup, 'GET', `/api/day?date=${today}`);
ok('day board counts', r.data.rows[0].items === 4 && r.data.rows[0].minutes === 105 && r.data.rows[0].blocked === 1, r.data);
ok('outside subtree cannot read report', (await call(U.emp2, 'GET', `/api/report?member=${mEmp}&date=${today}`)).status === 403);
r = await call(U.sup, 'GET', `/api/inbox?today=${today}`);
ok('inbox: supervisor sees submitted report to review', r.data.review.length === 1 && r.data.review[0].member_id === mEmp && r.data.review[0].date === today, r.data);
r = await call(U.mgr, 'GET', `/api/inbox?today=${today}`);
ok('inbox: upper manager sees it too (subtree)', r.data.review.some((x) => x.member_id === mEmp), r.data);
ok('inbox: employee has nothing to review', (await call(U.emp, 'GET', `/api/inbox?today=${today}`)).data.review.length === 0);
ok('inbox: other branch does not see it', (await call(U.emp2, 'GET', `/api/inbox?today=${today}`)).data.review.length === 0);
ok('employee cannot review self', (await call(U.emp, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'approve' })).status === 403);
ok('sibling manager branch cannot review', (await call(U.emp2, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'approve' })).status === 403);
ok('return needs reason', (await call(U.sup, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'return' })).status === 400);
r = await call(U.sup, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'return', comment: 'أضف رقم الشحنة' });
ok('return', r.data.status === 'returned', r);
r = await call(U.emp, 'GET', `/api/inbox?today=${today}`);
ok('inbox: employee sees returned report with reason', r.data.returned.length === 1 && r.data.returned[0].review_comment === 'أضف رقم الشحنة', r.data);
ok('inbox: returned report left review queue', (await call(U.sup, 'GET', `/api/inbox?today=${today}`)).data.review.length === 0);
r = await call(U.emp, 'PUT', `/api/report/${today}`, { today, note: 'نقص كراتين', items: [{ ...items[0], text: 'استلمت الشحنة 4471 وطابقتها' }, items[1]] });
ok('edit after return', r.status === 200 && r.data.status === 'returned' && r.data.items.length === 2, r);
ok('resubmit', (await call(U.emp, 'POST', `/api/report/${today}/submit`, { today })).data.status === 'submitted');
r = await call(U.mgr, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'approve', comment: 'ممتاز' });
ok('skip-level manager approves', r.data.status === 'approved', r);
ok('approved is final', (await call(U.sup, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'return', comment: 'x' })).data.error === 'state');
ok('comment on approved ok', (await call(U.gm, 'POST', '/api/review', { member_id: mEmp, date: today, action: 'comment', comment: 'شكرًا' })).status === 200);
r = await call(U.emp, 'GET', `/api/report?date=${today}`);
ok('trail: create→submit→return→resubmit→approve→comment', r.data.trail.map((t) => t.action).join(',') === 'report.create,report.submit,report.return,report.resubmit,report.approve,report.comment', r.data.trail);
ok('trail names actors', r.data.trail[2].actor === 'المشرف' && r.data.trail[4].actor === 'مدير الإدارة');
const snap = DB.sq.prepare("SELECT data FROM audit WHERE action='report.submit'").get();
ok('submit snapshot preserved in audit', JSON.parse(snap.data).items.length === 4);

// تقرير متأخر + التاريخ والتغطية
r = await call(U.emp, 'PUT', `/api/report/${day(-2)}`, { today, items: [{ text: 'متابعة مرتجعات', responsibility_id: resp[1].id, minutes: 30 }] });
ok('late report flagged', DB.sq.prepare('SELECT late FROM reports WHERE id = ?').get(r.data.id).late === 1);
r = await call(U.sup, 'GET', `/api/history?member=${mEmp}&from=${day(-13)}&to=${today}`);
ok('history: draft hidden for manager', r.data.days.length === 2 && r.data.days[0].status === 'draft' && r.data.days[0].items === undefined, r.data);
ok('coverage excludes others drafts', r.data.coverage.reduce((s, c) => s + c.n, 0) === 2, r.data.coverage);
r = await call(U.emp, 'GET', `/api/history?from=${day(-13)}&to=${today}`);
ok('own coverage includes my draft', r.data.coverage.reduce((s, c) => s + c.n, 0) === 3, r.data.coverage);
ok('history range capped', (await call(U.emp, 'GET', `/api/history?from=${day(-200)}&to=${today}`)).status === 400);

// التوصيف: تعطيل لا حذف
r = await call(U.gm, 'PUT', `/api/positions/${pos}`, { title: 'أمين مخزن', department_id: dep, summary: 'إدارة المخزون', responsibilities: [{ id: resp[1].id, title: 'تحديث سجل المخزون', detail: 'يوميًا' }, { title: 'إعداد تقرير الجرد الشهري' }] });
ok('position version bump', r.data.version === 2, r);
boot = (await call(U.gm, 'GET', '/api/bootstrap')).data;
const rs = boot.positions[0].responsibilities;
ok('removed responsibility deactivated, not deleted', rs.length === 3 && rs.find((x) => x.id === resp[0].id).active === 0, rs);
r = await call(U.emp, 'GET', `/api/report?date=${today}`);
ok('old items still reference old responsibility', r.data.items[0].responsibility_id === resp[0].id);
r = await call(U.gm, 'PUT', `/api/positions/${pos}`, { title: 'أمين مخزن', department_id: dep, summary: 'إدارة المخزون', responsibilities: [{ id: resp[1].id, title: 'تحديث سجل المخزون', detail: 'يوميًا' }, { id: rs.find((x) => x.title.includes('الجرد')).id, title: 'إعداد تقرير الجرد الشهري' }] });
ok('no-op edit keeps version', r.data.version === 2, r);

// التعطيل والتدقيق
await call(U.gm, 'PATCH', `/api/members/${mEmp2}`, { status: 'disabled' });
ok('disabled member locked out', (await call(U.emp2, 'GET', '/api/bootstrap')).data.error === 'not-member');
r = await call(U.gm, 'GET', '/api/audit');
ok('org audit for admin', r.data.rows.length > 10 && r.data.rows[0].action === 'member.update', r.data.rows[0]);
ok('audit org-wide forbidden for manager', (await call(U.mgr, 'GET', '/api/audit')).status === 403);
r = await call(U.sup, 'GET', `/api/audit?member=${mEmp}`);
ok('manager sees subject audit', r.data.rows.some((a) => a.action === 'report.approve'));
ok('no route to edit/delete audit', (await call(U.gm, 'PATCH', '/api/audit', {})).status === 404);
ok('other org header isolated', (await call(U.emp, 'GET', '/api/bootstrap', null, 'org-x')).data.error === 'not-member');
ok('junk body 400', (await W.fetch(new Request('https://api.test/api/departments', { method: 'POST', headers: { authorization: 'Bearer ' + token(U.gm), 'x-org': ORG }, body: '[1' }), env)).status === 400);
r = await call(U.gm, 'GET', '/api/bootstrap');
ok('query budget: bootstrap ok', r.status === 200);
// المساحة الشخصية: خاصة بصاحبها، والمشاركة اختيار لكل مهمة
await call(U.gm, 'PATCH', `/api/members/${mEmp2}`, { status: 'active' }); // أُعطّل أعلاه
const P = (who, ops) => call(who, 'POST', '/api/p', { ops });
r = await P(U.emp, [
  { op: 'set', col: 'tasks', id: 't1', data: { title: 'مهمة خاصة', status: 'open' } },
  { op: 'set', col: 'tasks', id: 't2', data: { title: 'مهمة أُظهرها لمديري', status: 'open', shared: true } },
  { op: 'set', col: 'areas', id: 'a1', data: { name: 'العمل', shared: true } },
]);
ok('personal: save docs', r.status === 200 && r.data.n === 3, r);
r = await call(U.emp, 'GET', '/api/p/tasks');
ok('personal: owner reads own tasks', r.data.docs.length === 2 && r.data.docs.find((d) => d.id === 't1').title === 'مهمة خاصة', r.data);
ok('personal: other employee sees none', (await call(U.emp2, 'GET', '/api/p/tasks')).data.docs.length === 0);
ok('personal: manager reading /p sees only his own (empty)', (await call(U.sup, 'GET', '/api/p/tasks')).data.docs.length === 0);
r = await call(U.sup, 'GET', `/api/team/tasks?member=${mEmp}`);
ok('personal: manager sees only shared task', r.data.tasks.length === 1 && r.data.tasks[0].id === 't2', r.data);
r = await call(U.mgr, 'GET', '/api/team/tasks');
ok('personal: upper manager sees shared task, not private', r.data.tasks.length === 1 && r.data.tasks[0].id === 't2', r.data);
ok('personal: sibling branch sees nothing', (await call(U.emp2, 'GET', '/api/team/tasks')).data.tasks.length === 0);
ok('personal: sibling cannot query member', (await call(U.emp2, 'GET', `/api/team/tasks?member=${mEmp}`)).status === 403);
ok('personal: shared flag only for tasks (areas stay private)', DB.sq.prepare("SELECT shared FROM pdocs WHERE col='areas'").get().shared === 0);
await P(U.emp, [{ op: 'patch', col: 'tasks', id: 't2', data: { shared: false } }]);
ok('personal: unshare via patch hides it', (await call(U.sup, 'GET', `/api/team/tasks?member=${mEmp}`)).data.tasks.length === 0);
await P(U.emp, [{ op: 'patch', col: 'tasks', id: 't1', data: { status: 'done', note: 'x' } }]);
r = await call(U.emp, 'GET', '/api/p/tasks');
ok('personal: patch merges fields', r.data.docs.find((d) => d.id === 't1').title === 'مهمة خاصة' && r.data.docs.find((d) => d.id === 't1').status === 'done', r.data);
await P(U.emp, [{ op: 'del', col: 'tasks', id: 't1' }]);
ok('personal: delete', (await call(U.emp, 'GET', '/api/p/tasks')).data.docs.length === 1);
ok('personal: bad collection 404', (await call(U.emp, 'GET', '/api/p/members')).status === 404);
ok('personal: bad id 400', (await P(U.emp, [{ op: 'set', col: 'tasks', id: '../x', data: { a: 1 } }])).status === 400);
ok('personal: too many ops 400', (await P(U.emp, Array.from({ length: 41 }, (_, i) => ({ op: 'set', col: 'tasks', id: 'x' + i, data: { a: 1 } })))).status === 400);
ok('personal: oversized doc 413', (await P(U.emp, [{ op: 'set', col: 'tasks', id: 'big', data: { t: 'x'.repeat(9000) } }])).status === 413);
ok('personal: not in audit', DB.sq.prepare("SELECT COUNT(*) c FROM audit WHERE entity IN ('pdoc','pdocs','personal') OR action LIKE 'personal%' OR data LIKE '%مهمة خاصة%'").get().c === 0);

// CORS: الواجهة فقط
const pre = async (origin) => (await W.fetch(new Request('https://api.test/api/me', { method: 'OPTIONS', headers: { origin } }), env)).headers;
ok('cors: app origin allowed', (await pre('https://ahmedsharafaddin.github.io')).get('access-control-allow-origin') === 'https://ahmedsharafaddin.github.io');
ok('cors: localhost allowed (dev)', (await pre('http://localhost:8797')).get('access-control-allow-origin') === 'http://localhost:8797');
ok('cors: foreign origin refused', (await pre('https://evil.example')).get('access-control-allow-origin') === null);
ok('cors: headers on error responses', (await W.fetch(new Request('https://api.test/api/me', { headers: { origin: 'https://ahmedsharafaddin.github.io' } }), env)).headers.get('access-control-allow-origin') === 'https://ahmedsharafaddin.github.io');
ok('cors: env override', (await W.fetch(new Request('https://api.test/api/health', { headers: { origin: 'https://itrack.example.com' } }), { ...env, ALLOWED_ORIGINS: 'https://itrack.example.com' })).headers.get('access-control-allow-origin') === 'https://itrack.example.com');
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
