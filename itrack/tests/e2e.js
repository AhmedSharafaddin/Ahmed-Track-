// اختبار شامل للواجهة مع الخادم الحقيقي (node:sqlite، قاعدة جديدة في كل تشغيل) ودخول وهمي:
//   AXE=/path/axe.min.js node itrack/tests/e2e.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const AX = fs.readFileSync(process.env.AXE, 'utf8');
const OUT = process.env.OUT || '/tmp';
const PORT = Number(process.env.PORT) || 8800 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}/itrack/`;
const srv = process.env.PORT ? { kill() {} } : require('child_process').spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => srv.kill());
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
async function page(b, vp = { width: 1366, height: 900 }, theme = 'petrol') {
  const ctx = await b.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
  await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(firebase-[a-z]+\.js)/, (r) => { const f = r.request().url().match(/(firebase-[a-z]+\.js)/)[1]; r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fakefb', f)) }); });
  await ctx.addInitScript((t) => { try { if (!localStorage.getItem('it:theme')) localStorage.setItem('it:theme', JSON.stringify(t)); } catch {} }, theme);
  const p = await ctx.newPage(); p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errs.push(m.text()); });
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) p.errs.push('API ' + r.status() + ' ' + r.url()); });
  return p;
}
const wait = (p, ms = 350) => p.waitForTimeout(ms);
const axe = async (p, name) => { await p.addScriptTag({ content: AX }); const v = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((x) => [x.id, x.nodes.length, x.nodes[0].target.join(' ').slice(0, 80), ((x.nodes[0].any[0] || {}).message || '').slice(0, 120)])); ok('axe ' + name, !v.length, v); };
const text = (p, s) => p.$eval(s, (e) => e.textContent.replace(/\s+/g, ' ').trim());
async function join(p, email, pass = 'Passw0rd!') {
  await p.goto(BASE); await p.waitForSelector('[data-form=auth]');
  await p.click('[data-act=auth-tab][data-v=up]'); await p.waitForSelector('[data-form=auth][data-op=up]');
  await p.fill('[name=email]', email); await p.fill('[name=pass]', pass); await p.click('[data-form=auth] button[type=submit]');
  await p.waitForSelector('[data-act=verified]', { timeout: 8000 }).catch(async (e) => { console.log('JOIN FAIL', email, (await p.textContent('body')).replace(/\s+/g, ' ').slice(0, 300), p.errs); throw e; });
  await p.evaluate((e) => window.__verify(e.toLowerCase()), email);
  await p.click('[data-act=verified]'); await wait(p, 700);
}
(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  // ١) المسؤول: حساب، تأكيد، جهة، هيكل، أعضاء
  const gm = await page(b);
  await gm.goto(BASE); await gm.waitForSelector('[data-form=auth]');
  await axe(gm, 'auth screen');
  await gm.click('[data-act=auth-tab][data-v=up]'); await gm.waitForSelector('[data-form=auth][data-op=up]');
  await gm.fill('[name=email]', 'gm@org.test'); await gm.fill('[name=pass]', 'Passw0rd!'); await gm.click('[data-form=auth] button[type=submit]');
  await gm.waitForSelector('[data-act=verified]');
  ok('verify screen after signup', (await text(gm, 'h1')).includes('أكّد'));
  await gm.click('[data-act=verified]'); await wait(gm, 400);
  ok('unverified stays on verify', !!(await gm.$('[data-act=verified]')));
  await gm.evaluate(() => window.__verify('gm@org.test')); await gm.click('[data-act=verified]'); await gm.waitForSelector('[data-form=org]');
  ok('no org → create form', true);
  await gm.fill('[data-form=org] [name=name]', 'إدارة الخدمات اللوجستية'); await gm.fill('[data-form=org] [name=my_name]', 'أحمد');
  await gm.click('[data-form=org] button'); await gm.waitForSelector('.tabs'); await wait(gm, 500);
  ok('lands on structure/departments', gm.url().endsWith('#/org/departments'), gm.url());
  ok('sidebar shows admin nav', (await gm.$$eval('#nav a', (a) => a.map((x) => x.textContent))).join() === 'يومي,الفريق,الهيكل,السجل,الإعدادات');
  await gm.fill('[data-form=dep][data-id=""] [name=name]', 'اللوجستيات'); await gm.click('[data-form=dep][data-id=""] button'); await wait(gm, 500);
  ok('department added', (await gm.$$('.person')).length === 1);
  await gm.click('.tabs a[href="#/org/positions"]'); await wait(gm);
  await gm.click('[data-act=edit-pos][data-id=new]'); await wait(gm);
  await gm.fill('[data-form=position] [name=title]', 'أمين مخزن');
  await gm.selectOption('[data-form=position] [name=department_id]', { label: 'اللوجستيات' });
  await gm.fill('[data-form=position] [name=summary]', 'ضبط حركة المخزون ودقته');
  const rt = await gm.$$('[data-form=position] [name=rt]');
  await rt[0].fill('استلام الشحنات ومطابقتها مع الفواتير'); await rt[1].fill('تحديث سجل المخزون'); await rt[2].fill('إعداد تقرير الجرد الأسبوعي');
  await gm.fill('[data-form=position] .resp-row:nth-child(2) [name=rd]', 'يوميًا قبل نهاية الدوام');
  await gm.click('[data-form=position] button[type=submit]'); await wait(gm, 600);
  ok('position saved with 3 responsibilities', (await gm.$$('.jd li')).length === 3, await gm.$$eval('.jd li', (l) => l.map((x) => x.textContent)));
  await axe(gm, 'positions (petrol desk)');
  await gm.click('.tabs a[href="#/org/members"]'); await wait(gm);
  const addMember = async (email, name, role, mgrLabel, pos) => {
    const f = '[data-form=member][data-id=""]';
    await gm.fill(`${f} [name=email]`, email); await gm.fill(`${f} [name=name]`, name); await gm.selectOption(`${f} [name=role]`, role);
    if (mgrLabel) await gm.selectOption(`${f} [name=manager_id]`, { label: mgrLabel });
    await gm.selectOption(`${f} [name=department_id]`, { label: 'اللوجستيات' });
    if (pos) await gm.selectOption(`${f} [name=position_id]`, { label: pos });
    await gm.click(`${f} button[type=submit]`); await wait(gm, 600);
  };
  await addMember('sup@org.test', 'سالم', 'manager', 'أحمد (مسؤول الجهة)');
  await addMember('Sara@Org.test', 'سارة', 'employee', 'سالم (مدير)', 'أمين مخزن');
  ok('invite text shown for new member', (await text(gm, '.invite')).includes('sara@org.test'));
  ok('members listed', (await gm.$$('.card .people .person')).length === 3);
  await axe(gm, 'members (petrol desk)');
  await gm.screenshot({ path: `${OUT}/it_members.png` });

  // ٢) الموظفة: انضمام، تقرير، حفظ تلقائي، رفع
  const emp = await page(b, { width: 390, height: 844 });
  await join(emp, 'sara@org.test'); await emp.waitForSelector('#new-item');
  ok('employee lands on day, no team nav', !(await emp.$$eval('.tabbar a', (a) => a.map((x) => x.textContent))).includes('الفريق'));
  ok('employee sees her JD', (await emp.$$('.jd li')).length === 3);
  const add = async (t, resp, m) => { await emp.fill('#new-item', t); if (resp) await emp.selectOption('[data-form=add-item] [name=responsibility_id]', { label: resp }); if (m) await emp.selectOption('[data-form=add-item] [name=minutes]', String(m)); await emp.press('#new-item', 'Enter'); await wait(emp, 250); };
  await add('استلمت شحنة المورد وطابقتها مع الفاتورة', 'استلام الشحنات ومطابقتها مع الفواتير', 60);
  await add('حدّثت أرصدة الرف ب', 'تحديث سجل المخزون', 45);
  await add('تسليم الطابعة للفرع');
  ok('three items', (await emp.$$('.items .item')).length === 3);
  await emp.click('.items .item:nth-child(3) [data-act=state][data-v=blocked]'); await wait(emp, 200);
  await emp.fill('[data-k="bl-2"]', 'المورد لم يرسل القطعة');
  await emp.fill('[data-k=note]', 'نحتاج كراتين تغليف');
  await wait(emp, 1600);
  ok('autosaved', (await text(emp, '.saved')).includes('محفوظ'), await text(emp, '.saved'));
  await emp.reload(); await emp.waitForSelector('.items .item'); await wait(emp, 600);
  ok('draft persisted on server', (await emp.$$('.items .item')).length === 3 && (await emp.inputValue('[data-k="bl-2"]')) === 'المورد لم يرسل القطعة');
  await axe(emp, 'day editing (petrol mobile)');
  await emp.screenshot({ path: `${OUT}/it_day_mobile.png`, fullPage: true });
  await emp.click('[data-act=submit]'); await wait(emp, 800);
  ok('submitted + locked', (await text(emp, '.vh .st')).includes('مرفوع') && !(await emp.$('#new-item')));

  // ٣) المشرف: يرى، يعيد للتعديل
  const sup = await page(b, { width: 1366, height: 900 }, 'navy');
  await join(sup, 'sup@org.test'); await sup.waitForSelector('.kpis');
  ok('supervisor lands on team', sup.url().includes('#/team'));
  ok('kpi 1/1 submitted', (await text(sup, '.kpi b')).startsWith('1'));
  ok('row shows blocked tag', (await text(sup, '.card:not(.queue) .person')).includes('1 متعثّر'));
  ok('review queue lists the submitted report', (await sup.$$('.queue .person')).length === 1 && (await text(sup, '.queue')).includes('سارة'));
  ok('team nav shows review badge', (await text(sup, '#nav a[href="#/team"] em')) === '1');
  await axe(sup, 'team (navy desk)');
  await sup.click('a.person'); await sup.waitForSelector('[data-form=review]');
  ok('member report readable', (await sup.$$('.items .item')).length === 3 && (await text(sup, '.items')).includes('السبب'));
  await sup.click('[data-form=review] button[value=return]'); await wait(sup, 300);
  ok('return needs reason (client)', !!(await sup.$('[data-form=review] button[value=return]')));
  await sup.fill('[data-form=review] [name=comment]', 'اكتب رقم الشحنة في البند الأول');
  await sup.click('[data-form=review] button[value=return]'); await wait(sup, 700);
  ok('returned', (await text(sup, '.vh .st')).includes('مُعاد'));
  await axe(sup, 'member page (navy desk)');

  // ٤) الموظفة تعدّل وتعيد الرفع
  await emp.reload(); await emp.waitForSelector('.notice.warn'); await wait(emp, 400);
  ok('employee sees return reason', (await text(emp, '.notice.warn')).includes('رقم الشحنة'));
  await emp.fill('[data-k="it-0"]', 'استلمت الشحنة 4471 وطابقتها مع الفاتورة'); await wait(emp, 1500);
  await emp.click('[data-act=submit]'); await wait(emp, 800);
  ok('resubmitted', (await text(emp, '.vh .st')).includes('مرفوع'));

  // ٥) المسؤول يعتمد ويرى السجل
  await gm.goto(BASE + '#/team'); await gm.waitForSelector('.kpis'); await wait(gm, 500);
  ok('admin sees whole org (2)', (await gm.$$('.card:not(.queue) a.person')).length === 2);
  ok('admin queue shows resubmitted report', (await gm.$$('.queue .person')).length === 1);
  await gm.click('a.person:has-text("سارة")'); await gm.waitForSelector('[data-form=review]');
  await gm.fill('[data-form=review] [name=comment]', 'ممتاز'); await gm.click('[data-form=review] button[value=approve]'); await wait(gm, 700);
  ok('approved', (await text(gm, '.vh .st')).includes('معتمد'));
  const trail = await gm.$$eval('.trail li', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ')));
  ok('trail full story', trail.length === 5 && trail[0].includes('بدأ') && trail[2].includes('سالم') && trail[4].includes('اعتمد'), trail);
  ok('coverage counts (submitted only)', (await gm.$$eval('.jd .cnt', (c) => c.map((x) => x.textContent))).join('|').startsWith('1 · 1 س|1 · 45 د|لا شيء'), await gm.$$eval('.jd .cnt', (c) => c.map((x) => x.textContent)));
  await gm.screenshot({ path: `${OUT}/it_member_desk.png` });
  await gm.goto(BASE + '#/audit'); await gm.waitForSelector('.trail li'); await wait(gm, 300);
  ok('audit lists actions', (await gm.$$('.trail li')).length >= 10);
  await axe(gm, 'audit (petrol)');
  await gm.goto(BASE + '#/settings'); await wait(gm); await gm.click('[data-act=theme][data-v=aqua]'); await wait(gm);
  await gm.goto(BASE + '#/team'); await gm.waitForSelector('.kpis'); await wait(gm, 400);
  await axe(gm, 'team (aqua desk)');
  await gm.screenshot({ path: `${OUT}/it_team_aqua.png` });
  await emp.goto(BASE + '#/day'); await wait(emp, 600); await axe(emp, 'day approved (petrol mobile)');
  await emp.goto(BASE + '#/team'); await wait(emp, 500);
  ok('employee blocked from team page', (await text(emp, '.wrap')).includes('ليست ضمن صلاحياتك'));
  for (const [n, p] of [['gm', gm], ['emp', emp], ['sup', sup]]) ok(`no errors (${n})`, !p.errs.length, p.errs);
  await b.close();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
