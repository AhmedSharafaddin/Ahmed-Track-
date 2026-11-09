// اختبار حقن XSS في متصفح حقيقي: نضع حمولات خبيثة في كل حقل يكتبه المستخدم (أسماء الجهة والإدارات والأقسام والموظفين،
// المسمى والواجبات، عنوان المهمة ووصفها والتعليقات، المهام الشخصية والأهداف والمجالات، اسم الـWebhook)،
// ثم نفتح كل الشاشات بحسابات المدير والموظف والمسؤول، ونتأكد أن أي شيفرة لم تُنفَّذ ولا عنصر غريب دخل الصفحة.
//   [PW=/path/to/playwright] node itrack/tests/xss.e2e.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const path = require('path');
const PORT = 8800 + Math.floor(Math.random() * 90);
const ORIGIN = `http://localhost:${PORT}`; const BASE = `${ORIGIN}/itrack/`;
const srv = require('child_process').spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => srv.kill());
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const api = async (tok, method, p, body, org) => {
  const r = await fetch(ORIGIN + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(org ? { 'x-org': org } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
// حمولات: كسر خاصية، وسم صورة بحدث، وسم SVG، وسكربت، وكسر نص داخل JS، ورابط javascript:
const P1 = '"><img src=x onerror="window.__xss=(window.__xss||0)+1">';
const P2 = "<svg onload=\"window.__xss=(window.__xss||0)+1\"></svg><script>window.__xss=(window.__xss||0)+1</script>";
const P3 = "';window.__xss=(window.__xss||0)+1;//";
const P4 = '" onfocus="window.__xss=(window.__xss||0)+1" autofocus x="';
const ALL = P1 + P2 + P3 + P4;
const T = new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10);

async function page(b, ses, org, vp = { width: 1366, height: 900 }) {
  const ctx = await b.newContext({ viewport: vp });
  await ctx.addInitScript(([s, o]) => { try { localStorage.setItem('it:session', JSON.stringify(s)); localStorage.setItem('it:org', JSON.stringify(o)); } catch {} }, [ses, org]);
  const p = await ctx.newPage(); p.dialogs = 0;
  p.on('dialog', (d) => { p.dialogs++; d.dismiss().catch(() => {}); });
  return p;
}
const verdict = (p) => p.evaluate(() => ({
  x: window.__xss || 0,
  img: document.querySelectorAll('img[src="x"]').length,
  svg: document.querySelectorAll('svg[onload]').length,
  evh: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name) && /__xss/.test(a.value))).length,
  inj: document.querySelectorAll('script:not([src])').length,
}));

(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const g = await api(null, 'POST', '/api/auth/signup', { email: 'gm@x.test', password: 'Passw0rd!' });
  const ORG = (await api(g.token, 'POST', '/api/orgs', { name: P1 + ' شركة', my_name: P2 + ' مدير' })).id;
  await api(g.token, 'PUT', '/api/settings', { weekend: [], feat: { ics: true, webhooks: true, comments: true, photos: true }, hooks: [{ name: P1, url: 'https://example.com/hook', events: [], on: true }] }, ORG);
  const dep = (await api(g.token, 'POST', '/api/departments', { name: P1 + ' إدارة' }, ORG)).id;
  await api(g.token, 'POST', '/api/sections', { name: P4 + ' قسم', department_id: dep }, ORG);
  const pos = (await api(g.token, 'POST', '/api/positions', { title: P2 + ' مسمى', department_id: dep, responsibilities: [{ title: P1 + ' واجب', freq: 'daily', prio: 2, est: 20 }, { title: P4 + ' واجب٢', freq: 'weekly', prio: 3, est: 40 }] }, ORG)).id;
  const boot = await api(g.token, 'GET', '/api/bootstrap', null, ORG);
  const inv = (email, name, role, manager_id, position_id = null) => api(g.token, 'POST', '/api/members', { email, name, role, manager_id, department_id: dep, position_id }, ORG);
  const mi = await inv('mgr@x.test', P1 + ' مدير', 'manager', boot.me.id);
  const ei = await inv('emp@x.test', P2 + P4 + ' موظف', 'employee', mi.id, pos);
  const red = async (email, code) => { const r = await api(null, 'POST', '/api/auth/code', { email, code, password: 'Passw0rd!' }); return { token: r.token, uid: r.user.uid, email }; };
  const M = await red('mgr@x.test', mi.code); const E = await red('emp@x.test', ei.code);
  const G = { token: g.token, uid: g.user.uid, email: 'gm@x.test' };

  // مهمة مسندة بحمولات + تعليق + مهام شخصية + هدف + مجال
  const as = await api(M.token, 'POST', '/api/assign', { to: [ei.id], title: ALL, desc: ALL, due: T, prio: 3 }, ORG);
  await api(M.token, 'POST', '/api/remind', { members: [ei.id] }, ORG); // نص التذكير يحمل اسم المدير (حمولة) ويُعرض عند الموظف
  const tid = as.ids?.[0]?.id; // العنوان يُقصّ في الخادم، فنأخذ المعرّف من ردّ الإسناد
  ok('setup: assigned task with payload title exists', !!tid, as);
  await api(E.token, 'POST', `/api/task/me/${tid}/comments`, { body: ALL }, ORG);
  await api(E.token, 'POST', '/api/p', { ops: [
    { op: 'set', col: 'areas', id: 'ar1', data: { name: ALL, color: '#336699', order: 1 } },
    { op: 'set', col: 'goals', id: 'g1', data: { title: ALL, level: 'long', status: 'active', why: ALL } },
    { op: 'set', col: 'tasks', id: 'p1', data: { title: ALL, notes: ALL, due: T, areaId: 'ar1', goalId: 'g1', status: 'open', q: 3, tags: [P1], steps: [{ id: 's1', title: ALL, done: false }], nextStep: ALL, assignee: ALL, place: ALL } },
    { op: 'set', col: 'reviews', id: '_settings', data: { values: [ALL, P1] } },
  ] }, ORG);
  await api(E.token, 'PUT', `/api/report/${T}`, { today: ALL, items: [], blockers: ALL }, ORG).catch(() => {});

  const b = await chromium.launch();
  // عنصر ضبط: نحقن الحمولة عمدًا عبر innerHTML ونتأكد أن الكاشف يلتقطها، وإلا فكل نجاح أدناه بلا معنى
  { const c = await page(b, G, ORG); await c.goto(BASE + '#/team'); await c.waitForTimeout(600);
    await c.evaluate((h) => { document.body.insertAdjacentHTML('beforeend', h); }, P1 + P2);
    await c.waitForTimeout(400); const cv = await verdict(c);
    ok('عنصر الضبط: الكاشف يلتقط حقنًا متعمدًا (وإلا الاختبار أعمى)', cv.x > 0 && cv.img > 0, cv); }
  const itRoutes = ['#/day', '#/team', '#/track/today', '#/track', '#/track/tasks', '#/track/board', '#/track/new', '#/track/ops', '#/org', '#/org/members', '#/org/departments', '#/audit', '#/settings'];
  const myRoutes = ['#/today', '#/list/work', '#/dashboard', '#/all', '#/all/late', '#/matrix', '#/goals', '#/settings', '#/review', '#/week', '#/upcoming', '#/inbox'];
  const roles = [['المسؤول', G, true], ['المدير', M, true], ['الموظف', E, true]];
  for (const [label, ses, my] of roles) {
    const p = await page(b, ses, ORG);
    const bad = [];
    for (const r of itRoutes) {
      await p.goto(BASE + r); await p.waitForTimeout(700);
      const v = await verdict(p); if (v.x || v.img || v.svg || v.evh || p.dialogs) bad.push([r, v, p.dialogs]);
    }
    ok(`ITrack ${label}: لا تنفيذ لشيفرة في ${itRoutes.length} شاشة`, bad.length === 0, bad);
    if (my) {
      const q = await page(b, ses, ORG); const bad2 = [];
      for (const r of myRoutes) {
        await q.goto(ORIGIN + '/Ahmed-Track-/itrack/my/' + r); await q.waitForTimeout(900);
        const v = await verdict(q); if (v.x || v.img || v.svg || v.evh || q.dialogs) bad2.push([r, v, q.dialogs]);
      }
      ok(`مهامي ${label}: لا تنفيذ لشيفرة في ${myRoutes.length} شاشة`, bad2.length === 0, bad2);
    }
  }
  // تفاصيل المهمة المسندة (المدير والموظف) وفتح لوحة المهمة الشخصية
  const m = await page(b, M, ORG);
  await m.goto(BASE + `#/track/t/${E.uid}/${tid}`); await m.waitForTimeout(1200);
  let v = await verdict(m); ok('تفاصيل المهمة (المدير) بما فيها النقاش: لا تنفيذ', !v.x && !v.img && !v.svg && !v.evh && !m.dialogs, v);
  const e = await page(b, E, ORG, { width: 390, height: 844 });
  await e.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/list/work'); await e.waitForTimeout(1200);
  for (const sel of ['li.t.work [data-act=open]', 'li.t [data-act=open]']) { const h = await e.$(sel); if (h) { await h.click().catch(() => {}); await e.waitForTimeout(700); } }
  v = await verdict(e); ok('لوحة المهمة (الموظف، جوال) بما فيها التعليقات والخطوات: لا تنفيذ', !v.x && !v.img && !v.svg && !v.evh && !e.dialogs, v);
  // اللوحة تعرض النص حرفيًا (لا تُفسَّر الوسوم)
  const shown = await e.evaluate(() => document.body.innerText.includes('<img src=x'));
  ok('الحمولة تظهر نصًا حرفيًا ولا تُفسَّر', shown);
  await b.close();
  console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
