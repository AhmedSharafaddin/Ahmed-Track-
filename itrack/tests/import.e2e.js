// استيراد التوصيف الوظيفي من ملفات حقيقية (xlsx، docx، pdf عربي، csv) في متصفح حقيقي ثم الحفظ على الخادم.
//   AXE=/path/axe.min.js [PW=...] [CHROME=...] node itrack/tests/import.e2e.js
// الملفات في tests/fixtures (نص تجريبي عام، يولَّد بـ make-fixtures.py و make-pdf.js).
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const AX = fs.readFileSync(process.env.AXE, 'utf8');
const PORT = 8800 + Math.floor(Math.random() * 90);
const ORIGIN = `http://localhost:${PORT}`; const BASE = `${ORIGIN}/itrack/`;
const FX = (f) => path.join(__dirname, 'fixtures', f);
const srv = require('child_process').spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => srv.kill());
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 700)); } };
const api = async (tok, method, p, body, org) => { const r = await fetch(ORIGIN + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(org ? { 'x-org': org } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };
const axe = async (p, name) => { await p.addScriptTag({ content: AX }); const v = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((x) => [x.id, x.nodes.length, x.nodes[0].target.join(' ')])); ok(`axe AA: ${name}`, v.length === 0, v); };

const rowsOf = (p) => p.$$eval('.resp-row', (rs) => rs.map((r) => ({ t: r.querySelector('[name=rt]').value, d: r.querySelector('[name=rd]').value, f: r.querySelector('[name=rf]').value, p: r.querySelector('[name=rp]').value, e: r.querySelector('[name=re]').value })).filter((r) => r.t));
const TITLES = ['استلام الشحنات ومطابقتها مع أوامر الشراء', 'تسجيل حركة الصرف والإدخال في النظام', 'جرد عينة من الأصناف', 'إعداد تقرير الأصناف الراكدة', 'إغلاق الجرد الشهري ورفعه للإدارة'];
const FREQ = ['daily', 'daily', 'weekly', 'weekly', 'monthly'];

(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const g = await api(null, 'POST', '/api/auth/signup', { email: 'gm@x.test', password: 'Passw0rd!' });
  const ORG = (await api(g.token, 'POST', '/api/orgs', { name: 'جهة الاختبار', my_name: 'المدير العام' })).id;
  const dep = (await api(g.token, 'POST', '/api/departments', { name: 'إدارة المخازن' }, ORG)).id;
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(([s, o]) => { try { localStorage.setItem('it:session', JSON.stringify(s)); localStorage.setItem('it:org', JSON.stringify(o)); } catch {} }, [{ token: g.token, uid: g.user.uid, email: 'gm@x.test' }, ORG]);
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errs.push('API ' + r.status()); });
  const open = async () => { await p.goto(BASE + '#/org/positions'); await p.reload(); await p.waitForSelector('[data-imp-file], [data-act=edit-pos][data-id=new]', { timeout: 8000 }); const bt = await p.$('[data-act=edit-pos][data-id=new]'); if (bt) await bt.click(); await p.waitForSelector('[data-imp-file]'); };
  const upload = async (f, wait = 1800) => { const el = await p.$('[data-imp-file]'); await el.setInputFiles(typeof f === 'string' ? (path.isAbsolute(f) ? f : FX(f)) : f); await p.waitForFunction(() => { const o = document.querySelector('[data-imp-out]'); return o && o.textContent && !/يقرأ/.test(o.textContent); }, null, { timeout: 15000 }); };
  const check = (name, rows, o = {}) => {
    ok(`${name}: ٥ واجبات بعناوينها`, rows.length === 5 && TITLES.every((t, i) => rows[i].t === t), rows.map((r) => r.t));
    ok(`${name}: التكرار صحيح`, FREQ.every((f, i) => rows[i].f === f), rows.map((r) => r.f));
    if (o.prio) ok(`${name}: الأولوية صحيحة`, o.prio.every((x, i) => rows[i].p === String(x)), rows.map((r) => r.p));
    if (o.est) ok(`${name}: المدة صحيحة`, o.est.every((x, i) => rows[i].e === String(x)), rows.map((r) => r.e));
  };

  await open();
  await axe(p, 'نموذج الوظيفة مع كتلة الاستيراد (حاسوب)');
  // ١) xlsx: جدول بعناوين وورقة ثانية وصف المسمى
  await upload('jd.xlsx');
  let rows = await rowsOf(p);
  check('xlsx', rows, { prio: [3, 2, 2, 1, 3], est: [30, 45, 60, 90, 120] });
  ok('xlsx: التفاصيل من عمودها', rows[0].d === 'مطابقة الكميات والأصناف' && rows[4].d.includes('اليوم الخامس'), rows.map((r) => r.d));
  ok('xlsx: المسمى الوظيفي المقروء من الملف في الحقل', (await p.inputValue('[data-form=position] [name=title]')).includes('أمين مستودع'));
  ok('ملخص الاستيراد يذكر العدد والتكرار ويطلب المراجعة', /5 بندًا|٥ بندًا/.test(await p.textContent('[data-imp-out]')) && (await p.textContent('[data-imp-out]')).includes('راجعها'), await p.textContent('[data-imp-out]'));
  // ١ب) النموذج الرسمي: الفارغ لا يستورد شيئًا (لا ترقيم ولا تسمية عمود كعنوان)، والمعبَّأ يُقرأ بكل خاناته، وورقتا المثال والتعليمات لا تُستوردان
  const TPL = path.join(__dirname, '..', 'templates', 'jd-template.xlsx');
  await open(); await upload(TPL); rows = await rowsOf(p);
  const blankOut = await p.textContent('[data-imp-out]');
  ok('النموذج الفارغ: لا واجبات ولا عنوان/غرض مستورد من الملصقات', rows.length === 0 && (await p.inputValue('[data-form=position] [name=title]')) === '' && (await p.inputValue('[data-form=position] [name=summary]')) === '', [rows.length, blankOut]);
  ok('النموذج الفارغ: رسالة واضحة (لا انهيار)', /لم أجد/.test(blankOut), blankOut);
  await open(); await upload(FX('jd-template-filled.xlsx')); rows = await rowsOf(p);
  check('النموذج المعبَّأ', rows, { prio: [3, 2, 2, 1, 3], est: [30, 45, 60, 90, 120] });
  ok('النموذج المعبَّأ: معيار الإنجاز في التفاصيل', rows[0].d === 'مطابقة الكميات والأصناف' && rows[4].d.includes('اليوم الخامس'), rows.map((r) => r.d));
  ok('النموذج المعبَّأ: لا بنود من ورقة «مثال» (٥ فقط) ولا من «تعليمات»', rows.length === 5 && !rows.some((r) => /\[مثال|معيار|تعليمات/.test(r.t)), rows.map((r) => r.t));
  ok('النموذج المعبَّأ: المسمى والغرض', (await p.inputValue('[data-form=position] [name=title]')) === 'أمين مستودع' && (await p.inputValue('[data-form=position] [name=summary]')).includes('دقة المخزون'));
  ok('النموذج المعبَّأ: الإدارة «المخازن» طابقت «إدارة المخازن» تلقائيًا', (await p.inputValue('[data-form=position] [name=department_id]')) === dep, await p.inputValue('[data-form=position] [name=department_id]'));
  // رابط التنزيل يخدم الملف نفسه بنوعه الصحيح
  const dl = await p.$eval('.imp a[download]', (a) => a.href); const rr = await fetch(dl);
  ok('رابط تنزيل النموذج يعمل ويطابق الملف', rr.ok && Buffer.from(await rr.arrayBuffer()).equals(fs.readFileSync(TPL)), [rr.status, dl]);
  // ٢) docx نصي بعناوين التكرار + يستبعد المؤهلات
  await open(); await upload('jd.docx'); rows = await rowsOf(p); check('docx (نص بنقاط وعناوين)', rows);
  ok('docx: المؤهلات مستبعدة', !rows.some((r) => /بكالوريوس|خبرة/.test(r.t)));
  ok('docx: المسمى والغرض', (await p.inputValue('[data-form=position] [name=title]')).includes('أمين مستودع') && (await p.inputValue('[data-form=position] [name=summary]')).includes('دقة المخزون'));
  // ٣) docx جدول
  await open(); await upload('jd-table.docx'); rows = await rowsOf(p); check('docx (جدول)', rows, { prio: [3, 2, 2, 1, 3], est: [30, 45, 60, 90, 120] });
  // ٤) pdf عربي حقيقي: نص بنقاط ثم جدول
  await open(); await upload('jd.pdf'); rows = await rowsOf(p); if (rows.length !== 5) console.log('PDFOUT:', await p.textContent('[data-imp-out]')); check('pdf عربي (نص)', rows);
  ok('pdf: المؤهلات مستبعدة', !rows.some((r) => /بكالوريوس|خبرة/.test(r.t)), rows.map((r) => r.t));
  await open(); await upload('jd-table.pdf'); rows = await rowsOf(p); check('pdf عربي (جدول)', rows, { prio: [3, 2, 2, 1, 3], est: [30, 45, 60, 90, 120] });
  // ٥) csv بفاصلة منقوطة (UTF-8 مع BOM) وبترميز Windows-1256
  await open(); await upload('jd.csv'); rows = await rowsOf(p); check('csv (UTF-8 BOM, ;)', rows, { prio: [3, 2, 2, 1, 3], est: [30, 45, 60, 90, 120] });
  await open(); await upload('jd-1256.csv'); rows = await rowsOf(p); check('csv (Windows-1256)', rows);
  // ٦) لصق نص
  await open(); await p.click('.imp-paste summary'); await p.fill('[data-imp-text]', 'المهام اليومية:\n• فتح المستودع وتسجيل الحضور\nالمهام الأسبوعية:\n• جرد الرفوف'); await p.click('[data-act=imp-text]');
  await p.waitForFunction(() => document.querySelectorAll('.resp-row [name=rt]').length && [...document.querySelectorAll('.resp-row [name=rt]')].some((i) => i.value));
  rows = await rowsOf(p); ok('لصق نص: بندان بتكراريهما', rows.length === 2 && rows[0].f === 'daily' && rows[1].f === 'weekly', rows);
  // ٧) ملفات مرفوضة برسائل واضحة (لا انهيار)
  await open();
  const bomb = (() => { const big = Buffer.alloc(50 * 1024 * 1024); const body = zlib.deflateRawSync(big); const name = Buffer.from('word/document.xml'); const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(big.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(big.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + name.length, 12); eo.writeUInt32LE(30 + name.length + body.length, 16);
    return Buffer.concat([lh, name, body, cd, name, eo]); })();
  for (const [label, f, re] of [['xls قديم', { name: 'a.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('x') }, /قديمة/], ['xlsx تالف', { name: 'a.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a zip at all') }, /تالف|بالصيغة/],
    ['صيغة غير مدعومة', { name: 'a.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') }, /غير مدعومة/], ['قنبلة ضغط (٥٠MB)', { name: 'bomb.docx', mimeType: 'application/octet-stream', buffer: bomb }, /أكبر من المسموح/],
    ['PDF تالف', { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 garbage') }, /تعذّرت/]]) {
    await upload(f); const t = await p.textContent('[data-imp-out]'); ok(`رفض آمن: ${label}`, re.test(t) && (await rowsOf(p)).length === 0, t);
  }
  // ٧ب) حمولة XSS داخل الملف المستورد: تظهر نصًا ولا تُنفَّذ
  await open();
  await p.evaluate(() => { window.__xss = 0; });
  await upload({ name: 'evil.csv', mimeType: 'text/csv', buffer: Buffer.from('المهمة,التكرار\n"><img src=x onerror="window.__xss=1">,يومي\n<svg onload="window.__xss=1"></svg> مهمة,أسبوعي\n', 'utf8') });
  await p.waitForTimeout(500);
  const xs = await p.evaluate(() => ({ x: window.__xss, img: document.querySelectorAll('img[src="x"]').length, svg: document.querySelectorAll('svg[onload]').length, v: [...document.querySelectorAll('.resp-row [name=rt]')].map((i) => i.value) }));
  ok('XSS في الملف المستورد: لا تنفيذ، والنص حرفي في الحقل', xs.x === 0 && !xs.img && !xs.svg && xs.v.some((t) => t.includes('<img src=x')), xs);
  // ٨) الحفظ على الخادم: المستورد يُحفظ كما هو بعد مراجعة المستخدم
  await open(); await upload('jd.xlsx');
  await p.fill('[data-form=position] [name=title]', 'أمين مستودع (نموذج اختبار)'); await p.selectOption('[data-form=position] [name=department_id]', dep);
  await p.click('[data-form=position] button[type=submit]'); await p.waitForTimeout(1200);
  const bt = await api(g.token, 'GET', '/api/bootstrap', null, ORG); const pos = bt.positions.find((x) => x.title.includes('أمين'));
  const rs = (pos?.responsibilities || []).filter((r) => r.active);
  ok('محفوظ على الخادم: ٥ مسؤوليات بتكرار وأولوية ومدة', rs.length === 5 && rs[0].freq === 'daily' && rs[0].prio === 3 && rs[0].est === 30 && rs[4].freq === 'monthly' && rs[4].est === 120, rs);
  // ٩) جوال
  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await m.context().addInitScript(([s, o]) => { try { localStorage.setItem('it:session', JSON.stringify(s)); localStorage.setItem('it:org', JSON.stringify(o)); } catch {} }, [{ token: g.token, uid: g.user.uid, email: 'gm@x.test' }, ORG]);
  await m.goto(BASE + '#/org/positions'); await m.waitForSelector('[data-imp-file], [data-act=edit-pos][data-id=new]'); { const bt = await m.$('[data-act=edit-pos][data-id=new]'); if (bt) await bt.click(); } await m.waitForSelector('[data-imp-file]');
  await (await m.$('[data-imp-file]')).setInputFiles(FX('jd.xlsx')); await m.waitForFunction(() => document.querySelectorAll('.resp-row [name=rt]').length >= 5 && [...document.querySelectorAll('.resp-row [name=rt]')].filter((i) => i.value).length === 5, null, { timeout: 15000 });
  ok('جوال: لا تمرير أفقي بعد الاستيراد', await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await axe(m, 'نموذج الوظيفة بعد الاستيراد (جوال)');
  ok('لا أخطاء JS ولا 5xx', errs.length === 0, errs.slice(0, 5));
  await b.close();
  console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
