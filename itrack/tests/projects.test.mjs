// اختبار المشاريع: node --experimental-sqlite itrack/tests/projects.test.mjs
// الإنشاء والصلاحيات والرؤية (مسؤول/مدير/موظف/مدير شقيق)، ربط الإسناد بالمشروع وقفله، النسب الموزونة، إعادة التسمية، الأرشفة.
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
  gm: { uid: 'u-gm', email: 'gm@p.test' }, mgr: { uid: 'u-mgr', email: 'mgr@p.test' }, emp: { uid: 'u-emp', email: 'emp@p.test' },
  emp2: { uid: 'u-emp2', email: 'emp2@p.test' }, sib: { uid: 'u-sib', email: 'sib@p.test' }, emp3: { uid: 'u-emp3', email: 'emp3@p.test' },
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
const T = new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(T + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const P = (who, ops) => call(who, 'POST', '/api/p', { ops });
const myTasks = async (who) => (await call(who, 'GET', '/api/p/tasks')).data.docs;

/* ───── التهيئة: مسؤول ← مدير ← موظفان، ومدير شقيق ← موظف ───── */
ORG = (await call(U.gm, 'POST', '/api/orgs', { name: 'شركة الاختبار', my_name: 'المدير العام' }, { org: null })).data.id;
const dep = (await call(U.gm, 'POST', '/api/departments', { name: 'المخازن' })).data.id;
await call(U.gm, 'PUT', '/api/settings', { weekend: [] });
const gmId = (await call(U.gm, 'GET', '/api/bootstrap')).data.me.id;
const inv = async (email, name, role, manager_id) => (await call(U.gm, 'POST', '/api/members', { email, name, role, manager_id, department_id: dep })).data.id;
const mMgr = await inv('mgr@p.test', 'مدير المخازن', 'manager', gmId);
const mEmp = await inv('emp@p.test', 'سالم', 'employee', mMgr);
const mEmp2 = await inv('emp2@p.test', 'علي', 'employee', mMgr);
const mSib = await inv('sib@p.test', 'مدير المبيعات', 'manager', gmId);
const mEmp3 = await inv('emp3@p.test', 'خالد', 'employee', mSib);

/* ───── الإنشاء والصلاحيات ───── */
let r = await call(U.emp, 'POST', '/api/projects', { name: 'x' });
ok('create: employee refused', r.status === 403, r.data);
r = await call(U.mgr, 'POST', '/api/projects', { name: '  ' });
ok('create: name required', r.status === 400, r.data);
r = await call(U.mgr, 'POST', '/api/projects', { name: 'جرد نهاية العام', descr: 'جرد كل المخازن وتسوية الفروقات', due: 'not-a-date' });
ok('create: bad due refused', r.status === 400, r.data);
r = await call(U.mgr, 'POST', '/api/projects', { name: 'جرد نهاية العام', descr: 'جرد كل المخازن وتسوية الفروقات', due: day(20) });
ok('create: manager creates', r.status === 200 && r.data.id, r.data);
const PJ = r.data.id;
ok('create: audited', DB.sq.prepare("SELECT COUNT(*) c FROM audit WHERE action = 'project.create' AND entity_id = ?").get(PJ).c === 1);

/* ───── الإسناد داخل المشروع ───── */
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: 'جرد الرف أ', due: day(3), prio: 3, project: 'no-such' });
ok('assign: unknown project refused', r.status === 400, r.data);
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: 'جرد الرف أ', due: day(3), prio: 3, project: PJ });
ok('assign: into project', r.status === 200, r.data);
const A1 = r.data.ids[0].id;
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp, mEmp2], title: 'تسوية الفروقات', due: day(-1), prio: 1, project: PJ });
ok('assign: group into project', r.status === 200 && r.data.ids.length === 2, r.data);
const lateIds = r.data.ids;
await call(U.mgr, 'POST', '/api/assign', { to: [mEmp2], title: 'مهمة بلا مشروع' });
let d = (await myTasks(U.emp)).find((x) => x.id === A1);
ok('assign: employee sees project name on his task', d.asg.project === PJ && d.asg.projectName === 'جرد نهاية العام', d?.asg);
ok('assign: task without project has none', !(await myTasks(U.emp2)).find((x) => x.title === 'مهمة بلا مشروع').asg.project);

/* ───── القفل: الموظف لا يغيّر مشروع مهمته ───── */
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A1, data: { asg: { project: 'x', projectName: 'مزوّر' } } }]);
d = (await myTasks(U.emp)).find((x) => x.id === A1);
ok('lock: employee cannot rewrite asg.project', d.asg.project === PJ && d.asg.projectName === 'جرد نهاية العام', d.asg);
await P(U.emp, [{ op: 'set', col: 'tasks', id: 'p-self', data: { title: 'مهمتي', asg: { kind: 'assign', project: PJ, projectName: 'جرد نهاية العام', by: 'x' } } }]);
r = await call(U.mgr, 'GET', `/api/projects/${PJ}`);
ok('lock: forged self-task with asg.project is not counted', r.data.tasks.length === 3 && !r.data.tasks.some((t) => t.title === 'مهمتي'), r.data.tasks?.map((t) => t.title));

/* ───── النسب والنتائج ───── */
// إنجاز مهمة حرجة (وزن ٣) واستمرار الباقي: أ حرجة منجزة، التسوية (عادية ×٢) متأخرة ٥٠٪ و٠٪
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A1, data: { status: 'done', completedAt: Date.now(), prog: 100 } }]);
await P(U.emp, [{ op: 'patch', col: 'tasks', id: lateIds.find((x) => x.member_id === mEmp).id, data: { prog: 50 } }]);
r = await call(U.mgr, 'GET', `/api/projects/${PJ}`);
const S = r.data.stats;
ok('stats: counts', S.total === 3 && S.done === 1 && S.open === 2 && S.overdue === 2, S);
ok('stats: weighted % = (3*100 + 1*50 + 1*0) / 5 = 70', S.pct === 70, S);
ok('stats: health late when something is overdue', S.health === 'late', S);
ok('stats: per member breakdown', r.data.members.length === 2 && r.data.members.find((m) => m.name === 'علي').pct === 0 && r.data.members.find((m) => m.name === 'سالم').pct === 88 /* (3*100 + 1*50) / 4 */, r.data.members);
ok('detail: owner + task rows carry member names', r.data.project.owner === 'مدير المخازن' && r.data.tasks.every((t) => t.member && t.member !== '—'), r.data.project);

/* ───── الرؤية ───── */
r = await call(U.emp, 'GET', '/api/projects');
ok('visibility: employee sees the project with ONLY his own numbers', r.data.projects.length === 1 && r.data.projects[0].stats.total === 2 && r.data.scope === 'own', r.data);
r = await call(U.emp2, 'GET', `/api/projects/${PJ}`);
ok('visibility: other employee sees only his tasks', r.status === 200 && r.data.tasks.length === 1 && r.data.tasks.every((t) => t.member === 'علي'), r.data.tasks?.map((t) => t.member));
r = await call(U.emp3, 'GET', `/api/projects/${PJ}`);
ok('visibility: unrelated employee gets 404', r.status === 404, r.status);
r = await call(U.emp3, 'GET', '/api/projects');
ok('visibility: unrelated employee lists nothing', r.data.projects.length === 0, r.data);
r = await call(U.sib, 'GET', `/api/projects/${PJ}`);
ok('visibility: sibling manager (no tasks of his branch) gets 404', r.status === 404, r.status);
r = await call(U.gm, 'GET', `/api/projects/${PJ}`);
ok('visibility: admin sees all 3 tasks', r.status === 200 && r.data.tasks.length === 3 && r.data.scope === 'all', r.data.scope);
r = await call(U.gm, 'GET', '/api/projects', null, { org: 'other-org' });
ok('visibility: foreign org header refused', r.status >= 400, r.status);

/* ───── الإسناد من مدير شقيق داخل مشروع الغير ───── */
r = await call(U.sib, 'POST', '/api/assign', { to: [mEmp3], title: 'مساهمة المبيعات', project: PJ });
ok('assign: another manager may add his own people to an active project', r.status === 200, r.data);
r = await call(U.mgr, 'GET', `/api/projects/${PJ}`);
ok('visibility: owner does NOT see the sibling branch task (partial scope is honest)', r.data.tasks.length === 3 && r.data.scope === 'branch', r.data.tasks.length);
r = await call(U.gm, 'GET', `/api/projects/${PJ}`);
ok('visibility: admin now sees 4', r.data.tasks.length === 4, r.data.tasks.length);
r = await call(U.sib, 'GET', `/api/projects/${PJ}`);
ok('visibility: sibling now sees the project with only his task', r.status === 200 && r.data.tasks.length === 1, r.data.tasks?.length);

/* ───── التعديل وإعادة التسمية والأرشفة ───── */
r = await call(U.sib, 'PATCH', `/api/projects/${PJ}`, { name: 'اختراق' });
ok('edit: non-owner manager refused', r.status === 403, r.data);
r = await call(U.emp, 'PATCH', `/api/projects/${PJ}`, { name: 'اختراق' });
ok('edit: employee refused', r.status === 403, r.data);
r = await call(U.mgr, 'PATCH', `/api/projects/${PJ}`, { name: 'جرد 2026', due: day(30) });
ok('edit: owner renames', r.status === 200);
ok('rename: propagates to employees tasks (all branches)', (await myTasks(U.emp)).find((x) => x.id === A1).asg.projectName === 'جرد 2026' && (await myTasks(U.emp3)).find((x) => x.asg?.project === PJ).asg.projectName === 'جرد 2026');
ok('rename: audited with diff', DB.sq.prepare("SELECT data FROM audit WHERE action = 'project.update' AND entity_id = ?").get(PJ).data.includes('جرد 2026'));
r = await call(U.gm, 'PATCH', `/api/projects/${PJ}`, { status: 'weird' });
ok('edit: unknown status refused', r.status === 400, r.data);
// نقل مهمة من/إلى مشروع عبر تعديل الإسناد
r = await call(U.mgr, 'POST', '/api/projects', { name: 'مشروع ثانٍ' });
const PJ2 = r.data.id;
r = await call(U.mgr, 'PATCH', `/api/assign/${mEmp2}/${lateIds.find((x) => x.member_id === mEmp2).id}`, { project: PJ2 });
ok('move: assigned task moves to another project', r.status === 200 && (await myTasks(U.emp2)).find((x) => x.id === lateIds.find((y) => y.member_id === mEmp2).id).asg.project === PJ2, r.data);
r = await call(U.mgr, 'PATCH', `/api/assign/${mEmp2}/${lateIds.find((x) => x.member_id === mEmp2).id}`, { project: null });
ok('move: task leaves its project', r.status === 200 && !(await myTasks(U.emp2)).find((x) => x.id === lateIds.find((y) => y.member_id === mEmp2).id).asg.project, r.data);
r = await call(U.mgr, 'PATCH', `/api/projects/${PJ2}`, { status: 'archived' });
ok('archive: owner archives (no delete route exists)', r.status === 200);
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: 'في مؤرشف', project: PJ2 });
ok('archive: cannot assign into archived project', r.status === 400, r.data);
r = await call(U.mgr, 'GET', '/api/projects');
ok('list: archived hidden by default', !r.data.projects.some((p) => p.id === PJ2), r.data.projects.map((p) => p.name));
r = await call(U.mgr, 'GET', '/api/projects?status=archived');
ok('list: archived reachable and restorable', r.data.projects.some((p) => p.id === PJ2));
r = await call(U.mgr, 'PATCH', `/api/projects/${PJ2}`, { status: 'active' });
ok('archive: restore works', r.status === 200 && (await call(U.mgr, 'GET', '/api/projects')).data.projects.some((p) => p.id === PJ2));
ok('no delete route', (await call(U.gm, 'DELETE', `/api/projects/${PJ2}`)).status >= 400);

/* ───── تصدير ومدخلات خبيثة ───── */
r = await call(U.gm, 'GET', '/api/export.csv?type=tasks');
ok('export: tasks CSV has a project column with the name', String(r.data).split('\n')[0].includes('المشروع') && String(r.data).includes('جرد 2026'), String(r.data).slice(0, 200));
r = await call(U.mgr, 'POST', '/api/projects', { name: '=HYPERLINK("http://x")' + 'x'.repeat(200), descr: '<img src=x onerror=1>' });
ok('input: long name clipped, markup stored as plain text', r.status === 200 && (await call(U.mgr, 'GET', '/api/projects')).data.projects.every((p) => p.name.length <= 80));
r = await call(U.mgr, 'GET', "/api/projects/' OR 1=1 --");
ok('input: id with SQL metacharacters is just not found', r.status === 404 || r.status === 400, r.status);
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: 'x', project: { $ne: 1 } });
ok('input: non-string project id refused', r.status === 400, r.data);

console.log(`\n${pass} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
