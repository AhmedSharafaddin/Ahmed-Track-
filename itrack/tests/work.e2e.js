// اختبار المتصفح لمسار الإسناد والمتابعة كاملًا (خادم حقيقي فوق node:sqlite):
//   المدير يُسند ← الموظف (جوال) يرفع النسبة والتفاصيل والصورة والتعليق وينجز ← يملأ تقريره تلقائيًا ← المدير يعتمد،
//   مع Kanban والتقويم ولوحة الأوامر والتشغيل والتكامل، وفحص axe (WCAG AA)، وعدم تجاوز عرض الجوال، وزمن الاستجابة.
//   AXE=/path/axe.min.js [OUT=dir] node itrack/tests/work.e2e.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const AX = fs.readFileSync(process.env.AXE, 'utf8');
const OUT = process.env.OUT || '/tmp';
const PORT = 8900 + Math.floor(Math.random() * 90);
const ORIGIN = `http://localhost:${PORT}`; const BASE = `${ORIGIN}/itrack/`;
const srv = require('child_process').spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => srv.kill());
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const api = async (tok, method, p, body, org) => {
  const r = await fetch(ORIGIN + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(org ? { 'x-org': org } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const T = new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(T + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
async function page(b, ses, org, vp = { width: 1366, height: 900 }, theme = 'petrol') {
  const ctx = await b.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
  await ctx.addInitScript(([s, o, t]) => { try { localStorage.setItem('it:session', JSON.stringify(s)); localStorage.setItem('it:org', JSON.stringify(o)); localStorage.setItem('it:theme', JSON.stringify(t)); localStorage.setItem('cc:theme', t); } catch {} }, [ses, org, theme]);
  const p = await ctx.newPage(); p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errs.push(m.text()); });
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) p.errs.push('API ' + r.status() + ' ' + r.url()); });
  return p;
}
const wait = (p, ms = 350) => p.waitForTimeout(ms);
const axe = async (p, name) => { await p.addScriptTag({ content: AX }); const v = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((x) => [x.id, x.nodes.length, x.nodes[0].target.join(' ').slice(0, 80), ((x.nodes[0].any[0] || {}).message || '').slice(0, 140)])); ok('axe ' + name, !v.length, v); };
const text = (p, s) => p.$eval(s, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const noOverflow = async (p, name) => ok('no horizontal scroll: ' + name, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]));
const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + '.png'), fullPage: false });

(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  /* ───── التهيئة عبر الـAPI ───── */
  const g = await api(null, 'POST', '/api/auth/signup', { email: 'gm@asas.test', password: 'Passw0rd!' });
  const ORG = (await api(g.token, 'POST', '/api/orgs', { name: 'أسس تيليكوم (تجربة)', my_name: 'المدير العام' })).id;
  await api(g.token, 'PUT', '/api/settings', { weekend: [], feat: { ics: true } }, ORG);
  const dep = (await api(g.token, 'POST', '/api/departments', { name: 'المخازن' }, ORG)).id;
  const pos = (await api(g.token, 'POST', '/api/positions', { title: 'أمين مخزن', department_id: dep, responsibilities: [{ title: 'مطابقة الوارد اليومي', freq: 'daily', prio: 2, est: 30 }, { title: 'استلام الشحنات' }] }, ORG)).id;
  const boot = await api(g.token, 'GET', '/api/bootstrap', null, ORG);
  const inv = (email, name, role, manager_id, position_id = null) => api(g.token, 'POST', '/api/members', { email, name, role, manager_id, department_id: dep, position_id }, ORG);
  const mi = await inv('mgr@asas.test', 'مدير المخازن', 'manager', boot.me.id);
  const ei = await inv('emp@asas.test', 'سارة', 'employee', mi.id, pos);
  const e2 = await inv('emp2@asas.test', 'علي', 'employee', mi.id, pos);
  const red = async (email, code) => { const r = await api(null, 'POST', '/api/auth/code', { email, code, password: 'Passw0rd!' }); return { token: r.token, uid: r.user.uid, email }; };
  const M = await red('mgr@asas.test', mi.code); const E = await red('emp@asas.test', ei.code); await red('emp2@asas.test', e2.code);
  const G = { token: g.token, uid: g.user.uid, email: 'gm@asas.test' };
  await api(M.token, 'POST', '/api/assign', { to: [ei.id], title: 'مهمة متأخرة من الأسبوع الماضي', due: day(-2), prio: 1 }, ORG);
  await api(M.token, 'POST', '/api/assign', { to: [e2.id], title: 'تحديث أرصدة الرف ج', due: day(1), prio: 2 }, ORG);

  const b = await chromium.launch();
  /* ───── ١) المدير: لوحة المتابعة ثم الإسناد ───── */
  const mg = await page(b, M, ORG);
  await mg.goto(BASE); await mg.waitForSelector('.kpis.k6', { timeout: 10000 });
  ok('manager lands on follow-up board', mg.url().includes('#/track'));
  ok('board: needs-attention table lists both employees', (await mg.$$('.tbl a.tr')).length === 2);
  ok('board: overdue KPI counts the late task', (await text(mg, '.kpis.k6')).includes('1متأخرة الآن') || (await text(mg, 'a.kpi.hot')).startsWith('1'));
  ok('board: risk list shows overdue task', (await text(mg, '.risks')).includes('مهمة متأخرة'));
  await shot(mg, 'w1-board'); await axe(mg, 'board (desk)');
  await mg.keyboard.press('Control+k'); await wait(mg, 200);
  ok('Ctrl+K opens command palette', !!(await mg.$('#pal .pal-in')));
  await mg.keyboard.type('إسناد'); await wait(mg, 120); await mg.keyboard.press('Enter'); await wait(mg, 400);
  ok('palette navigates to assign form', mg.url().includes('#/track/new') && !(await mg.$('#pal')));
  await mg.waitForSelector('[data-form=assign]');
  await mg.fill('[data-af=title]', 'جرد الرف ب وتصويره'); await mg.fill('[data-af=desc]', 'طابق الرصيد الفعلي مع النظام وأرفق صورة الرف بعد الترتيب.');
  await mg.fill('[data-af=due]', day(1)); await mg.click('[data-act=af-prio][data-v="3"]'); await wait(mg, 150);
  await mg.check('[data-af=photo]');
  await mg.check(`[data-af-to="${ei.id}"]`); await wait(mg, 200);
  ok('assign form keeps typed values across re-render', (await mg.inputValue('[data-af=title]')) === 'جرد الرف ب وتصويره' && (await mg.inputValue('[data-af=desc]')).startsWith('طابق'));
  ok('assign: load badge shown next to employee', !!(await mg.$('.pick .ld')));
  await shot(mg, 'w2-assign'); await axe(mg, 'assign form');
  await mg.focus('[data-af=title]'); await mg.keyboard.press('Control+Enter');
  await mg.waitForSelector('.progline', { timeout: 8000 });
  ok('Ctrl+Enter assigns and opens the task', (await text(mg, '.vh h1')) === 'جرد الرف ب وتصويره' && (await text(mg, '.vh')).includes('حرجة'));
  await wait(mg, 800);
  const dup = (await api(E.token, 'GET', '/api/p/tasks', null, ORG)).docs.filter((d) => d.title === 'جرد الرف ب وتصويره').length;
  ok('assign creates exactly one task (no double submit)', dup === 1, dup);

  /* ───── ٢) الموظف (جوال): مهامي ───── */
  const em = await page(b, E, ORG, { width: 390, height: 844 }, 'aqua');
  await em.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/list/work'); await em.waitForSelector('li.t.work', { timeout: 12000 });
  const items = await em.$$eval('li.t.work', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ')));
  ok('employee: assigned + duty + overdue appear under «من العمل»', items.length === 3 && items.some((x) => x.includes('جرد الرف ب') && x.includes('من مدير المخازن')) && items.some((x) => x.includes('واجب يومي')), items);
  await noOverflow(em, 'my work list (390px)');
  const li = await em.$('li.t.work:has-text("جرد الرف ب")');
  await (await li.$('[data-act=open]')).click(); await em.waitForSelector('.pblk.work');
  ok('pane: title read-only, no delete, work block shown', !!(await em.$('#p-title[readonly]')) && !(await em.$('[data-act=del-task]')) && (await text(em, '.pblk.work')).includes('أسندها مدير المخازن'));
  await em.click('.ph [data-act=toggle]'); await wait(em, 400);
  ok('photo required: completion blocked with message', (await text(em, '#toast')).includes('أرفق صورة') && !(await em.$('.pane-in.done')));
  await em.click('[data-act=set-prog][data-v="50"]'); await wait(em, 250);
  ok('progress 50% set', (await em.getAttribute('[data-act=set-prog][data-v="50"]', 'aria-pressed')) === 'true');
  await em.fill('[data-f=rpt]', 'طابقت ١٢ رفًا من ١٥'); await em.click('.wk-h'); await wait(em, 300);
  // صورة JPEG حقيقية من Canvas
  const jpg = await em.evaluate(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 700; const x = c.getContext('2d'); x.fillStyle = '#2a7'; x.fillRect(0, 0, 900, 700); x.fillStyle = '#fff'; x.font = '60px sans-serif'; x.fillText('Shelf B', 200, 350); const b2 = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); return Array.from(new Uint8Array(await b2.arrayBuffer())); });
  fs.writeFileSync(path.join(OUT, 'shelf.jpg'), Buffer.from(jpg));
  await em.setInputFiles('[data-act=photo-up]', path.join(OUT, 'shelf.jpg')); await em.waitForSelector('.wk-ph img', { timeout: 8000 });
  ok('photo compressed, uploaded and shown', (await em.$$('.wk-ph img')).length === 1);
  await em.fill('.wk-cf textarea', 'الفرق ٣ قطع، سأرفق الكشف'); await em.click('.wk-cf button'); await em.waitForSelector('.wk-c li', { timeout: 6000 });
  ok('comment posted in task thread', (await text(em, '.wk-c')).includes('الفرق ٣ قطع'));
  await shot(em, 'w3-employee-pane'); await axe(em, 'employee work pane (aqua mobile)');
  await em.click('.ph [data-act=toggle]'); await wait(em, 600);
  ok('completion after photo → sent to manager', (await text(em, '#toast')).includes('مديرك'));
  await wait(em, 5000);
  await em.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/list/work'); await em.waitForSelector('li.t', { timeout: 8000 }); await wait(em, 2500);
  ok('employee sees «awaiting approval» after server sync', (await em.$$eval('li.t', (l) => l.map((x) => x.textContent).join('|'))).includes('بانتظار الاعتماد'));
  // الدمج: الخادم يعيد ما حدده المدير لو حاول الجهاز تغييره
  const asgDoc = (await api(E.token, 'GET', '/api/p/tasks', null, ORG)).docs.find((d) => d.title === 'جرد الرف ب وتصويره');
  ok('server state: done, photo, progress 100, review pending', asgDoc.status === 'done' && asgDoc.photos.length === 1 && asgDoc.prog === 100 && asgDoc.rv?.state === 'pending' && asgDoc.rpt.includes('١٢ رفًا'), asgDoc);

  /* ───── ٣) الموظف: يومي (التنبيهات + التقرير يكتب نفسه) ───── */
  await em.goto(BASE + '#/day'); await em.waitForSelector('.card.notes', { timeout: 8000 });
  ok('day: notifications card (assigned + overdue)', (await text(em, '.card.notes')).includes('أسند إليك') && (await text(em, '.card.notes')).includes('فات موعد'));
  await em.click('[data-act=fill-day]'); await wait(em, 1200);
  const draft = await em.$$eval('.items textarea', (t) => t.map((x) => x.value));
  ok('report auto-drafted from today’s tasks', draft.some((x) => x.includes('جرد الرف ب') && x.includes('١٢ رفًا')), draft);
  await noOverflow(em, 'day (390px)'); await shot(em, 'w4-day-autofill'); await axe(em, 'day with notes (mobile)');

  /* ───── ٤) المدير: المهام، Kanban، التقويم، الاعتماد ───── */
  await mg.goto(BASE + '#/track/tasks?st=review'); await mg.waitForSelector('.tl2 .trow', { timeout: 8000 });
  ok('tasks: review filter lists the done task', (await text(mg, '.tl2')).includes('جرد الرف ب'));
  const t0 = await mg.evaluate(() => performance.now());
  await mg.click('[data-act=tv][data-v=board]'); await mg.waitForSelector('.kanban');
  const dt = await mg.evaluate((s) => performance.now() - s, t0);
  ok(`view switch renders fast (${Math.round(dt)}ms ≤ 150ms incl. test overhead)`, dt <= 150, dt);
  ok('kanban: card in «awaiting approval» column', (await text(mg, '.k-review')).includes('جرد الرف ب') && (await text(mg, '.k-blocked')).length > 0);
  await shot(mg, 'w5-kanban'); await axe(mg, 'kanban');
  await mg.click('[data-act=tv][data-v=cal]'); await mg.waitForSelector('.cal');
  ok('calendar shows tasks on their due day', (await mg.$$('.cal .ce')).length >= 1);
  await shot(mg, 'w6-calendar'); await axe(mg, 'calendar');
  await mg.click('[data-act=tv][data-v=list]');
  await mg.goto(BASE + '#/track/tasks'); await mg.click('[data-act=tst][data-v=review]'); await mg.waitForSelector('.tl2 .trow:has-text("جرد الرف ب")'); await mg.click('.tl2 .trow:has-text("جرد الرف ب")'); await mg.waitForSelector('[data-form=tdecide]', { timeout: 8000 })
  ok('detail: employee report, photo, comment visible', (await text(mg, '.card')).includes('١٢ رفًا') && !!(await mg.$('.phs img, .phs .ph-ld')) && (await text(mg, '.thread')).includes('الفرق ٣ قطع'));
  await mg.click('[data-form=tdecide] button[value=return]'); await wait(mg, 300);
  ok('return requires a note (client)', (await text(mg, '#toast')).includes('اكتب ما المطلوب'));
  await mg.fill('[data-form=tdecide] textarea', 'ممتاز، أرسل الكشف للمحاسبة'); await mg.click('[data-form=tdecide] button[value=approve]'); await wait(mg, 900);
  ok('approved: notice shown with manager name', (await text(mg, '.notice.ok')).includes('اعتمدها مدير المخازن'));
  await mg.waitForSelector('.phs img', { timeout: 6000 }).catch(() => {});
  await shot(mg, 'w7-detail-approved'); await axe(mg, 'task detail');
  await mg.goto(BASE + `#/track/m/${ei.id}`); await mg.waitForSelector('.kpis.k6');
  ok('person drill-down: approval 100% and duties shown', (await text(mg, '.kpis.k6')).includes('100٪') && (await text(mg, '.kpis.k6')).includes('الواجبات الدورية'));
  await axe(mg, 'person drill-down');
  const mm = await page(b, M, ORG, { width: 390, height: 844 }, 'navy');
  for (const [h, sel, n] of [['#/track', '.kpis.k6', 'board'], ['#/track/tasks', '.tl2', 'tasks'], ['#/track/new', '[data-form=assign]', 'assign']]) {
    await mm.goto(BASE + h); await mm.waitForSelector(sel, { timeout: 8000 }); await wait(mm, 300); await noOverflow(mm, `manager ${n} (390px)`);
  }
  await mm.goto(BASE + '#/track'); await mm.waitForSelector('.tbl'); await shot(mm, 'w8-board-mobile'); await axe(mm, 'board (navy mobile)');

  /* ───── ٥) المسؤول: التشغيل والتكامل + الواجبات في التوصيف ───── */
  const ad = await page(b, G, ORG);
  await ad.goto(BASE + '#/org/ops'); await ad.waitForSelector('[data-form=ops]', { timeout: 8000 });
  ok('ops: AI/API/webhooks off by default, marked as needing IT approval', !(await ad.isChecked('[name=f_ai]')) && !(await ad.isChecked('[name=f_api]')) && (await ad.$$('.sw-row .out')).length === 4);
  await shot(ad, 'w9-ops'); await axe(ad, 'ops & integrations');
  await ad.check('[name=f_api]'); await ad.click('[data-form=ops] button[type=submit]'); await wait(ad, 900);
  ok('ops: saved', (await text(ad, '#toast')).includes('حُفظت'));
  await ad.fill('[name=kname]', 'ERPNext'); await ad.click('[data-act=key-new]'); await ad.waitForSelector('.notice.ok pre', { timeout: 6000 });
  const key = await text(ad, '.notice.ok pre');
  ok('api key shown once', key.startsWith('itk_'));
  const viaKey = await (await fetch(`${ORIGIN}/api/metrics`, { headers: { authorization: 'Bearer ' + key } })).json();
  ok('api key works from an external system', Array.isArray(viaKey.members) && viaKey.members.length === 3, viaKey);
  await ad.goto(BASE + '#/org/positions'); await ad.waitForSelector('.jd');
  ok('positions list shows duty badge', (await text(ad, '.jd')).includes('واجب يومي'));
  await ad.click('[data-act=edit-pos]'); await ad.waitForSelector('[name=rf]');
  ok('position editor: frequency/priority/estimate per responsibility', (await ad.$$('[name=rf]')).length >= 2 && (await ad.inputValue('[name=rf]')) === 'daily');
  await axe(ad, 'position editor with duties');
  await ad.goto(BASE + '#/audit'); await ad.waitForSelector('.trail');
  ok('audit shows assignment, completion, approval, settings, key', ['أسند مهمة', 'رفع مهمة منجزة', 'اعتمد مهمة', 'غيّر إعدادات التشغيل', 'أصدر مفتاح API'].every((x) => ad.$eval('.trail', (e) => e.textContent).then((s) => s.includes(x))));
  const auditTxt = await text(ad, '.trail');
  ok('audit trail content', ['أسند مهمة', 'رفع مهمة منجزة', 'اعتمد مهمة', 'غيّر إعدادات التشغيل', 'أصدر مفتاح API'].every((x) => auditTxt.includes(x)), auditTxt.slice(0, 300));
  await em.goto(BASE + '#/settings'); await em.waitForSelector('[data-act=ics-new]');
  await em.click('[data-act=ics-new]'); await em.waitForSelector('.card pre.invite', { timeout: 5000 });
  const ics = await (await fetch(await text(em, '.card pre.invite'))).text();
  ok('employee calendar link works (ICS)', ics.includes('BEGIN:VCALENDAR') && ics.includes('مهمة متأخرة'));

  for (const p of [mg, em, mm, ad]) ok('no page errors', !p.errs.length, p.errs);
  console.log(`\n${pass} pass, ${fail} fail`);
  await b.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
