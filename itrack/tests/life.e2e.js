// التطبيق الموحّد: الاتزان وحلقة اليوم والمكتبة داخل «مهامي» فوق خادم ITrack الحقيقي (node:sqlite)، مع بقاء البيانات بعد إعادة التحميل.
//   node itrack/tests/life.e2e.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const path = require('path');
const PORT = 8900 + Math.floor(Math.random() * 90);
const ORIGIN = `http://localhost:${PORT}`; const BASE = `${ORIGIN}/itrack/`;
const srv = require('child_process').spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => srv.kill());
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const api = async (tok, method, p, body, org) => (await fetch(ORIGIN + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(org ? { 'x-org': org } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const g = await api(null, 'POST', '/api/auth/signup', { email: 'owner@biz.test', password: 'Passw0rd!' });
  const ORG = (await api(g.token, 'POST', '/api/orgs', { name: 'منشأة تجريبية', my_name: 'صاحب العمل' })).id;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(([s, o]) => { try { localStorage.setItem('it:session', JSON.stringify(s)); localStorage.setItem('it:org', JSON.stringify(o)); } catch {} }, [g, ORG]);
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errs.push('API ' + r.status() + ' ' + r.url()); });
  const w = (ms = 500) => p.waitForTimeout(ms);
  await p.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/balance'); await w(2500);
  ok('balance page inside unified app', await p.isVisible('.bal-hero'));
  ok('offers missing life areas', await p.isVisible('[data-act="life-areas"]'));
  await p.click('[data-act="life-areas"]'); await w(900);
  const rows = await p.$$('.bal-row');
  ok('five life areas after one tap', rows.length === 5, rows.length);
  ok('wheel drawn', await p.isVisible('svg.wheel'));
  for (let i = 0; i < 5; i++) { await p.click(`.bal-row:nth-child(${i + 1}) [data-v="${i === 2 ? 4 : 8}"]`); await w(250); }
  ok('score appears', (await p.textContent('.bal-hero')).includes('مؤشر الاتزان'));
  await p.click('.prow[data-act="library"]'); await w();
  await p.check('.lib-cat[open] [name=pick] >> nth=0'); await p.click('form[data-form=library] [type=submit]'); await w(900);
  await p.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/review'); await w(700);
  await p.fill('form[data-form=results] [name=r0]', 'إغلاق حسابات الشهر'); await p.click('form[data-form=results] [type=submit]'); await w(1500);
  // البقاء بعد إعادة التحميل ومسح الذاكرة المحلية (أي من الخادم)
  await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('cci:')) localStorage.removeItem(k); });
  await p.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/today'); await p.reload(); await w(2000);
  ok('week result restored from server', (await p.textContent('#view, main')).includes('إغلاق حسابات الشهر'));
  await p.goto(ORIGIN + '/Ahmed-Track-/itrack/my/#/balance'); await w(900);
  ok('wheel ratings restored from server', (await p.$$('.bal-rate button.on')).length === 5);
  const docs = await api(g.token, 'GET', '/api/p/tasks', null, ORG);
  ok('library task stored on server', JSON.stringify(docs).includes('الصلاة في أوقاتها'));
  ok('no page or API errors', errs.length === 0, errs.slice(0, 4));
  console.log(`\n${pass} pass, ${fail} fail`); await b.close(); process.exit(fail ? 1 : 0);
})();
