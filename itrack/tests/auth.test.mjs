// الحسابات الداخلية + رموز الدعوة/إعادة التعيين + الذكاء الاصطناعي (مزوّد وهمي متوافق مع OpenAI)
// node --experimental-sqlite itrack/tests/auth.test.mjs
import { makeD1 } from './d1shim.mjs';
const W = (await import('../worker/worker.js')).default;
const realFetch = globalThis.fetch;
let aiCalls = [];
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.startsWith('https://ai.test/')) {
    aiCalls.push(url);
    if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'ذكرني بكرة الساعة عشرة الصبح أتصل بالمورد' }));
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(o.body);
      const isMin = body.messages[0].content.includes('محضر');
      const content = isMin
        ? JSON.stringify({ summary: 'نوقشت الشحنة.', attendees: ['سالم'], decisions: ['تأجيل الشحنة'], actions: [{ title: 'مراسلة المورد', owner: 'سالم', due: '2026-12-01' }], dates: [] })
        : JSON.stringify({ items: [{ kind: 'task', title: 'الاتصال بالمورد', due: '2026-11-08', time: '10:00', area: 'العمل' }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }
  }
  return realFetch(u, o);
};
let pass = 0, failN = 0;
const ok = (n, v, x) => { if (v) { pass++; console.log('PASS', n); } else { failN++; console.log('FAIL', n, JSON.stringify(x ?? '').slice(0, 400)); } };
const mk = (env) => async (tok, method, path, body, org, raw) => {
  const headers = {};
  if (tok) headers.authorization = 'Bearer ' + tok;
  if (org) headers['x-org'] = org;
  if (body && !raw) headers['content-type'] = 'application/json';
  const res = await W.fetch(new Request('https://api.test' + path, { method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, data: await res.json() };
};

/* ───── وضع الدعوة (سيرفر شركة) ───── */
const env = { DB: makeD1(), SIGNUP: 'invite', PBKDF2_ITERS: '10000', AUTH_FIREBASE: '0', AI_URL: 'https://ai.test/v1', AI_KEY: 'k' };
const call = mk(env);
let r = await call(null, 'GET', '/api/health');
ok('health: local auth, invite mode, ai via openai', r.data.auth === 'local' && r.data.signup === 'invite' && r.data.ai === 'openai', r.data);
ok('signup: weak password rejected', (await call(null, 'POST', '/api/auth/signup', { email: 'boss@co.test', password: '123' })).data.error === 'weak-password');
r = await call(null, 'POST', '/api/auth/signup', { email: 'Boss@Co.test', password: 'secret-pass-1' });
ok('signup: first account allowed in invite mode', r.status === 200 && r.data.token.startsWith('it_') && r.data.user.email === 'boss@co.test', r.data);
const boss = r.data.token;
ok('signup: second account blocked in invite mode', (await call(null, 'POST', '/api/auth/signup', { email: 'x@co.test', password: 'secret-pass-1' })).data.error === 'invite-only');
ok('session: /api/me works', (await call(boss, 'GET', '/api/me')).data.email === 'boss@co.test');
ok('session: forged token rejected', (await call('it_' + 'A'.repeat(43), 'GET', '/api/me')).status === 401);
ok('firebase tokens disabled', (await call('a.b.c', 'GET', '/api/me')).status === 401);
r = await call(boss, 'POST', '/api/orgs', { name: 'شركة', my_name: 'المدير' });
ok('first account creates org', r.status === 200, r.data);
const ORG = r.data.id;
ok('db stores only session hash', !(await env.DB.prepare('SELECT th FROM sessions').all()).results.some((x) => x.th === boss));
ok('db stores no plain password', !JSON.stringify((await env.DB.prepare('SELECT * FROM accounts').all()).results).includes('secret-pass-1'));

// دعوة موظف
r = await call(boss, 'POST', '/api/members', { email: 'emp@co.test', name: 'سالم', role: 'employee' }, ORG);
ok('add member returns invite code', r.status === 200 && r.data.kind === 'invite' && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.data.code), r.data);
const empId = r.data.id; let code = r.data.code;
ok('db stores only code hash', !(await env.DB.prepare('SELECT ch FROM codes').all()).results.some((x) => x.ch.includes(code.replace(/-/g, ''))));
ok('code: wrong email rejected', (await call(null, 'POST', '/api/auth/code', { email: 'other@co.test', code, password: 'emp-pass-123' })).data.error === 'bad-code');
ok('code: wrong code rejected', (await call(null, 'POST', '/api/auth/code', { email: 'emp@co.test', code: 'AAAA-AAAA-AAAA', password: 'emp-pass-123' })).data.error === 'bad-code');
r = await call(null, 'POST', '/api/auth/code', { email: 'EMP@co.test', code: code.toLowerCase().replace(/-/g, ' '), password: 'emp-pass-123' });
ok('code: invite creates account + joins org', r.status === 200 && r.data.org === ORG && r.data.kind === 'invite' && r.data.token, r.data);
const emp = r.data.token;
ok('joined employee sees org', (await call(emp, 'GET', '/api/bootstrap', null, ORG)).data.me?.id === empId);
ok('code: single use', (await call(null, 'POST', '/api/auth/code', { email: 'emp@co.test', code, password: 'emp-pass-123' })).data.error === 'bad-code');
ok('audit: join recorded', (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'member.join' AND entity_id = ?").bind(empId).first()).n === 1);

// مدعو آخر لا يكفيه تطابق البريد
r = await call(boss, 'POST', '/api/members', { email: 'emp2@co.test', name: 'علي', role: 'employee' }, ORG);
const emp2Id = r.data.id; const code2 = r.data.code;
// (لا يستطيع إنشاء حساب بلا رمز في وضع الدعوة، فنجرّب الوضع المفتوح أدناه)

// الدخول وحد المحاولات
ok('login: wrong password', (await call(null, 'POST', '/api/auth/login', { email: 'emp@co.test', password: 'nope-nope' })).data.error === 'bad-login');
r = await call(null, 'POST', '/api/auth/login', { email: 'emp@co.test', password: 'emp-pass-123' });
ok('login: correct password', r.status === 200 && r.data.token !== emp, r.data);
const emp_b = r.data.token;
for (let i = 0; i < 10; i++) await call(null, 'POST', '/api/auth/login', { email: 'boss@co.test', password: 'wrong-' + i });
ok('login: throttled after 10 failures', (await call(null, 'POST', '/api/auth/login', { email: 'boss@co.test', password: 'secret-pass-1' })).status === 429);

// إعادة التعيين من المسؤول
ok('reset code: employee cannot issue', (await call(emp, 'POST', `/api/members/${empId}/code`, {}, ORG)).status === 403);
r = await call(boss, 'POST', `/api/members/${empId}/code`, {}, ORG);
ok('reset code: admin issues for joined member', r.data.kind === 'reset', r.data);
r = await call(null, 'POST', '/api/auth/code', { email: 'emp@co.test', code: r.data.code, password: 'new-pass-456' });
ok('reset: sets new password', r.status === 200 && r.data.kind === 'reset', r.data);
ok('reset: old sessions revoked', (await call(emp_b, 'GET', '/api/me')).status === 401);
ok('reset: new password works', (await call(null, 'POST', '/api/auth/login', { email: 'emp@co.test', password: 'new-pass-456' })).status === 200);
const emp3 = r.data.token;

// تغيير كلمة المرور والخروج
ok('password change: wrong old', (await call(emp3, 'POST', '/api/auth/password', { old: 'x', password: 'another-789' })).data.error === 'bad-login');
ok('password change: ok', (await call(emp3, 'POST', '/api/auth/password', { old: 'new-pass-456', password: 'another-789' })).data.ok === true);
ok('logout', (await call(emp3, 'POST', '/api/auth/logout', {})).data.ok === true);
ok('logout: token dead', (await call(emp3, 'GET', '/api/me')).status === 401);

// إنشاء الجهات في وضع الدعوة: للمسؤولين فقط
r = await call(null, 'POST', '/api/auth/login', { email: 'emp@co.test', password: 'another-789' });
const emp4 = r.data.token;
ok('invite mode: employee cannot create org', (await call(emp4, 'POST', '/api/orgs', { name: 'x', my_name: 'y' })).status === 403);

/* ───── الذكاء الاصطناعي: طبقتان — الخادم (ربط المزوّد) والجهة (مفتاح المسؤول، معطّل افتراضيًا) ───── */
const wav = Buffer.from('RIFF....WAVEfmt fake audio').toString('base64');
const voicePath = '/api/ai/voice?ctx=' + encodeURIComponent(JSON.stringify({ today: '2026-11-07', areas: ['العمل'] }));
ok('ai: off by default per org (IT decides)', (await call(emp4, 'POST', '/api/ai/parse', { text: 'x' }, ORG)).data.error === 'feature-off');
ok('ai: org required (switch cannot be bypassed)', (await call(emp4, 'POST', '/api/ai/parse', { text: 'x' })).data.error === 'no-org');
ok('ai: only admin enables', (await call(emp4, 'PUT', '/api/settings', { feat: { ai: true } }, ORG)).status === 403);
ok('ai: admin enables', (await call(boss, 'PUT', '/api/settings', { feat: { ai: true } }, ORG)).data.feat?.ai === true);
r = await call(emp4, 'POST', voicePath, wav, ORG, true);
ok('ai voice: transcribe + parse', r.status === 200 && r.data.text.includes('المورد') && r.data.items[0].time === '10:00' && r.data.items[0].area === 'العمل', r.data);
ok('ai: calls go to configured provider', aiCalls.some((u) => u.endsWith('/audio/transcriptions')) && aiCalls.some((u) => u.endsWith('/chat/completions')));
r = await call(emp4, 'POST', '/api/ai/parse', { text: 'اتصل بالمورد بكرة', today: '2026-11-07', areas: ['العمل'] }, ORG);
ok('ai parse', r.data.items?.[0]?.title === 'الاتصال بالمورد', r.data);
r = await call(emp4, 'POST', '/api/ai/minutes', { text: 'اجتماع قصير ناقشنا فيه تأجيل الشحنة وسالم يراسل المورد', people: ['سالم'] }, ORG);
ok('ai minutes', r.data.decisions?.[0] === 'تأجيل الشحنة' && r.data.actions?.[0]?.owner === 'سالم', r.data);
ok('ai: bad audio rejected', (await call(emp4, 'POST', '/api/ai/transcribe', '!!!not base64', ORG, true)).status === 400);
ok('ai: requires login', (await call(null, 'POST', '/api/ai/parse', { text: 'x' }, ORG)).status === 401);
ok('ai: nothing stored', (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE data LIKE '%المورد%'").first()).n === 0);
ok('ai: enabling is audited', (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'settings.update'").first()).n === 1);
for (let i = 0; i < 25; i++) await call(emp4, 'POST', '/api/ai/minutes', { text: 'نص اجتماع طويل بما يكفي للاختبار' }, ORG);
ok('ai: daily limit enforced', (await call(emp4, 'POST', '/api/ai/minutes', { text: 'نص اجتماع طويل بما يكفي للاختبار' }, ORG)).status === 429);
await call(boss, 'PUT', '/api/settings', { feat: { ai: false } }, ORG);
ok('ai: admin switches off → refused immediately', (await call(emp4, 'POST', voicePath, wav, ORG, true)).data.error === 'feature-off');

/* ───── الوضع المفتوح (Cloudflare/تجربة) ───── */
const env2 = { DB: makeD1(), PBKDF2_ITERS: '10000' };
const c2 = mk(env2);
ok('open mode: no ai → health ai null', (await c2(null, 'GET', '/api/health')).data.ai === null);
const a = (await c2(null, 'POST', '/api/auth/signup', { email: 'a@x.test', password: 'pass-aaaa-1' })).data.token;
const ORG2 = (await c2(a, 'POST', '/api/orgs', { name: 'A', my_name: 'A' })).data.id;
r = await c2(a, 'POST', '/api/members', { email: 'b@x.test', name: 'B', role: 'employee' }, ORG2);
const bCode = r.data.code;
const b = (await c2(null, 'POST', '/api/auth/signup', { email: 'b@x.test', password: 'pass-bbbb-1' })).data.token;
ok('open mode: anyone can sign up', !!b);
r = await c2(b, 'GET', '/api/me');
ok('open mode: invitation visible by email', r.data.orgs.length === 1 && r.data.orgs[0].invited === true, r.data);
ok('open mode: email match alone does NOT join', (await c2(b, 'GET', '/api/bootstrap', null, ORG2)).data.error === 'need-code');
r = await c2(null, 'POST', '/api/auth/code', { email: 'b@x.test', code: bCode, password: 'wrong-password' });
ok('code: existing account must prove password', r.data.error === 'bad-login', r.data);
r = await c2(null, 'POST', '/api/auth/code', { email: 'b@x.test', code: bCode, password: 'pass-bbbb-1' });
ok('code: existing account joins with its password', r.status === 200 && r.data.org === ORG2, r.data);
ok('open mode: ai disabled → 501', (await c2(b, 'POST', '/api/ai/parse', { text: 'x' }, ORG2)).status === 501);
// حماية بين الجهات: مسؤول جهة أخرى لا يعيد كلمة مرور عضو مشترك
const c = (await c2(null, 'POST', '/api/auth/signup', { email: 'c@x.test', password: 'pass-cccc-1' })).data.token;
const ORG3 = (await c2(c, 'POST', '/api/orgs', { name: 'C', my_name: 'C' })).data.id;
r = await c2(c, 'POST', '/api/members', { email: 'b@x.test', name: 'B', role: 'employee' }, ORG3);
const bInC = r.data.id;
await c2(null, 'POST', '/api/auth/code', { email: 'b@x.test', code: r.data.code, password: 'pass-bbbb-1' });
ok('cross-org: reset blocked for multi-org account', (await c2(c, 'POST', `/api/members/${bInC}/code`, {}, ORG3)).data.error === 'multi-org');

/* ───── الأقسام ───── */
const dep = (await c2(a, 'POST', '/api/departments', { name: 'المبيعات' }, ORG2)).data.id;
const dep2 = (await c2(a, 'POST', '/api/departments', { name: 'المالية' }, ORG2)).data.id;
r = await c2(a, 'POST', '/api/sections', { name: 'الموزعين', department_id: dep }, ORG2);
ok('section: admin creates', r.status === 200 && r.data.id, r.data);
const sec = r.data.id;
ok('section: bad department rejected', (await c2(a, 'POST', '/api/sections', { name: 'x', department_id: 'nope' }, ORG2)).status === 400);
ok('section: employee cannot create', (await c2(b, 'POST', '/api/sections', { name: 'x', department_id: dep }, ORG2)).status === 403);
ok('section: member must match department', (await c2(a, 'POST', '/api/members', { email: 'z@x.test', name: 'Z', role: 'employee', department_id: dep2, section_id: sec }, ORG2)).data.error === 'invalid');
r = await c2(a, 'POST', '/api/members', { email: 'z@x.test', name: 'Z', role: 'employee', department_id: dep, section_id: sec }, ORG2);
ok('section: member saved with section', r.status === 200, r.data);
r = await c2(a, 'GET', '/api/bootstrap', null, ORG2);
ok('section: in bootstrap + member field', r.data.sections.some((x) => x.id === sec && x.department_id === dep) && r.data.members.find((m) => m.email === 'z@x.test').section_id === sec, r.data.sections);
ok('section: rename + disable', (await c2(a, 'PATCH', `/api/sections/${sec}`, { name: 'الموزعون', active: false }, ORG2)).data.ok === true);
ok('section: other org cannot touch it', (await c2(c, 'PATCH', `/api/sections/${sec}`, { name: 'x' }, ORG3)).status === 404);
ok('section: audited', (await env2.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE entity = 'section'").first()).n === 2);

console.log(`\n${pass} pass, ${failN} fail`);
if (failN) process.exit(1);
