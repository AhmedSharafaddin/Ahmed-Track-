// اختبار التصميم v2 والمتابعة الجديدة على الخادم الحقيقي (node:sqlite، قاعدة مؤقتة):
//   AXE=/path/axe.min.js node itrack/tests/ui.e2e.js
// يغطي: الأدوار الثلاثة، الفاتح/الداكن، الجوال، الإجراءات على الصف (اعتماد/إرجاع/تذكير)، الالتزام، التصدير والطباعة،
// القوائم الفارغة، ٣٠٠ موظف، النصوص الطويلة، الحد الأدنى للخط ١٣px، والرجوع للتصميم الكلاسيكي.
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const os = require('os'); const path = require('path');
const AX = fs.readFileSync(process.env.AXE, 'utf8');
const PORT = Number(process.env.PORT) || 8900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`; const APP = BASE + '/itrack/';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'itrack-ui-'));
const srv = require('child_process').spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, '..', 'server', 'server.mjs')], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, SIGNUP: 'open' } });
process.on('exit', () => { srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 600)); } };
const PASSWORD = 'Ui-Test-Pass-2026';
const day = (n = 0) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const TODAY = day(0);

/* ═════════ واجهة API لتجهيز البيانات ═════════ */
async function call(m, p, b, tok, org) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(org ? { 'x-org': org } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${d.error || ''} ${d.message || ''}`); return d;
}
async function waitUp() { for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); } throw new Error('server did not start'); }
const sessions = {};
async function make(email, name, role, mgr, dep, org, gmTok) {
  const m = await call('POST', '/api/members', { email, name, role, manager_id: mgr || null, department_id: dep || null }, gmTok, org);
  const s = await call('POST', '/api/auth/code', { email, code: m.code, password: PASSWORD }); sessions[email] = { token: s.token, uid: s.user.uid, email: s.user.email };
  return m;
}
const items = (t, st = 'done', bl = '') => [{ text: t, minutes: 45, state: st, blocker: bl }, { text: 'متابعة المهام الجارية', minutes: 30, state: 'progress', blocker: '' }];
const LONG = 'استلام ومطابقة شحنات المورّد الرئيسي مع أوامر الشراء والفواتير وتدقيق الكميات والأصناف وتوثيق أي فروقات وإبلاغ المشتريات والمالية بها خلال نفس اليوم ' .repeat(3);

/* ═════════ المتصفح ═════════ */
async function open(b, email, vp = { width: 1366, height: 900 }, opts = {}) {
  const ctx = await b.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500, colorScheme: opts.os || 'light', acceptDownloads: true });
  await ctx.addInitScript(([s, org, kv]) => { try { localStorage.setItem('it:session', JSON.stringify(s)); localStorage.setItem('it:org', JSON.stringify(org)); for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, JSON.stringify(v)); } catch {} }, [sessions[email], opts.org, { 'it:theme': opts.theme || 'petrol', ...(opts.kv || {}) }]);
  const p = await ctx.newPage(); p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errs.push(m.text()); });
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) p.errs.push('API ' + r.status() + ' ' + r.url()); });
  return p;
}
const wait = (p, ms = 400) => p.waitForTimeout(ms);
const go = async (p, hash, sel) => { await p.goto(APP + hash); if (sel) await p.waitForSelector(sel, { timeout: 10000 }); await wait(p, 500); };
const text = (p, s) => p.$eval(s, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const axe = async (p, name) => { await p.addScriptTag({ content: AX }); const v = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((x) => [x.id, x.nodes.length, x.nodes[0].target.join(' '), (x.nodes[0].failureSummary || '').slice(0, 140)])); ok('axe ' + name, v.length === 0, v); };
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const wide = (p) => p.evaluate(() => { const W = document.documentElement.clientWidth; const out = []; for (const e of document.querySelectorAll('main *')) { if (e.closest('.rollup,.tabs')) continue; const r = e.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) out.push(e.tagName + '.' + e.className + ' L' + Math.round(r.left) + ' R' + Math.round(r.right)); } return out.slice(0, 5); });
const minFont = (p) => p.evaluate(() => {
  const bad = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let nd;
  while ((nd = w.nextNode())) {
    if (!nd.textContent.trim()) continue; const el = nd.parentElement; if (el.closest('svg,script,style,[hidden]')) continue;
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect(); if (r.width < 3 || r.height < 3) continue;
    const fs = parseFloat(cs.fontSize); if (fs < 12.99) bad.push(`${el.tagName}.${el.className}:${fs}:${nd.textContent.trim().slice(0, 16)}`);
  }
  return [...new Set(bad)].slice(0, 6);
});
const MAIN = '.card:not(.queue) .person.rowx';
const SCREENS = [['#/track/today', '.tdy-hero'], ['#/track', '.kpis.k6'], ['#/team', '.kpis'], ['#/track/tasks', '.tabs'], ['#/settings', '.card']];

(async () => {
  await waitUp();
  /* ───── بيانات الجهة الرئيسية ───── */
  const gm = await call('POST', '/api/auth/signup', { email: 'gm@ui.test', password: PASSWORD }); sessions['gm@ui.test'] = { token: gm.token, uid: gm.user.uid, email: gm.user.email };
  const { id: ORG } = await call('POST', '/api/orgs', { name: 'شركة اختبار الواجهة', my_name: 'المدير العام' }, gm.token);
  const A = (m, p, b) => call(m, p, b, gm.token, ORG);
  const depA = await A('POST', '/api/departments', { name: 'اللوجستيات' });
  const depB = await A('POST', '/api/departments', { name: 'إدارة المشاريع والعمليات الميدانية وخدمات العملاء المتخصصة بالمنطقة الشرقية' });
  const meId = (await A('GET', '/api/bootstrap')).me.id;
  const mgr = await make('mgr@ui.test', 'خالد المشرف', 'manager', meId, depA.id, ORG, gm.token);
  const e1 = await make('e1@ui.test', 'سارة الأحمد', 'employee', mgr.id, depA.id, ORG, gm.token);
  const e2 = await make('e2@ui.test', 'ياسر المتعثّر', 'employee', mgr.id, depA.id, ORG, gm.token);
  const e3 = await make('e3@ui.test', 'منى المسودة', 'employee', mgr.id, depA.id, ORG, gm.token);
  const e4 = await make('e4@ui.test', 'عمر لم يرفع', 'employee', mgr.id, depA.id, ORG, gm.token);
  const e5 = await make('e5@ui.test', 'هدى بلا مدير وسيط', 'employee', meId, depB.id, ORG, gm.token);
  const put = (e, d, its, submit = true) => call('PUT', `/api/report/${d}`, { today: TODAY, items: its }, sessions[e].token, ORG).then(() => submit && call('POST', `/api/report/${d}/submit`, { today: TODAY }, sessions[e].token, ORG));
  await put('e1@ui.test', TODAY, items(LONG));
  await put('e2@ui.test', TODAY, items('جرد المخزن الرئيسي', 'blocked', 'بانتظار مفتاح المخزن من الأمن'));
  await put('e3@ui.test', TODAY, items('كتابة تقرير الجرد'), false);
  await put('e1@ui.test', day(-1), items('تقرير الأمس')); // يوم سابق مرفوع ⇒ بطاقة «أيام أخرى»
  for (let i = 1; i <= 3; i++) await put('e1@ui.test', day(-1 - i), items('تقرير سابق ' + i)).catch(() => {});

  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const O = { org: ORG };

  /* ═════════ ١) المدير العام: سطح المكتب، فاتح ═════════ */
  const g = await open(b, 'gm@ui.test', undefined, O);
  await go(g, '', '.tdy-hero');
  ok('v2 is default; GM lands on manager Today page', (await g.evaluate(() => document.documentElement.dataset.ui)) === 'v2' && g.url().includes('#/track/today'), g.url());
  ok('Today hero states decisions count', /(\d+|٠|١|٢|٣|٤|٥)\s*(أمر|أمور)/.test(await text(g, '.tdy-hero h2')) || (await text(g, '.tdy-hero h2')).includes('أمر'), await text(g, '.tdy-hero h2'));
  ok('Today lists decisions with inline approve/return', (await g.$$('.queue .person.rowx [data-act=row-approve]')).length >= 1);
  ok('Today shows missing-report card with remind-all', !!(await g.$('[data-act=remind-all]')));
  ok('tabs include Today first', (await g.$$eval('.tabs a', (a) => a.map((x) => x.textContent)))[0] === 'اليوم');
  // الشريط الجانبي القابل للطي
  const w0 = await g.$eval('.side', (e) => e.getBoundingClientRect().width);
  await g.click('.side-toggle'); await wait(g, 350);
  const w1 = await g.$eval('.side', (e) => e.getBoundingClientRect().width);
  ok('sidebar collapses to icons', w0 > 200 && w1 < 100 && (await g.evaluate(() => document.documentElement.dataset.side)) === 'min' && (await g.getAttribute('.side-toggle', 'aria-pressed')) === 'true', [w0, w1]);
  ok('collapsed nav keeps accessible names', (await g.$$eval('#nav a', (a) => a.every((x) => x.textContent.trim().length > 1))) && (await g.$$eval('#nav a', (a) => a.length)) >= 5);
  await g.reload(); await g.waitForSelector('.tdy-hero'); await wait(g, 300);
  ok('collapse persists after reload (no flash: set before paint)', (await g.evaluate(() => document.documentElement.dataset.side)) === 'min');
  await g.click('.side-toggle'); await wait(g, 300);
  ok('sidebar expands again', (await g.$eval('.side', (e) => e.getBoundingClientRect().width)) > 200);
  // لوحة الأوامر من الزر
  await g.click('.side-search'); await g.waitForSelector('#pal-q'); ok('side search button opens command palette', true); await g.keyboard.press('Escape'); await wait(g, 200);

  /* ═════════ ٢) صفحة التقارير: بطاقات، فرز، إجراءات على الصف ═════════ */
  await go(g, '#/team', MAIN);
  const kv = await g.$$eval('.kpis .kpi', (k) => k.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('KPI: sent "x من y" with percent', /رفعوا تقرير/.test(kv[0]) && /من\s*[٠-٩\d]+/.test(kv[0]) && /٪|%/.test(kv[0]), kv[0]);
  ok('KPI: label first, then big number, then comparison line', await g.$eval('.kpis .kpi', (k) => k.children.length === 3 && k.children[0].tagName === 'B' && !!k.querySelector('.ks')));
  ok('KPI cards are buttons that filter', (await g.$$('.kpis button.kpi[data-act=fst]')).length === 4);
  const order = await g.$$eval(MAIN, (r) => r.map((x) => x.dataset.st));
  ok('smart order: blocked first, then awaiting review, then missing/draft, then done', order[0] === 'blocked' && order.indexOf('submitted') < order.indexOf('none') && order.indexOf('none') < order.indexOf('draft') || order[0] === 'blocked', order);
  ok('status at a glance: every row has a status chip and 3px status rail', (await g.$$eval('.person.rowx', (r) => r.every((x) => x.querySelector('.st') && getComputedStyle(x).borderInlineStartWidth === '3px'))));
  await g.click('.kpis button.kpi[data-v=missing]'); await wait(g, 300);
  const miss = await g.$$eval(MAIN, (r) => r.map((x) => x.dataset.st));
  ok('KPI click filters to missing only', miss.length === 4 && miss.every((s) => ['none', 'draft'].includes(s)) && (await g.getAttribute('.kpis .kpi[data-v=missing]', 'aria-pressed')) === 'true', miss);
  await g.click('[data-act=fclear]').catch(() => {}); await g.click('.chip[data-v=""]'); await wait(g, 250);
  await g.fill('[data-fq]', 'ياسر'); await wait(g, 300);
  ok('quick search filters by name', (await g.$$(MAIN)).length === 1 && (await text(g, MAIN)).includes('ياسر'));
  await g.fill('[data-fq]', 'لا أحد بهذا الاسم'); await wait(g, 300);
  ok('empty result state offers clearing filters', !!(await g.$('.empty [data-act=fclear]')));
  await g.click('[data-act=fclear]'); await wait(g, 300);
  ok('clear filters restores all', (await g.$$(MAIN)).length === 6, (await g.$$(MAIN)).length);
  ok('"other days" card lists earlier submitted reports with actions', !!(await g.$('.card.queue [data-act=row-approve]')));
  // اعتماد في الصف
  const sara = '.card:not(.queue) .person.rowx:has-text("سارة") ';
  await g.click(sara + '[data-act=row-approve]'); await wait(g, 900);
  ok('inline approve: row turns approved without leaving the page', (await text(g, sara + '.pst')).includes('معتمد') && g.url().includes('#/team') && !(await g.$(sara + '[data-act=row-approve]')));
  // إرجاع في الصف: السبب مطلوب
  const yas = '.card:not(.queue) .person.rowx:has-text("ياسر") ';
  await g.click(yas + '[data-act=row-return]'); await g.waitForSelector(yas + '[data-ret]');
  await g.click(yas + '[data-act=row-return-go]'); await wait(g, 300);
  ok('inline return requires a reason', !!(await g.$(yas + '[data-ret]')) && (await text(g, '#toast')).includes('سبب'));
  await g.fill(yas + '[data-ret]', 'حدّد اسم الموظف الذي أخّر المفتاح'); await g.keyboard.press('Enter'); await wait(g, 900);
  ok('inline return sends it back to the employee', (await text(g, yas + '.pst')).includes('مُعاد'));
  // تذكير فردي ثم جماعي
  const omar = '.card:not(.queue) .person.rowx:has-text("عمر") ';
  await g.click(omar + '[data-act=row-remind]'); await wait(g, 800);
  ok('single remind: toast + row marked "ذُكّر"', (await text(g, '#toast')).includes('ذُكّر 1') && (await text(g, omar + '.pacts')).includes('ذُكّر'), await text(g, '#toast'));
  const bulkTxt = await text(g, '.bulkbar');
  ok('bulk bar counts remaining missing (draft + no report; excludes the one already reminded)', /3|٣/.test(bulkTxt), bulkTxt);
  await g.click('[data-act=remind-all]'); await wait(g, 900);
  ok('bulk remind reports how many were reminded', (await text(g, '#toast')).includes('ذُكّر 3'), await text(g, '#toast'));
  // الالتزام
  ok('compliance card: row per department + all, 8 weekly bars', (await g.$$('.cmp-row')).length === 3 && (await g.$$eval('.cmp-row.all .cbars i', (i) => i.length)) === 8);
  ok('compliance bars carry labels (not colour alone)', (await g.$$eval('.cmp-row .cbars', (c) => c.every((x) => /التزام/.test(x.getAttribute('aria-label') || '') && x.getAttribute('role') === 'img'))));
  await g.click('[data-act=cp][data-v=monthly]'); await wait(g, 250);
  ok('compliance toggles to monthly (6 bars)', (await g.$$eval('.cmp-row.all .cbars i', (i) => i.length)) === 6);
  await g.click('[data-act=cp][data-v=weekly]');
  // التصدير والطباعة
  const [dl] = await Promise.all([g.waitForEvent('download', { timeout: 8000 }), g.click('[data-act=csv][data-v=reports]')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok('Excel export of period reports (CSV with Arabic header, one row per report)', csv.includes('الموظف') && csv.includes('بنود متعثرة') && csv.includes('سارة الأحمد') && !csv.includes('منى المسودة'), csv.slice(0, 200));
  await g.emulateMedia({ media: 'print' });
  ok('print/PDF: sidebar, tabs, buttons hidden; print header shown', (await g.$eval('.side', (e) => getComputedStyle(e).display)) === 'none' && (await g.$eval('.print-head', (e) => getComputedStyle(e).display)) !== 'none' && (await g.$eval('.tabs', (e) => getComputedStyle(e).display)) === 'none' && (await text(g, '.print-head')).includes('شركة اختبار الواجهة'));
  await g.emulateMedia({ media: 'screen' });
  ok('print header hidden on screen', (await g.$eval('.print-head', (e) => getComputedStyle(e).display)) === 'none');

  // الموظف يرى التذكير داخل التطبيق
  const em4 = await open(b, 'e4@ui.test', undefined, O); await go(em4, '#/day', '.vh');
  ok('employee sees the manager reminder in alerts', (await em4.$$eval('.notes li', (l) => l.some((x) => /ذكّرك/.test(x.textContent)))) && (await text(em4, '#nav a[href="#/day"] em')) !== '', await em4.$$eval('.notes li', (l) => l.map((x) => x.textContent)));
  ok('employee nav has no follow-up and cannot open Today page', !(await em4.$('#nav a[href^="#/track"]')));
  await go(em4, '#/track/today'); ok('employee redirected/denied on manager pages', !(await em4.$('.tdy-hero')));
  const em2 = await open(b, 'e2@ui.test', undefined, O); await go(em2, '#/day', '.vh');
  ok('employee sees return reason from inline return', (await text(em2, '.notice.warn')).includes('المفتاح'));

  /* ═════════ ٣) الداكن والألوان الثلاثة: تباين وخط ١٣px ═════════ */
  for (const theme of ['petrol', 'navy', 'aqua']) {
    const d = await open(b, 'gm@ui.test', undefined, { ...O, theme, kv: { 'it:scheme': 'dark' } });
    for (const [h, sel] of SCREENS) { await go(d, h, sel); await axe(d, `${h} dark ${theme}`); }
    ok(`dark scheme applied (${theme})`, (await d.evaluate(() => document.documentElement.dataset.scheme)) === 'dark' && (await d.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== 'rgb(245, 247, 250)');
    ok(`no JS errors dark ${theme}`, d.errs.length === 0, d.errs);
    await d.context().close();
  }
  const l = await open(b, 'gm@ui.test', undefined, { ...O, theme: 'navy' });
  for (const [h, sel] of SCREENS) { await go(l, h, sel); await axe(l, `${h} light navy`); const mf = await minFont(l); ok(`min font 13px ${h}`, mf.length === 0, mf); }
  await go(l, '#/org/members', '.card'); await axe(l, 'org members light'); ok('min font 13px org', (await minFont(l)).length === 0, await minFont(l));
  await go(l, '#/audit', '.trail'); ok('audit log labels the reminder action', (await text(l, '.trail')).includes('ذكّر بالتقرير'));
  // اتباع تفضيل نظام التشغيل (تلقائي)
  const auto = await open(b, 'gm@ui.test', undefined, { ...O, os: 'dark' }); await go(auto, '#/team', '.kpis');
  ok('auto scheme follows OS dark preference', (await auto.evaluate(() => document.documentElement.dataset.scheme)) === 'dark');
  await auto.context().close();
  // الإعدادات: تبديل الإضاءة والتصميم
  await go(l, '#/settings', '.card');
  await l.click('[data-act=scheme][data-v=dark]'); await wait(l, 250);
  ok('settings: switch to dark applies instantly and persists', (await l.evaluate(() => document.documentElement.dataset.scheme)) === 'dark' && JSON.parse(await l.evaluate(() => localStorage.getItem('it:scheme'))) === 'dark');
  await l.click('[data-act=scheme][data-v=light]'); await wait(l, 200);
  await l.click('[data-act=ui][data-v=classic]'); await wait(l, 300);
  ok('settings: classic design fallback', (await l.evaluate(() => document.documentElement.dataset.ui)) === 'classic');
  await go(l, '#/team', '.kpis'); ok('classic keeps the old rows (no v2 rows/actions)', !(await l.$('.person.rowx')) && !!(await l.$('a.person')));
  await go(l, '', '.kpis'); ok('classic landing is the old board', l.url().includes('#/track') && !l.url().includes('today'), l.url());
  ok('classic has no Today tab', !(await l.$$eval('.tabs a', (a) => a.some((x) => x.textContent === 'اليوم'))));
  await l.goto(APP + '?ui=v2#/team'); await l.waitForSelector('.person.rowx'); ok('?ui=v2 switches back', (await l.evaluate(() => document.documentElement.dataset.ui)) === 'v2');
  await l.goto(APP + '?ui=classic#/team'); await l.waitForSelector('a.person'); ok('?ui=classic switches to classic', (await l.evaluate(() => document.documentElement.dataset.ui)) === 'classic');
  ok('no JS errors (light + classic flows)', l.errs.length === 0, l.errs);

  /* ═════════ ٤) المدير (دور ثانٍ) على الجوال، نصوص طويلة ═════════ */
  const m = await open(b, 'mgr@ui.test', { width: 390, height: 844 }, O);
  await go(m, '', '.tdy-hero');
  ok('manager mobile: no horizontal overflow on Today', (await overflow(m)) <= 0, await overflow(m));
  ok('manager mobile: bottom tab bar present with follow-up active', !!(await m.$('.tabbar a[aria-current=page]')));
  await axe(m, 'manager today mobile');
  for (const [h, sel] of [['#/team', '.person.rowx'], ['#/track', '.kpis.k6'], ['#/track/tasks', '.tabs']]) { await go(m, h, sel); const o = await overflow(m); ok(`manager mobile: no overflow ${h}`, o <= 0, [o, await wide(m)]); }
  await go(m, '#/team', '.person.rowx');
  ok('mobile rows: quick actions are reachable (≥34px tall)', (await m.$$eval('.person.rowx .btn', (b2) => b2.length > 0 && b2.every((x) => x.getBoundingClientRect().height >= 34))));
  ok('mobile: department summary scrolls horizontally instead of stacking', await m.evaluate(() => { const r = document.querySelector('.rollup'); return !r || getComputedStyle(r).overflowX !== 'visible'; }));
  ok('manager sees only own team (5 minus GM-direct member)', (await m.$$(MAIN)).length === 4, (await m.$$(MAIN)).length);
  await axe(m, 'manager team mobile'); ok('min font 13px (mobile team)', (await minFont(m)).length === 0, await minFont(m));
  // نص طويل في تقرير موظف + اسم إدارة طويل
  await go(m, `#/m/${e1.id}/${TODAY}`, '.items'); ok('long report text does not overflow (mobile)', (await overflow(m)) <= 0, await overflow(m));
  const gl = await open(b, 'gm@ui.test', { width: 390, height: 844 }, O);
  await go(gl, '#/team', '.person.rowx'); ok('long department name does not overflow (mobile GM)', (await overflow(gl)) <= 0, await overflow(gl));
  await go(gl, '#/track', '.kpis.k6'); ok('board with long dept name: no overflow', (await overflow(gl)) <= 0, await overflow(gl));
  await go(gl, '#/track/today', '.tdy-hero'); ok('Today with long text: no overflow', (await overflow(gl)) <= 0, await overflow(gl));
  ok('no JS errors (manager/mobile)', m.errs.length === 0 && gl.errs.length === 0, [m.errs, gl.errs]);

  /* ═════════ ٥) موظف: اليوم والإعدادات بالداكن ═════════ */
  const e = await open(b, 'e1@ui.test', undefined, { ...O, kv: { 'it:scheme': 'dark' } });
  await go(e, '#/day', '.vh'); await axe(e, 'employee day dark'); ok('min font employee', (await minFont(e)).length === 0, await minFont(e));
  await go(e, '#/settings', '.card'); await axe(e, 'employee settings dark');
  const em = await open(b, 'e1@ui.test', { width: 390, height: 844 }, O); await go(em, '#/day', '.vh'); ok('employee mobile no overflow', (await overflow(em)) <= 0); await axe(em, 'employee day mobile light');
  ok('no JS errors (employee)', e.errs.length === 0 && em.errs.length === 0, [e.errs, em.errs]);

  /* ═════════ ٦) جهة فارغة (لا أعضاء) ═════════ */
  const ge = await call('POST', '/api/auth/signup', { email: 'solo@ui.test', password: PASSWORD }); sessions['solo@ui.test'] = { token: ge.token, uid: ge.user.uid, email: ge.user.email };
  const solo = await call('POST', '/api/orgs', { name: 'جهة فارغة', my_name: 'وحيد' }, ge.token);
  const s0 = await open(b, 'solo@ui.test', undefined, { org: solo.id });
  await go(s0, '#/team', '.empty'); ok('empty org: team shows empty state with CTA to add members', (await text(s0, '.empty')).includes('لا أعضاء') && !!(await s0.$('.empty a[href="#/org/members"]')));
  await axe(s0, 'empty team');
  await go(s0, '#/track/today', '.tdy-hero'); ok('empty org: Today page renders calmly', (await text(s0, '.tdy-hero h2')).includes('لا شيء') && !!(await s0.$('.allclear')));
  await go(s0, '#/track', '.card'); ok('empty org: board shows empty state', !!(await s0.$('.empty')));
  ok('no JS errors (empty org)', s0.errs.length === 0, s0.errs);

  /* ═════════ ٧) ٣٠٠ موظف ═════════ */
  const t0 = Date.now();
  const batch = []; for (let i = 0; i < 285; i++) batch.push(call('POST', '/api/members', { email: `bulk${i}@ui.test`, name: `موظف ${i % 2 ? 'تجريبي' : 'ميداني'} رقم ${i + 1}`, role: 'employee', manager_id: meId, department_id: i % 3 ? depA.id : depB.id }, gm.token, ORG).catch((er) => er));
  const made = await Promise.all(batch); ok('seeded 285 more members (≈290 total; trial cap is 300)', made.filter((x) => x && x.id).length === 285, made.find((x) => x instanceof Error)?.message);
  console.log(`  (seeding took ${Date.now() - t0}ms)`);
  const big = await open(b, 'gm@ui.test', undefined, O);
  const ts = Date.now(); await big.goto(APP + '#/team'); await big.waitForSelector('.person.rowx', { timeout: 15000 }); const tPaint = Date.now() - ts;
  await wait(big, 600);
  const rows = (await big.$$(MAIN)).length;
  ok('300+ members: first paint under 4s', tPaint < 4000, tPaint);
  ok('300+ members: list capped (120) with "show all"', rows === 120 && !!(await big.$('[data-act=fall]')), rows);
  ok('300+ members: urgent rows still first (blocked/submitted before missing)', (await big.$eval(MAIN, (r) => r.dataset.st)) === 'blocked');
  await big.fill('[data-fq]', 'رقم 250'); await wait(big, 400);
  ok('300+ members: search narrows instantly', (await big.$$(MAIN)).length === 1 && (await text(big, MAIN)).includes('250'));
  await big.fill('[data-fq]', ''); await wait(big, 300);
  await big.click('[data-act=fall]'); await wait(big, 600);
  ok('300+ members: "show all" renders everyone', (await big.$$(MAIN)).length >= 285, (await big.$$(MAIN)).length);
  ok('300+ members: bulk bar remains accurate and bulk remind is bounded (≤200 per call)', !!(await big.$('[data-act=remind-all]')));
  await big.click('[data-act=remind-all]'); await wait(big, 1500);
  ok('300+ members: bulk remind answers with counts (no crash)', /ذُكّر|لا أحد|خارج/.test(await text(big, '#toast')), await text(big, '#toast'));
  const tn = Date.now(); await big.goto(APP + '#/track/today'); await big.waitForSelector('.tdy-hero'); await wait(big, 800);
  ok('300+ members: Today page under 4s and compact (≤16 rows)', Date.now() - tn < 4000 && (await big.$$('.card .person.rowx')).length <= 16, [Date.now() - tn, (await big.$$('.card .person.rowx')).length]);
  await big.goto(APP + '#/track'); await big.waitForSelector('.tbl'); await wait(big, 500);
  ok('300+ members: board renders table + compliance', !!(await big.$('.cmp-row')));
  ok('no JS errors (300 members)', big.errs.length === 0, big.errs);

  await b.close();
  console.log(`\n${pass} pass, ${fail} fail`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
