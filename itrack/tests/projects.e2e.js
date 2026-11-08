// المشاريع في متصفح حقيقي: إنشاء، إسناد داخل مشروع، ظهور اسم المشروع عند الموظف، تعديل وإعادة تسمية، أرشفة،
// وصول (axe WCAG AA) على جوال وحاسوب، وحقن XSS في اسم المشروع ووصفه.
//   AXE=/path/axe.min.js [PW=...] [CHROME=...] node itrack/tests/projects.e2e.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const AX = fs.readFileSync(process.env.AXE, 'utf8');
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
const P1 = '"><img src=x onerror="window.__xss=(window.__xss||0)+1">';
const P2 = '<svg onload="window.__xss=(window.__xss||0)+1"></svg><script>window.__xss=(window.__xss||0)+1</script>';

async function page(b, ses, org, vp = { width: 1366, height: 900 }) {
  const ctx = await b.newContext({ viewport: vp });
  await ctx.addInitScript(([s, o]) => { try { localStorage.setItem('it:session', JSON.stringify(s)); localStorage.setItem('it:org', JSON.stringify(o)); } catch {} }, [ses, org]);
  const p = await ctx.newPage(); p.errs = []; p.dialogs = 0;
  p.on('dialog', (d) => { p.dialogs++; d.dismiss().catch(() => {}); });
  p.on('pageerror', (e) => p.errs.push(e.message));
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) p.errs.push('API ' + r.status() + ' ' + r.url()); });
  return p;
}
const axe = async (p, name) => {
  await p.addScriptTag({ content: AX });
  const v = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((x) => [x.id, x.nodes.length, x.nodes[0].target.join(' ')]));
  ok(`axe AA: ${name}`, v.length === 0, v);
};
const verdict = (p) => p.evaluate(() => ({
  x: window.__xss || 0, img: document.querySelectorAll('img[src="x"]').length, svg: document.querySelectorAll('svg[onload]').length,
  inj: document.querySelectorAll('script:not([src])').length, over: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
}));
const body = (p) => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const g = await api(null, 'POST', '/api/auth/signup', { email: 'gm@x.test', password: 'Passw0rd!' });
  const ORG = (await api(g.token, 'POST', '/api/orgs', { name: 'جهة الاختبار', my_name: 'المدير العام' })).id;
  await api(g.token, 'PUT', '/api/settings', { weekend: [] }, ORG);
  const dep = (await api(g.token, 'POST', '/api/departments', { name: 'إدارة الاختبار' }, ORG)).id;
  const boot = await api(g.token, 'GET', '/api/bootstrap', null, ORG);
  const inv = (email, name, role, manager_id) => api(g.token, 'POST', '/api/members', { email, name, role, manager_id, department_id: dep }, ORG);
  const mi = await inv('mgr@x.test', 'سالم المدير', 'manager', boot.me.id);
  const ei = await inv('emp@x.test', 'علي الموظف', 'employee', mi.id);
  const red = async (email, code) => { const r = await api(null, 'POST', '/api/auth/code', { email, code, password: 'Passw0rd!' }); return { token: r.token, uid: r.user.uid, email }; };
  const M = await red('mgr@x.test', mi.code); const E = await red('emp@x.test', ei.code);
  const G = { token: g.token, uid: g.user.uid, email: 'gm@x.test' };

  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });

  // ١) المدير: قائمة فارغة ثم إنشاء مشروع من الواجهة
  const m = await page(b, M, ORG);
  await m.goto(BASE + '#/track/p'); await m.waitForSelector('[data-act=pnew]', { timeout: 8000 });
  ok('تبويب «المشاريع» ظاهر ومحدّد', await m.$eval('nav.tabs a[aria-current=page]', (e) => e.textContent.trim()) === 'المشاريع');
  ok('قائمة فارغة برسالة واضحة', (await body(m)).includes('لا مشاريع نشطة بعد'));
  await m.click('[data-act=pnew]'); await m.waitForSelector('[data-form=pcreate]');
  await axe(m, 'نموذج مشروع جديد (حاسوب)');
  await m.fill('[data-form=pcreate] [name=name]', 'مشروع الاختبار الأول');
  await m.fill('[data-form=pcreate] [name=descr]', 'هدف تجريبي');
  await m.click('[data-form=pcreate] button[type=submit]');
  await m.waitForURL(/#\/track\/p\/.+/, { timeout: 8000 });
  await m.waitForSelector('h1, .vh h1, .vh', { timeout: 5000 });
  await m.waitForTimeout(600);
  ok('صفحة المشروع بعد الإنشاء تعرض الاسم والهدف', (await body(m)).includes('مشروع الاختبار الأول') && (await body(m)).includes('هدف تجريبي'));
  ok('لا مهام: نص إرشادي', (await body(m)).includes('أسند أول مهمة'));
  const PID = decodeURIComponent(m.url().split('/p/')[1].split('?')[0]);
  await axe(m, 'صفحة مشروع فارغ (حاسوب)');

  // ٢) الإسناد داخل المشروع من زر «إسناد مهمة»
  await m.click('a.btn.primary[href*="#/track/new?project="]');
  await m.waitForSelector('[data-form=assign]'); await m.waitForTimeout(700);
  ok('نموذج الإسناد يأتي ومعه المشروع محدّدًا', (await m.$eval('[data-af=project]', (e) => e.value)) === PID);
  await axe(m, 'نموذج الإسناد مع المشروع (حاسوب)');
  await m.fill('[data-af=title]', 'مهمة داخل المشروع');
  await m.check(`[data-af-to="${ei.id}"]`);
  await m.click('[data-form=assign] button[type=submit]');
  await m.waitForURL(/#\/track\/t\//, { timeout: 8000 }); await m.waitForTimeout(900);
  ok('تفاصيل المهمة تعرض وسم المشروع كرابط', !!(await m.$(`a.tag.proj[href$="/p/${PID}"]`)));
  await m.click(`a.tag.proj[href$="/p/${PID}"]`); await m.waitForTimeout(900);
  ok('رابط الوسم يعيد إلى المشروع ويعرض المهمة المفتوحة', (await body(m)).includes('مهمة داخل المشروع') && /المفتوحة · [1١]/.test(await body(m)));
  ok('الأشخاص: الموظف يظهر بنسبته', (await body(m)).includes('علي الموظف'));

  // ٣) الموظف يرى اسم المشروع على مهمته (واجهة «مهامي») ولا يستطيع إنشاء مشروع
  const e = await page(b, E, ORG, { width: 390, height: 844 });
  await e.goto(BASE + '#/track/p'); await e.waitForTimeout(1200);
  ok('الموظف لا يرى زر إنشاء مشروع', !(await e.$('[data-act=pnew]')));
  await e.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/list/work'); await e.waitForTimeout(1500);
  ok('مهمة الموظف تحمل وسم المشروع', (await body(e)).includes('مشروع الاختبار الأول'));

  // ٤) المدير يعدّل ويعيد التسمية ⇒ تنتشر للموظف
  await m.click('[data-act=pedit]'); await m.waitForSelector('[data-form=pedit]');
  await axe(m, 'نموذج تعديل المشروع (حاسوب)');
  await m.fill('[data-form=pedit] [name=name]', 'مشروع بعد إعادة التسمية');
  await m.click('[data-form=pedit] button[type=submit]'); await m.waitForTimeout(900);
  ok('الاسم الجديد يظهر في الصفحة', (await body(m)).includes('مشروع بعد إعادة التسمية'));
  await e.reload(); await e.waitForTimeout(1500);
  ok('الموظف يرى الاسم الجديد على مهمته', (await body(e)).includes('مشروع بعد إعادة التسمية') && !(await body(e)).includes('مشروع الاختبار الأول'));

  // ٥) نسبة الإنجاز تنعكس: الموظف يرفع ٥٠٪ ثم يراها المدير
  const tid = (await api(M.token, 'GET', '/api/assigned', null, ORG)).tasks[0].id;
  await api(E.token, 'POST', '/api/p', { ops: [{ op: 'patch', col: 'tasks', id: tid, data: { prog: 50 } }] }, ORG);
  await m.goto(BASE + '#/track/p'); await m.waitForSelector('.pcard', { timeout: 8000 });
  ok('بطاقة المشروع تعرض النسبة المحسوبة', /٥٠٪/.test(await m.$eval('.pcard', (el) => el.textContent)) || /50/.test(await m.$eval('.pcard', (el) => el.textContent)), await m.$eval('.pcard', (el) => el.textContent));
  await axe(m, 'قائمة المشاريع (حاسوب)');

  // ٦) جوال: بلا تمرير أفقي وبلا مخالفات
  const mm = await page(b, M, ORG, { width: 390, height: 844 });
  for (const [r, n] of [['#/track/p', 'قائمة المشاريع'], [`#/track/p/${PID}`, 'صفحة المشروع'], [`#/track/new?project=${PID}`, 'نموذج الإسناد']]) {
    await mm.goto(BASE + r); await mm.waitForTimeout(1100);
    const v = await verdict(mm); ok(`جوال: لا تمرير أفقي — ${n}`, !v.over, v);
    await axe(mm, `${n} (جوال)`);
  }

  // ٧) الأرشفة: تختفي من النشطة وتظهر في المؤرشفة، ولا يقبل الإسناد إليها
  await m.goto(BASE + `#/track/p/${PID}`); await m.waitForSelector('[data-act=pedit]'); await m.click('[data-act=pedit]'); await m.waitForSelector('[data-form=pedit]');
  await m.selectOption('[data-form=pedit] [name=status]', 'archived'); await m.click('[data-form=pedit] button[type=submit]'); await m.waitForTimeout(900);
  ok('بعد الأرشفة يظهر تنبيه وزر إعادة التفعيل', (await body(m)).includes('مؤرشفة') && !!(await m.$('[data-act=pstat]')));
  ok('لا زر إسناد لمشروع مؤرشف', !(await m.$('a[href*="#/track/new?project="]')));
  await m.goto(BASE + '#/track/p'); await m.waitForTimeout(900);
  ok('النشطة لا تعرضه', (await body(m)).includes('لا مشاريع نشطة بعد'));
  await m.click('[data-act=pst][data-v=archived]'); await m.waitForSelector('.pcard'); ok('المؤرشفة تعرضه', (await body(m)).includes('مشروع بعد إعادة التسمية'));
  await m.goto(BASE + `#/track/p/${PID}`); await m.waitForSelector('[data-act=pstat]'); await m.click('[data-act=pstat]'); await m.waitForTimeout(900);
  ok('إعادة التفعيل تعيد زر الإسناد', !!(await m.$('a[href*="#/track/new?project="]')));

  // ٨) XSS: اسم المشروع ووصفه
  const px = await api(M.token, 'POST', '/api/projects', { name: P1 + ' x', descr: P2 + P1 }, ORG);
  await api(M.token, 'POST', '/api/assign', { to: [ei.id], title: 'مهمة xss', project: px.id }, ORG);
  const bad = [];
  for (const [who, ses] of [['المدير', M], ['الموظف', E], ['المسؤول', G]]) {
    const q = await page(b, ses, ORG);
    for (const r of ['#/track/p', `#/track/p/${px.id}`, '#/track/tasks', '#/track/new', `#/track`]) {
      await q.goto(BASE + r); await q.waitForTimeout(900);
      const v = await verdict(q); if (v.x || v.img || v.svg || q.dialogs) bad.push([who, r, v, q.dialogs]);
    }
  }
  ok('XSS: لا تنفيذ لشيفرة في اسم المشروع ووصفه عبر ٥ شاشات × ٣ أدوار', bad.length === 0, bad);
  const lit = await page(b, M, ORG); await lit.goto(BASE + `#/track/p/${px.id}`); await lit.waitForTimeout(1000);
  ok('الحمولة تظهر نصًا حرفيًا', (await body(lit)).includes('<img src=x'));
  const my = await page(b, E, ORG, { width: 390, height: 844 }); await my.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/list/work'); await my.waitForTimeout(1500);
  const vv = await verdict(my); ok('XSS: وسم المشروع في «مهامي» لا ينفّذ', !vv.x && !vv.img && !vv.svg && !my.dialogs, vv);

  const errs = [m, e, mm].flatMap((p) => p.errs);
  ok('لا أخطاء JS ولا ردود 5xx', errs.length === 0, errs.slice(0, 5));
  await b.close();
  console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
