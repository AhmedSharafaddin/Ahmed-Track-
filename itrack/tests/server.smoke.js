// فحص خادم التثبيت (itrack/server/server.mjs): تشغيل حقيقي بقاعدة مؤقتة، ملفات، ضغط، أمان، نسخ احتياطي، وفتح الصفحتين في متصفح.
//   node itrack/tests/server.smoke.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const PORT = 9300 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'itrack-'));
const srv = spawn(process.execPath, [path.join(__dirname, '../server/server.mjs')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, PBKDF2_ITERS: '20000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
process.on('exit', () => srv.kill());
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const B = `http://localhost:${PORT}`;
const post = (p, body, tok) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
(async () => {
  for (let i = 0; i < 50 && !log.includes('ITrack:'); i++) await new Promise((r) => setTimeout(r, 100));
  ok('server starts', log.includes('ITrack:'), log);
  let r = await fetch(B + '/', { redirect: 'manual' });
  ok('root redirects to app', r.status === 302 && r.headers.get('location') === '/itrack/');
  r = await fetch(B + '/itrack/', { headers: { 'accept-encoding': 'br' } });
  ok('app html served (brotli, no-cache, CSP)', r.status === 200 && r.headers.get('content-encoding') === 'br' && r.headers.get('cache-control') === 'no-cache' && r.headers.get('content-security-policy').includes("default-src 'self'"));
  const et = (await fetch(B + '/js/app.js')).headers.get('etag');
  ok('etag revalidation → 304', (await fetch(B + '/js/app.js', { headers: { 'if-none-match': et } })).status === 304);
  for (const bad of ['/itrack/worker/worker.js', '/itrack/server/server.mjs', '/itrack/tests/e2e.js', '/CLAUDE.md', '/index.html/../CLAUDE.md', '/itrack/%2e%2e/CLAUDE.md', '/js/../CLAUDE.md']) {
    ok('blocked: ' + bad, (await fetch(B + bad, { redirect: 'manual' })).status !== 200);
  }
  r = await fetch(B + '/api/health'); const h = await r.json();
  ok('health: invite mode by default, local auth', h.signup === 'invite' && h.auth === 'local' && h.ai === null, h);
  r = await post('/api/auth/signup', { email: 'admin@co.test', password: 'Passw0rd!' });
  ok('first account', r.status === 200, r.data);
  ok('second signup blocked (invite only)', (await post('/api/auth/signup', { email: 'x@co.test', password: 'Passw0rd!' })).status === 403);
  ok('firebase tokens disabled on company server', (await fetch(B + '/api/me', { headers: { authorization: 'Bearer a.b.c' } })).status === 401);
  const tok = r.data.token;
  ok('org created', (await post('/api/orgs', { name: 'الشركة', my_name: 'أحمد' }, tok)).status === 200);
  const files = fs.readdirSync(path.join(DATA, 'backups'));
  ok('backup written at startup', files.some((f) => /^itrack-\d{4}-\d{2}-\d{2}\.db$/.test(f)), files);
  // المتصفح: الصفحتان تعملان تحت CSP بلا أي طلب خارجي
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext(); const p = await ctx.newPage(); const errs = []; const ext = [];
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('request', (q) => { if (!q.url().startsWith(B)) ext.push(q.url()); });
  await p.goto(B + '/itrack/'); await p.waitForSelector('[data-form=auth]');
  ok('auth screen hides «new account» in invite mode', !(await p.$('[data-act=auth-tab][data-v=up]')));
  await p.fill('[name=email]', 'admin@co.test'); await p.fill('[name=pass]', 'Passw0rd!'); await p.click('[data-form=auth] button[type=submit]');
  await p.waitForSelector('body[data-mode=app]', { timeout: 8000 });
  ok('login → app', true);
  await p.goto(B + '/itrack/my/'); await p.waitForSelector('#nav .ni', { timeout: 10000 }); await p.waitForTimeout(800);
  ok('my space works on company server', (await p.textContent('#nav')).includes('كل المهام'));
  await p.fill('input[placeholder^="أضف مهمة"]', 'مهمة على سيرفر الشركة'); await p.press('input[placeholder^="أضف مهمة"]', 'Enter'); await p.waitForTimeout(1800);
  const tasks = await fetch(B + '/api/p/tasks', { headers: { authorization: 'Bearer ' + await p.evaluate(() => JSON.parse(localStorage.getItem('it:session')).token), 'x-org': await p.evaluate(() => JSON.parse(localStorage.getItem('it:org'))) } }).then((x) => x.json());
  ok('task saved in local SQLite', tasks.docs?.some((d) => d.title === 'مهمة على سيرفر الشركة'), tasks);
  ok('no CSP/JS errors', !errs.length, errs);
  ok('no external requests (works offline from internet)', !ext.length, ext);
  await b.close();
  // نسخة احتياطية يدوية
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '../server/server.mjs'), 'backup'], { env: { ...process.env, DATA_DIR: DATA } }).toString();
  ok('backup command', out.includes('backup:'), out);
  console.log(`\n${pass} pass, ${fail} fail`);
  srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
