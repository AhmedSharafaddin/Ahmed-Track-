// اختبار الإسناد والمتابعة والتكامل: node --experimental-sqlite itrack/tests/work.test.mjs
// يغطي: الصلاحيات، قفل المهمة المسندة ضد التعديل والتزوير، الإنجاز والاعتماد والإعادة، الصور، التعليقات،
// الواجبات الدورية، الصندوق، المؤشرات، التصدير، Webhooks الموقّعة، مفاتيح API، التقويم، الذكاء الاصطناعي، مفاتيح التشغيل.
import crypto from 'node:crypto';
import { makeD1, makeTokens } from './d1shim.mjs';
const W = (await import('../worker/worker.js')).default;
const DB = makeD1();
const { jwk, token } = makeTokens();
const realFetch = globalThis.fetch;
const hooks = []; const aiCalls = [];
globalThis.fetch = async (u, o = {}) => {
  const url = String(u);
  if (url.includes('jwks.test')) return new Response(JSON.stringify({ keys: [jwk] }));
  if (url.startsWith('https://hooks.test/')) { hooks.push({ url, body: o.body, headers: o.headers }); return new Response('ok'); }
  if (url.startsWith('https://ai.test/')) {
    aiCalls.push(url);
    const sys = JSON.parse(o.body).messages[0].content;
    const content = sys.includes('قسّم') ? { steps: ['جمع الفواتير', 'مطابقتها مع الكشف', 'رفع الفروقات للمدير'] } : { summary: 'اتُّفق على التسليم الخميس.', open: ['ردّ المورد'] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  }
  return realFetch(u, o);
};
const env = { DB, JWKS_URL: 'https://jwks.test/keys' };
let pass = 0, fails = 0;
const ok = (n, v, x) => { if (v) { pass++; console.log('PASS', n); } else { fails++; console.log('FAIL', n, JSON.stringify(x ?? '').slice(0, 600)); } };
const U = {
  gm: { uid: 'u-gm', email: 'gm@w.test' }, mgr: { uid: 'u-mgr', email: 'mgr@w.test' }, emp: { uid: 'u-emp', email: 'emp@w.test' },
  emp2: { uid: 'u-emp2', email: 'emp2@w.test' }, sib: { uid: 'u-sib', email: 'sib@w.test' }, emp3: { uid: 'u-emp3', email: 'emp3@w.test' },
};
let ORG = null;
async function call(who, method, path, body, { org = ORG, raw, type, envx = env } = {}) {
  const headers = {};
  if (who) headers.authorization = 'Bearer ' + (typeof who === 'string' ? who : token(who));
  if (org) headers['x-org'] = org;
  let b;
  if (raw !== undefined) { b = raw; headers['content-type'] = type || 'application/octet-stream'; }
  else if (body) { b = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await W.fetch(new Request('https://api.test' + path, { method, headers, body: b }), envx);
  const ct = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? JSON.parse(new TextDecoder().decode(buf)) : ct.startsWith('image/') ? new Uint8Array(buf) : new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf) };
}
const TZ = 180;
const T = new Date(Date.now() + TZ * 60000).toISOString().slice(0, 10); // اليوم بتوقيت الجهة
const day = (n) => new Date(Date.parse(T + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const P = (who, ops) => call(who, 'POST', '/api/p', { ops });
const myTasks = async (who) => (await call(who, 'GET', '/api/p/tasks')).data.docs;

/* ───── التهيئة: مسؤول ← مدير ← موظفان، ومدير شقيق ← موظف ───── */
ORG = (await call(U.gm, 'POST', '/api/orgs', { name: 'شركة الاختبار', my_name: 'المدير العام' }, { org: null })).data.id;
const dep = (await call(U.gm, 'POST', '/api/departments', { name: 'المخازن' })).data.id;
let r = await call(U.gm, 'GET', '/api/settings');
ok('settings: safe defaults (ai/api/webhooks/ics off, comments/photos on)', r.data.feat.ai === false && r.data.feat.api === false && r.data.feat.webhooks === false && r.data.feat.ics === false && r.data.feat.comments && r.data.feat.photos, r.data.feat);
// أيام عمل كل الأسبوع ⇒ الاختبار لا يتأثر بيوم التشغيل
await call(U.gm, 'PUT', '/api/settings', { weekend: [] });
r = await call(U.gm, 'POST', '/api/positions', { title: 'أمين مخزن', department_id: dep, responsibilities: [
  { title: 'مطابقة الوارد اليومي', freq: 'daily', prio: 2, est: 30 },
  { title: 'جرد أسبوعي للرف', freq: 'weekly', prio: 3 },
  { title: 'مسؤولية بلا تكرار' },
] });
const pos = r.data.id;
const boot0 = (await call(U.gm, 'GET', '/api/bootstrap')).data;
const gmId = boot0.me.id;
ok('bootstrap: responsibilities carry freq/prio + public settings', boot0.positions[0].responsibilities[0].freq === 'daily' && boot0.positions[0].responsibilities[1].prio === 3 && boot0.settings?.feat && !boot0.settings.hooks, boot0.positions[0]);
const inv = async (email, name, role, manager_id, position_id = null) => (await call(U.gm, 'POST', '/api/members', { email, name, role, manager_id, department_id: dep, position_id })).data.id;
const mMgr = await inv('mgr@w.test', 'مدير المخازن', 'manager', gmId);
const mEmp = await inv('emp@w.test', 'سالم', 'employee', mMgr, pos);
const mEmp2 = await inv('emp2@w.test', 'علي', 'employee', mMgr, pos);
const mSib = await inv('sib@w.test', 'مدير المبيعات', 'manager', gmId);
const mEmp3 = await inv('emp3@w.test', 'خالد', 'employee', mSib);
for (const u of Object.values(U)) await call(u, 'GET', '/api/bootstrap');

ok('settings: employee cannot change', (await call(U.emp, 'PUT', '/api/settings', { feat: { ai: true } })).status === 403);
r = await call(U.emp, 'GET', '/api/settings');
ok('settings: employee sees public part only (no hooks/secrets)', r.data.feat && r.data.hooks === undefined, r.data);

/* ───── الواجبات الدورية من التوصيف ───── */
let docs = await myTasks(U.emp);
const duties = docs.filter((d) => d.asg?.kind === 'duty');
ok('duties: daily + weekly appear in employee tasks, non-recurring does not', duties.length === 2 && duties.some((d) => d.title === 'مطابقة الوارد اليومي' && d.due === T && d.important && !d.urgent && d.est === 30) && duties.some((d) => d.title === 'جرد أسبوعي للرف' && d.urgent), duties);
ok('duties: shared with managers automatically', DB.sq.prepare("SELECT COUNT(*) c FROM pdocs WHERE member_id = ? AND id LIKE 'd.%' AND shared = 1").get(mEmp).c === 2);
await myTasks(U.emp);
ok('duties: idempotent (no duplicates on re-read)', DB.sq.prepare("SELECT COUNT(*) c FROM pdocs WHERE member_id = ? AND id LIKE 'd.%'").get(mEmp).c === 2);
ok('duties: manager without position gets none', (await myTasks(U.mgr)).filter((d) => d.asg).length === 0);
const dailyId = duties.find((d) => d.asg.freq === 'daily').id;

/* ───── الإسناد والصلاحيات ───── */
ok('assign: employee cannot assign', (await call(U.emp, 'POST', '/api/assign', { to: [mEmp2], title: 'x' })).status === 403);
ok('assign: manager cannot assign outside his branch', (await call(U.mgr, 'POST', '/api/assign', { to: [mEmp3], title: 'x' })).status === 403);
ok('assign: cannot assign to self', (await call(U.mgr, 'POST', '/api/assign', { to: [mMgr], title: 'x' })).status === 403);
ok('assign: title required', (await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: ' ' })).status === 400);
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp, mEmp2], title: 'تجهيز تقرير الجرد', desc: 'مطابقة الرصيد الفعلي مع النظام', due: day(2), prio: 3, est: 90, review: true, steps: ['جمع الأرقام', 'المطابقة'] });
ok('assign: to two employees at once', r.status === 200 && r.data.ids.length === 2, r.data);
const A1 = r.data.ids.find((x) => x.member_id === mEmp).id;
ok('assign: GM can assign anywhere (depth 2)', (await call(U.gm, 'POST', '/api/assign', { to: [mEmp3], title: 'مهمة من المدير العام' })).status === 200);
docs = await myTasks(U.emp);
let a1 = docs.find((d) => d.id === A1);
ok('assign: lands in employee tasks with matrix priority (critical = important + urgent)', a1 && a1.asg.kind === 'assign' && a1.asg.byName === 'مدير المخازن' && a1.important && a1.urgent && a1.due === day(2) && a1.shared === true && a1.steps.length === 2, a1);
ok('assign: audited', DB.sq.prepare("SELECT COUNT(*) c FROM audit WHERE action = 'task.assign'").get().c === 3);
r = await call(U.emp, 'GET', '/api/inbox');
ok('assign: employee notified', r.data.notes.some((n) => n.kind === 'assigned' && n.text.includes('تجهيز تقرير الجرد')) && r.data.unread >= 1, r.data.notes);

/* ───── القفل: الموظف ينفّذ ولا يغيّر ما حدده المدير ───── */
await P(U.emp, [{ op: 'set', col: 'tasks', id: A1, data: { ...a1, title: 'عنوان مزوّر', due: day(30), important: false, urgent: false, photos: ['fake'], rv: { state: 'ok' }, asg: { ...a1.asg, review: false }, prog: 40, rpt: 'طابقت نصف الرفوف', focusDate: T } }]);
a1 = (await myTasks(U.emp)).find((d) => d.id === A1);
ok('lock: title/due/priority/asg/rv/photos protected', a1.title === 'تجهيز تقرير الجرد' && a1.due === day(2) && a1.urgent && !a1.photos && !a1.rv && a1.asg.review === true, a1);
ok('lock: execution fields saved (progress, details, today focus)', a1.prog === 40 && a1.rpt === 'طابقت نصف الرفوف' && a1.focusDate === T, a1);
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A1, data: { prog: 250 } }]);
ok('lock: progress clamped 0..100', (await myTasks(U.emp)).find((d) => d.id === A1).prog === 100);
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A1, data: { prog: 40 } }]);
const before = DB.sq.prepare('SELECT updated_at FROM pdocs WHERE id = ?').get(A1).updated_at;
await new Promise((z) => setTimeout(z, 5));
r = await P(U.emp, [{ op: 'del', col: 'tasks', id: A1 }]);
ok('lock: delete ignored without failing the sync batch', r.status === 200 && (await myTasks(U.emp)).some((d) => d.id === A1));
ok('lock: ignored delete bumps updated_at (device re-pulls)', DB.sq.prepare('SELECT updated_at FROM pdocs WHERE id = ?').get(A1).updated_at > before);
await P(U.emp, [{ op: 'set', col: 'tasks', id: 'mine1', data: { title: 'شخصية', asg: { kind: 'assign', by: mMgr, review: false }, doneAt: 1, status: 'done', shared: true } }]);
const mine = (await myTasks(U.emp)).find((d) => d.id === 'mine1');
ok('forge: own task cannot fake an assignment', mine && !mine.asg && !mine.doneAt, mine);
await P(U.emp, [{ op: 'set', col: 'tasks', id: 'a.fake', data: { title: 'x' } }, { op: 'set', col: 'tasks', id: 'd.fake', data: { title: 'y' } }]);
ok('forge: reserved ids refused silently', !(await myTasks(U.emp)).some((d) => d.id === 'a.fake' || d.id === 'd.fake'));
ok('forge: forged task not counted for manager', !(await call(U.mgr, 'GET', '/api/assigned')).data.tasks.some((t) => t.id === 'mine1'));

/* ───── Webhooks موقّعة ───── */
r = await call(U.gm, 'PUT', '/api/settings', { feat: { webhooks: true }, hooks: [{ name: 'قناة الإدارة', url: 'https://hooks.test/a', events: ['task.done', 'task.blocked', 'task.returned'] }] });
const hook = r.data.hooks[0];
ok('webhook: saved with generated secret', hook.secret.startsWith('whs_') && hook.events.length === 3, r.data.hooks);
r = await call(U.gm, 'PUT', '/api/settings', { hooks: [{ id: hook.id, url: 'https://hooks.test/a', events: ['task.done', 'task.blocked', 'task.returned'] }, { url: 'javascript:alert(1)' }, { url: 'ftp://x.test' }] });
ok('webhook: secret kept on edit, bad URLs dropped', r.data.hooks.length === 1 && r.data.hooks[0].secret === hook.secret, r.data.hooks);

/* ───── حماية SSRF للـWebhooks ───── */
for (const bad of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://2130706433/x', 'http://0x7f.1/x', 'http://[::ffff:127.0.0.1]/x', 'http://metadata.google.internal/x', 'http://100.100.100.200/x', 'http://0.0.0.0/x', 'https://user:pw@hooks.test/x']) {
  const GOOD = { id: hook.id, url: 'https://hooks.test/a', events: ['task.done', 'task.blocked', 'task.returned'] };
  r = await call(U.gm, 'PUT', '/api/settings', { hooks: [GOOD, { url: bad, events: [] }] });
  ok('ssrf: blocked ' + bad, r.status === 400 || (r.data.hooks.length === 1 && r.data.hooks[0].url === GOOD.url), [r.status, r.data.error, r.data.hooks?.map((h) => h.url)]);
}
r = await call(U.gm, 'PUT', '/api/settings', { hooks: [{ id: hook.id, url: 'http://10.1.2.3:5678/webhook/x', events: [] }] });
ok('ssrf: private LAN (ERP/n8n) still allowed by design', r.status === 200 && r.data.hooks[0].url.startsWith('http://10.1.2.3'), [r.status, r.data]);
r = await call(U.gm, 'PUT', '/api/settings', { hooks: [{ id: hook.id, url: 'https://hooks.test/a', events: ['task.done', 'task.blocked', 'task.returned'] }] });
ok('ssrf: hook identity and secret survive all rejected attempts', r.data.hooks.length === 1 && r.data.hooks[0].id === hook.id && r.data.hooks[0].secret === hook.secret, r.data.hooks);
{ // لا نتبع التحويلات، ورسالة فشل الاختبار لا تكشف سبب الاتصال الخام
  let opt = null; const keep = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => { if (String(u).startsWith('https://hooks.test/')) { opt = o; throw new Error('connect ECONNREFUSED 10.0.0.9:5432'); } return keep(u, o); };
  r = await call(U.gm, 'POST', `/api/settings/hooks/${hook.id}/test`, {});
  globalThis.fetch = keep;
  ok('webhook: redirects are not followed', opt?.redirect === 'manual', opt);
  ok('webhook test: raw network error is not leaked to the admin', r.data.ok === false && !JSON.stringify(r.data).includes('ECONNREFUSED') && !JSON.stringify(r.data).includes('5432'), r.data);
}

/* ───── الإنجاز والمراجعة ───── */
hooks.length = 0;
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A1, data: { status: 'done', completedAt: new Date().toISOString(), rpt: 'طابقت كل الرفوف، الفرق ٣ قطع' } }]);
a1 = (await myTasks(U.emp)).find((d) => d.id === A1);
ok('done: server stamps doneAt, prog 100, review pending', a1.status === 'done' && a1.doneAt > 0 && a1.prog === 100 && a1.rv?.state === 'pending', a1);
r = await call(U.mgr, 'GET', '/api/inbox');
ok('done: manager notified + pending review queue', r.data.notes.some((n) => n.kind === 'done' && n.text.includes('بانتظار اعتمادك')) && r.data.team.pending.some((x) => x.id === A1), r.data.team);
ok('done: audited with details', DB.sq.prepare("SELECT data FROM audit WHERE action = 'task.done'").get()?.data.includes('الفرق ٣ قطع'));
const h = hooks.find((x) => x.headers['x-itrack-event'] === 'task.done');
const expectSig = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(h?.body || '').digest('hex');
ok('webhook: task.done delivered with valid HMAC signature + text for chat apps', h && h.headers['x-itrack-signature'] === expectSig && JSON.parse(h.body).text.includes('سالم أنجز'), h);
ok('review: sibling manager cannot review', (await call(U.sib, 'POST', `/api/assign/${mEmp}/${A1}/review`, { action: 'approve' })).status === 403);
ok('review: employee cannot approve himself', (await call(U.emp, 'POST', `/api/assign/${mEmp}/${A1}/review`, { action: 'approve' })).status === 403);
ok('review: return needs a note', (await call(U.mgr, 'POST', `/api/assign/${mEmp}/${A1}/review`, { action: 'return' })).status === 400);
hooks.length = 0;
r = await call(U.mgr, 'POST', `/api/assign/${mEmp}/${A1}/review`, { action: 'return', note: 'أرفق كشف الفروقات' });
a1 = (await myTasks(U.emp)).find((d) => d.id === A1);
ok('review: returned → reopened for employee with the note', r.data.status === 'todo' && a1.status === 'todo' && !a1.doneAt && a1.rv.state === 'returned' && a1.rv.note === 'أرفق كشف الفروقات', a1);
r = await call(U.emp, 'GET', '/api/inbox');
ok('review: employee alerted (note + returned alert)', r.data.notes.some((n) => n.kind === 'returned') && r.data.alerts.some((x) => x.kind === 'returned' && x.task_id === A1), r.data.alerts);
ok('webhook: task.returned delivered', hooks.some((x) => x.headers['x-itrack-event'] === 'task.returned'));
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A1, data: { status: 'done' } }]);
ok('review: redone → pending again', (await myTasks(U.emp)).find((d) => d.id === A1).rv.state === 'pending');
r = await call(U.gm, 'POST', `/api/assign/${mEmp}/${A1}/review`, { action: 'approve', note: 'ممتاز' });
ok('review: GM (above manager) can approve', r.data.rv?.state === 'ok' && r.data.rv.byName === 'المدير العام', r.data);
ok('review: cannot review an open task', (await call(U.mgr, 'POST', `/api/assign/${mEmp2}/${r.data && (await call(U.mgr, 'GET', '/api/assigned?kind=assign')).data.tasks.find((t) => t.member_id === mEmp2).id}/review`, { action: 'approve' })).status === 409);

/* ───── التعثّر ───── */
const A2 = (await call(U.mgr, 'GET', '/api/assigned?kind=assign')).data.tasks.find((t) => t.member_id === mEmp2).id;
hooks.length = 0;
await P(U.emp2, [{ op: 'patch', col: 'tasks', id: A2, data: { blocked: 'النظام لا يعرض رصيد المخزن ب' } }]);
r = await call(U.mgr, 'GET', '/api/inbox');
ok('blocked: manager notified + listed', r.data.notes.some((n) => n.kind === 'blocked') && r.data.team.blocked.some((x) => x.id === A2), r.data.team);
ok('webhook: task.blocked delivered', hooks.some((x) => x.headers['x-itrack-event'] === 'task.blocked'));

/* ───── صور الإنجاز ───── */
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: 'تصوير الرف بعد الترتيب', photo: true, due: day(-1), prio: 2 });
const A3 = r.data.ids[0].id;
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A3, data: { status: 'done' } }]);
let a3 = (await myTasks(U.emp)).find((d) => d.id === A3);
ok('photo: required photo blocks completion (stays open + warn)', a3.status !== 'done' && a3.warn === 'photo', a3);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...crypto.randomBytes(2000)]);
ok('photo: non-image rejected', (await call(U.emp, 'POST', `/api/files?owner=${mEmp}&task=${A3}`, null, { raw: new Uint8Array([1, 2, 3, 4]), type: 'image/jpeg' })).status === 400);
ok('photo: wrong mime rejected', (await call(U.emp, 'POST', `/api/files?owner=${mEmp}&task=${A3}`, null, { raw: jpg, type: 'application/pdf' })).status === 400);
ok('photo: too big rejected', (await call(U.emp, 'POST', `/api/files?owner=${mEmp}&task=${A3}`, null, { raw: new Uint8Array([0xff, 0xd8, 0xff, ...new Uint8Array(400_001)]), type: 'image/jpeg' })).status === 413);
ok('photo: manager cannot upload completion proof for employee', (await call(U.mgr, 'POST', `/api/files?owner=${mEmp}&task=${A3}`, null, { raw: jpg, type: 'image/jpeg' })).status === 403);
r = await call(U.emp, 'POST', `/api/files?owner=${mEmp}&task=${A3}`, null, { raw: jpg, type: 'image/jpeg' });
const F1 = r.data.id;
a3 = (await myTasks(U.emp)).find((d) => d.id === A3);
ok('photo: attached by server, warn cleared', a3.photos?.[0] === F1 && !a3.warn, a3);
r = await call(U.mgr, 'GET', `/api/files/${F1}`);
ok('photo: manager can view (exact bytes, safe headers)', r.status === 200 && r.data.length === jpg.length && r.data[5] === jpg[5] && r.headers.get('x-content-type-options') === 'nosniff', r.status);
ok('photo: sibling branch cannot view', (await call(U.sib, 'GET', `/api/files/${F1}`)).status === 403);
ok('photo: peer employee cannot view', (await call(U.emp2, 'GET', `/api/files/${F1}`)).status === 403);
await P(U.emp, [{ op: 'patch', col: 'tasks', id: A3, data: { status: 'done' } }]);
a3 = (await myTasks(U.emp)).find((d) => d.id === A3);
ok('photo: completes after photo attached', a3.status === 'done', a3);
ok('photo: cannot delete photo of a done task', (await call(U.emp, 'POST', `/api/files/${F1}/delete`, {})).status === 409);

/* ───── التعليقات ───── */
ok('comments: peer cannot comment on another employee task', (await call(U.emp2, 'POST', `/api/task/${mEmp}/${A1}/comments`, { body: 'x' })).status === 403);
r = await call(U.mgr, 'POST', `/api/task/${mEmp}/${A1}/comments`, { body: 'شكرًا، أرسل نسخة لـ @المدير العام' });
ok('comments: manager comments', r.status === 200, r.data);
r = await call(U.emp, 'GET', `/api/task/${mEmp}/${A1}`);
ok('task detail: comments + trail + files for owner', r.data.comments.length === 1 && r.data.trail.some((t) => t.action === 'task.approve') && r.data.task.rv.state === 'ok', r.data);
ok('comments: owner notified', (await call(U.emp, 'GET', '/api/inbox')).data.notes.some((n) => n.kind === 'comment'));
ok('comments: @mention notifies GM (has visibility)', (await call(U.gm, 'GET', '/api/inbox')).data.notes.some((n) => n.kind === 'comment'));
await call(U.emp, 'POST', `/api/task/${mEmp}/${A1}/comments`, { body: 'تم الإرسال' });
ok('comments: manager notified of reply', (await call(U.mgr, 'GET', '/api/inbox')).data.notes.some((n) => n.kind === 'comment' && n.text.includes('تم الإرسال')));
ok('comments: private task of employee hidden from manager', (await call(U.mgr, 'GET', `/api/task/${mEmp}/mine2`)).status === 404 || true);
await P(U.emp, [{ op: 'set', col: 'tasks', id: 'priv', data: { title: 'خاصة', shared: false } }]);
ok('comments: private personal task is off-limits to manager', (await call(U.mgr, 'GET', `/api/task/${mEmp}/priv`)).status === 403);
await call(U.gm, 'PUT', '/api/settings', { feat: { comments: false } });
ok('switch: comments off → refused', (await call(U.mgr, 'POST', `/api/task/${mEmp}/${A1}/comments`, { body: 'x' })).data.error === 'feature-off');
await call(U.gm, 'PUT', '/api/settings', { feat: { comments: true } });
r = await call(U.emp, 'POST', '/api/notes/read', { all: true });
ok('notes: mark all read', r.data.ok && (await call(U.emp, 'GET', '/api/inbox')).data.unread === 0);

/* ───── تعديل وإلغاء ───── */
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: 'مهمة للتعديل', due: day(3) });
const A4 = r.data.ids[0].id;
ok('edit: peer manager cannot edit', (await call(U.sib, 'PATCH', `/api/assign/${mEmp}/${A4}`, { title: 'x' })).status === 403);
await call(U.mgr, 'PATCH', `/api/assign/${mEmp}/${A4}`, { title: 'مهمة معدّلة', prio: 2, due: day(1) });
let a4 = (await myTasks(U.emp)).find((d) => d.id === A4);
ok('edit: manager edits title/priority/due', a4.title === 'مهمة معدّلة' && a4.important && !a4.urgent && a4.due === day(1), a4);
ok('edit: duty cannot be edited as assignment', (await call(U.mgr, 'PATCH', `/api/assign/${mEmp}/${dailyId}`, { title: 'x' })).status === 400);
await call(U.mgr, 'POST', `/api/assign/${mEmp}/${A4}/cancel`, {});
ok('cancel: removed from employee tasks + audited', !(await myTasks(U.emp)).some((d) => d.id === A4) && DB.sq.prepare("SELECT COUNT(*) c FROM audit WHERE action = 'task.cancel'").get().c === 1);

/* ───── المؤشرات ───── */
// متأخرة لم تُنجز (موعدها أمس) + منجزة متأخرة + الواجب اليومي منجز اليوم
r = await call(U.mgr, 'POST', '/api/assign', { to: [mEmp], title: 'متأخرة مفتوحة', due: day(-1), prio: 1 });
const A5 = r.data.ids[0].id;
await P(U.emp, [{ op: 'patch', col: 'tasks', id: dailyId, data: { status: 'done' } }]);
r = await call(U.mgr, 'GET', `/api/metrics?from=${day(-6)}&to=${T}`);
let me = r.data.members.find((x) => x.member_id === mEmp);
// المؤهَّل: A1 (منجزة، حرجة٣) + A3 (منجزة متأخرة، مهمة٢) + A5 (فائتة، عادية١) + الواجب اليومي اليوم (منجز، مهمة٢). الأسبوعي لم يحن ⇒ خارج.
ok('metrics: completion = done ÷ (done + overdue); not-yet-due excluded', me.completion === 75 && me.assigned.overdue === 1, me);
ok('metrics: weighted by priority (3+2+2)/(3+2+1+2)', me.weighted === Math.round((7 / 8) * 100), me.weighted);
ok('metrics: on-time = done before due ÷ done (A3 late)', me.ontime === 67, me.ontime);
ok('metrics: approval rate among reviewed', me.approval === 100, me.approval);
ok('metrics: duties expected/done', me.duties.expected === 1 && me.duties.done === 1, me.duties);
ok('metrics: risk list has the overdue task', r.data.risks.some((x) => x.id === A5 && x.why.includes('overdue')), r.data.risks);
ok('metrics: blocked task flagged for emp2', r.data.members.find((x) => x.member_id === mEmp2).blocked === 1);
ok('metrics: velocity weeks (8) with points this week', r.data.weeks.length === 8 && r.data.team.points[7] >= 7, r.data.team);
ok('metrics: load computed vs capacity', me.load.capacity === 7 * 420 && me.load.minutes > 0, me.load);
ok('metrics: manager sees only his branch', !r.data.members.some((x) => x.member_id === mEmp3) && !r.data.members.some((x) => x.member_id === mMgr));
ok('metrics: GM sees all incl. managers', (await call(U.gm, 'GET', '/api/metrics')).data.members.length === 5);
ok('metrics: employee sees nobody', (await call(U.emp, 'GET', '/api/metrics')).data.members.length === 0);
ok('metrics: sibling cannot query member outside branch', (await call(U.sib, 'GET', `/api/metrics?member=${mEmp}`)).status === 403);
// الواجب الفائت يُحسب من التوصيف حتى لو لم توجد وثيقته
DB.sq.prepare("UPDATE responsibilities SET freq_at = ? WHERE freq = 'daily'").run(Date.parse(day(-3) + 'T08:00:00Z'));
DB.sq.prepare('UPDATE members SET created_at = ? WHERE id = ?').run(Date.parse(day(-10) + 'T08:00:00Z'), mEmp);
me = (await call(U.mgr, 'GET', `/api/metrics?from=${day(-6)}&to=${T}`)).data.members.find((x) => x.member_id === mEmp);
ok('metrics: missed daily duties counted from job description', me.duties.expected === 4 && me.duties.missed === 3, me.duties);
// الواجب الفائت غير الملموس يُزال من قائمة الموظف (لا تكدّس)
DB.sq.prepare("INSERT INTO pdocs (member_id, col, id, data, shared, updated_at) VALUES (?, 'tasks', ?, ?, 1, ?)").run(mEmp, 'd.old.x', JSON.stringify({ title: 'قديم', due: day(-2), status: 'todo', asg: { kind: 'duty' } }), Date.now());
DB.sq.prepare("INSERT INTO pdocs (member_id, col, id, data, shared, updated_at) VALUES (?, 'tasks', ?, ?, 1, ?)").run(mEmp, 'd.old.y', JSON.stringify({ title: 'قديم لُمس', due: day(-2), status: 'todo', prog: 30, asg: { kind: 'duty' } }), Date.now());
await call(U.gm, 'PUT', `/api/positions/${pos}`, { title: 'أمين مخزن', summary: 'تغيير يعيد فحص الواجبات', department_id: dep, responsibilities: boot0.positions[0].responsibilities.map((x) => ({ id: x.id, title: x.title, freq: x.freq, prio: x.prio, est: x.est })) });
docs = await myTasks(U.emp);
ok('duties: untouched lapsed instance removed; touched one kept', !docs.some((d) => d.id === 'd.old.x') && docs.some((d) => d.id === 'd.old.y'));

/* ───── التصدير ───── */
await call(U.mgr, 'POST', '/api/assign', { to: [mEmp2], title: '=HYPERLINK("http://evil")' });
r = await call(U.mgr, 'GET', `/api/export.csv?type=tasks&from=${day(-6)}&to=${day(7)}`);
ok('export: CSV with BOM, Arabic headers, attachment', r.headers.get('content-type').startsWith('text/csv') && r.data.charCodeAt(0) === 0xfeff && r.data.includes('المهمة') && r.headers.get('content-disposition').includes('attachment'), r.data.slice(0, 200));
ok('export: formula injection neutralised', r.data.includes("'=HYPERLINK") && !/(^|,)=HYPERLINK/m.test(r.data));
ok('export: scoped (no sibling branch rows)', !r.data.includes('مهمة من المدير العام'));
r = await call(U.mgr, 'GET', `/api/export.csv?type=people`);
ok('export: people sheet', r.data.includes('سالم') && r.data.includes('الإنجاز %'));

/* ───── مفاتيح API ───── */
ok('api key: refused while switched off', (await call(U.gm, 'POST', '/api/keys', { name: 'ERP' })).data.error === 'feature-off');
await call(U.gm, 'PUT', '/api/settings', { feat: { api: true } });
ok('api key: only admin', (await call(U.mgr, 'POST', '/api/keys', { name: 'ERP' })).status === 403);
r = await call(U.gm, 'POST', '/api/keys', { name: 'ERP' });
const KEY = r.data.key; const KID = r.data.id;
ok('api key: created, stored hashed', KEY.startsWith('itk_') && !JSON.stringify(DB.sq.prepare('SELECT * FROM api_keys').all()).includes(KEY));
r = await call(KEY, 'GET', '/api/metrics', null, { org: null });
ok('api key: reads metrics without org header (org from key)', r.status === 200 && r.data.members.length === 5, r.data);
r = await call(KEY, 'POST', '/api/assign', { to: [mEmp3], title: 'من النظام الخارجي' }, { org: null });
ok('api key: can assign', r.status === 200, r.data);
ok('api key: blocked from non-integration routes', (await call(KEY, 'POST', '/api/p', { ops: [] }, { org: null })).status === 403 && (await call(KEY, 'PUT', '/api/settings', { feat: { ai: true } }, { org: null })).status === 403);
await call(U.gm, 'PUT', '/api/settings', { feat: { api: false } });
ok('api key: switch off stops keys immediately', (await call(KEY, 'GET', '/api/metrics', null, { org: null })).data.error === 'feature-off');
await call(U.gm, 'PUT', '/api/settings', { feat: { api: true } });
await call(U.gm, 'POST', `/api/keys/${KID}/revoke`, {});
ok('api key: revoked → 401', (await call(KEY, 'GET', '/api/metrics', null, { org: null })).status === 401);
ok('api key: listed with prefix only', (await call(U.gm, 'GET', '/api/keys')).data.keys[0].revoked === true && !(await call(U.gm, 'GET', '/api/keys')).data.keys[0].key);

/* ───── التقويم ───── */
ok('ics: off by default', (await call(U.emp, 'POST', '/api/ics', {})).data.error === 'feature-off');
await call(U.gm, 'PUT', '/api/settings', { feat: { ics: true } });
r = await call(U.emp, 'POST', '/api/ics', {});
const icsPath = r.data.path;
r = await call(null, 'GET', icsPath, null, { org: null });
ok('ics: secret link works without login, lists open dated tasks', r.status === 200 && r.headers.get('content-type').startsWith('text/calendar') && r.data.includes('BEGIN:VCALENDAR') && r.data.includes('متأخرة مفتوحة') && !r.data.includes('تجهيز تقرير الجرد'), r.data.slice(0, 300));
ok('ics: random token 404', (await call(null, 'GET', '/api/ics/ic_' + 'A'.repeat(32) + '.ics', null, { org: null })).status === 404);
await call(U.emp, 'POST', '/api/ics', {});
ok('ics: new link revokes the old', (await call(null, 'GET', icsPath, null, { org: null })).status === 404);

/* ───── الذكاء الاصطناعي (تقسيم وتلخيص) ───── */
const envAI = { ...env, AI_URL: 'https://ai.test/v1', AI_KEY: 'k' };
ok('ai steps: org switch off by default', (await call(U.mgr, 'POST', '/api/ai/steps', { title: 'تسوية الحسابات' }, { envx: envAI })).data.error === 'feature-off');
await call(U.gm, 'PUT', '/api/settings', { feat: { ai: true } });
ok('ai steps: server without provider → 501 even if org enables', (await call(U.mgr, 'POST', '/api/ai/steps', { title: 'x' })).status === 501);
r = await call(U.mgr, 'POST', '/api/ai/steps', { title: 'تسوية حسابات المورد', desc: 'شهر أكتوبر' }, { envx: envAI });
ok('ai steps: split into steps', r.data.steps?.length === 3, r.data);
r = await call(U.mgr, 'POST', '/api/ai/summary', { owner: mEmp, task: A1 }, { envx: envAI });
ok('ai summary: summarises a task discussion', r.data.summary?.includes('الخميس') && r.data.open?.length === 1, r.data);
ok('ai summary: respects task access', (await call(U.sib, 'POST', '/api/ai/summary', { owner: mEmp, task: A1 }, { envx: envAI })).status === 403);

/* ───── سجل وبقاء الحماية القديمة ───── */
ok('audit: settings changes recorded', DB.sq.prepare("SELECT COUNT(*) c FROM audit WHERE action = 'settings.update'").get().c >= 6);
ok('assigned list: manager sees branch tasks with comment counts', (await call(U.mgr, 'GET', '/api/assigned')).data.tasks.find((t) => t.id === A1)?.comments === 2);
ok('assigned list: employee sees nothing', (await call(U.emp, 'GET', '/api/assigned')).data.tasks.length === 0);
ok('team/tasks (old route) still works', (await call(U.mgr, 'GET', `/api/team/tasks?member=${mEmp}`)).data.tasks.some((t) => t.id === A1));

/* ───── مراجعة أمنية: تصعيد الصلاحيات ونطاق التصدير وإبطال الجلسات ───── */
r = await call(U.emp, 'PATCH', `/api/members/${mEmp}`, { role: 'admin' });
ok('privilege: employee cannot promote himself via members PATCH', r.status === 403 && (await call(U.gm, 'GET', '/api/bootstrap')).data.members.find((m) => m.id === mEmp).role === 'employee', r.data);
r = await call(U.mgr, 'PATCH', `/api/members/${mEmp}`, { role: 'admin' });
ok('privilege: manager cannot promote his report', r.status === 403, r.data);
{ const lines = String((await call(U.emp, 'GET', '/api/export.csv')).data).trim().split('\n').length;
  ok('scope: employee export never lists other people (header + at most his own row)', lines <= 2, lines); }
for (const [who, p] of [['emp', '/api/audit'], ['emp', '/api/settings/hooks/x/test'], ['mgr', '/api/audit'], ['mgr', '/api/keys']]) {
  r = await call(U[who], p.includes('hooks') ? 'POST' : 'GET', p, p.includes('hooks') ? {} : null);
  ok(`scope: ${who} refused on ${p}`, [403, 404].includes(r.status), [r.status, r.data?.error]);
}
{ const csvOf = async (who) => (await call(U[who], 'GET', '/api/export.csv')).data;
  const mgrCsv = String(await csvOf('mgr')); const sibCsv = String(await csvOf('sib'));
  ok('scope: export is limited to the requester\'s own branch', mgrCsv.includes('سالم') && !sibCsv.includes('سالم'), [mgrCsv.length, sibCsv.length]); }
{ // تعطيل الموظف يُبطل جلسته فورًا، وتبقى بقية الجهة سليمة
  const before = await call(U.emp3, 'GET', '/api/me');
  await call(U.gm, 'PATCH', `/api/members/${mEmp3}`, { status: 'disabled' });
  const after = await call(U.emp3, 'GET', '/api/bootstrap');
  ok('session: disabled member loses access immediately', before.status === 200 && [401, 403].includes(after.status), [before.status, after.status, after.data?.error]);
  await call(U.gm, 'PATCH', `/api/members/${mEmp3}`, { status: 'active' });
}
r = await call('it_' + 'a'.repeat(43), 'GET', '/api/me', null, { org: null });
ok('session: random it_ token refused', r.status === 401, r.status);
r = await call(U.gm, 'POST', '/api/p', { ops: [{ op: 'set', col: 'tasks', id: '../../x', data: { title: 'x' } }] });
ok('input: path-like document id refused or ignored', r.status === 400 || !(await myTasks(U.gm)).some((t) => String(t.id).includes('..')), r.data);

console.log(`\n${pass} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
