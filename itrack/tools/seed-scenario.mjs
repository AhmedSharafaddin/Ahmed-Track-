// سيناريو العرض اليومي: موظفان بتوصيف وظيفي (من بنود النموذج الرسمي)، ومدير يُسند مهام إضافية، وإنجاز جزئي ⇒ لوحة المتابعة تُظهر نسبًا حقيقية الحساب.
//   node itrack/tools/seed-scenario.mjs http://localhost:8080
// • كل الأسماء والبنود تجريبية وموسومة [مثال]؛ حالة الإنجاز محاكاة لتوضيح الشاشات وليست بيانات حقيقية.
// • يمرّ كل شيء عبر الواجهات البرمجية نفسها التي يستخدمها التطبيق (لا كتابة مباشرة في القاعدة).
const base = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const PASS = 'Demo-Pass-2026';
const call = async (m, p, b, tok, org) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(org ? { 'x-org': org } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${d.error || ''} ${d.message || ''}`); return d;
};
const day = (n) => new Date(Date.now() + 180 * 60000 + n * 864e5).toISOString().slice(0, 10);
const gm = await call('POST', '/api/auth/signup', { email: 'gm@scenario.test', password: PASS }).catch(() => call('POST', '/api/auth/login', { email: 'gm@scenario.test', password: PASS }));
const { id: org } = await call('POST', '/api/orgs', { name: 'شركة العرض [مثال]', my_name: 'المدير العام [مثال]' }, gm.token);
const G = (m, p, b) => call(m, p, b, gm.token, org);
await G('PUT', '/api/settings', { weekend: [] }); // أيام العمل كل الأسبوع حتى لا يتأثر العرض بيوم التشغيل
const dep = (await G('POST', '/api/departments', { name: 'المخازن' })).id;
const pos = (await G('POST', '/api/positions', { title: 'أمين مستودع', department_id: dep, summary: 'ضمان دقة المخزون وسلامة حركة البضائع.', responsibilities: [
  { title: 'استلام الشحنات ومطابقتها مع أوامر الشراء', detail: 'مطابقة الكميات والأصناف', freq: 'daily', prio: 3, est: 30 },
  { title: 'تسجيل حركة الصرف والإدخال في النظام', detail: 'كل حركة اليوم مسجّلة', freq: 'daily', prio: 2, est: 45 },
  { title: 'جرد عينة من الأصناف', detail: 'عينة ١٠ أصناف على الأقل', freq: 'weekly', prio: 2, est: 60 },
  { title: 'إعداد تقرير الأصناف الراكدة', detail: 'مرفوع قبل اجتماع الأحد', freq: 'weekly', prio: 1, est: 90 },
  { title: 'إغلاق الجرد الشهري ورفعه للإدارة', detail: 'معتمد قبل اليوم الخامس', freq: 'monthly', prio: 3, est: 120 }] })).id;
const me = (await G('GET', '/api/bootstrap')).me.id;
const mgr = await G('POST', '/api/members', { email: 'mgr@scenario.test', name: 'مدير المخازن [مثال]', role: 'manager', manager_id: me, department_id: dep });
const E = [];
for (const [i, n] of ['موظف أول [مثال]', 'موظف ثانٍ [مثال]', 'موظف ثالث [مثال]'].entries()) E.push(await G('POST', '/api/members', { email: `e${i + 1}@scenario.test`, name: n, role: 'employee', manager_id: mgr.id, department_id: dep, position_id: pos }));
const join = async (email, code) => (await call('POST', '/api/auth/code', { email, code, password: PASS })).token;
const tok = { mgr: await join('mgr@scenario.test', mgr.code), e: await Promise.all(E.map((e, i) => join(`e${i + 1}@scenario.test`, e.code))) };
const M = (m, p, b) => call(m, p, b, tok.mgr, org);
const tasks = async (t) => (await call('GET', '/api/p/tasks', null, t, org)).docs;
const patch = (t, id, data) => call('POST', '/api/p', { ops: [{ op: 'patch', col: 'tasks', id, data }] }, t, org);
const PJ = (await M('POST', '/api/projects', { name: 'جرد نهاية العام [مثال]', descr: 'جرد كل الأصناف وتسوية الفروقات قبل إغلاق السنة.', due: day(14) })).id;
const A = async (to, title, o = {}) => (await M('POST', '/api/assign', { to: [to], title, prio: 2, ...o })).ids[0].id;
// المدير يسند مهام إضافية (بعضها متأخر، بعضها يحتاج اعتمادًا)
const plan = [
  [0, [['جرد الرف أ', { due: day(-2), prio: 3, project: PJ, est: 60, review: true }, 'done'], ['جرد الرف ب', { due: day(1), prio: 3, project: PJ, est: 60, review: true }, 'done-pending'], ['تسوية فروقات الجرد', { due: day(3), prio: 2, project: PJ, est: 90 }, 'blocked'], ['تجهيز طلبية طارئة', { due: day(-1), prio: 3 }, 'late'], ['تحديث بطاقات الأصناف', { due: day(6), prio: 1 }, 'open']]],
  [1, [['جرد الرف ج', { due: day(2), prio: 3, project: PJ, est: 60, review: true }, 'done'], ['مطابقة وارد المورد الجديد', { due: day(0), prio: 2 }, 'done'], ['ترتيب منطقة الاستلام', { due: day(5), prio: 1 }, 'open']]],
  [2, [['جرد الرف د', { due: day(2), prio: 3, project: PJ, est: 60, review: true }, 'open'], ['إعداد قائمة الأصناف الراكدة', { due: day(4), prio: 2 }, 'open']]],
];
const rpt = { done: 'أنجزت وطابقت الرصيد مع النظام.', 'done-pending': 'اكتمل الجرد، الفرق قطعتان.' };
for (const [ei, list] of plan) for (const [title, o, st] of list) {
  const id = await A(E[ei].id, title, o);
  if (st === 'done' || st === 'done-pending') await patch(tok.e[ei], id, { status: 'done', completedAt: new Date().toISOString(), rpt: rpt[st] });
  if (st === 'blocked') await patch(tok.e[ei], id, { blocked: 'بانتظار كشف الفروقات من المحاسبة' });
  if (st === 'done') { const t = (await tasks(tok.e[ei])).find((x) => x.id === id); if (t?.asg?.review) await M('POST', `/api/assign/${E[ei].id}/${id}/review`, { action: 'approve', note: 'معتمد' }); }
}
// الواجبات الدورية المولَّدة من التوصيف: ينجز كل موظف نسبة مختلفة (محاكاة)
const todo = [2, 1, 0];
for (const [ei] of E.entries()) {
  const duties = (await tasks(tok.e[ei])).filter((d) => d.asg?.kind === 'duty' && d.due === day(0));
  for (const d of duties.slice(0, todo[ei])) await patch(tok.e[ei], d.id, { status: 'done', completedAt: new Date().toISOString() });
}
// التقرير اليومي: الأول والثاني يرفعان، والثالث لا (ليظهر «لم يرفع» في المتابعة)
const T0 = day(0);
const items = [[{ text: 'استلام شحنة المورد وتسجيلها', minutes: 40, state: 'done' }, { text: 'جرد الرف ب', minutes: 75, state: 'done' }, { text: 'تسوية فروقات الجرد', minutes: 30, state: 'blocked', blocker: 'بانتظار كشف الفروقات من المحاسبة' }], [{ text: 'مطابقة وارد المورد الجديد', minutes: 50, state: 'done' }, { text: 'جرد الرف ج', minutes: 60, state: 'done' }]];
for (const ei of [0, 1]) { await call('PUT', `/api/report/${T0}`, { today: T0, items: items[ei] }, tok.e[ei], org); await call('POST', `/api/report/${T0}/submit`, { today: T0 }, tok.e[ei], org); }
console.log(`org=${org} — دخول: gm@scenario.test (مدير عام) · mgr@scenario.test (مدير) · e1@scenario.test (موظف) كلمة المرور ${PASS}`);
