// يبني جهة عرض (Demo) على خادم ITrack قيد التشغيل بهيكل الشركة الحقيقي: ٧ إدارات و١٣ قسمًا (من جدولي أحمد).
//   node itrack/tools/seed-demo.mjs http://localhost:8080 [--reports] [--profile=asas|generic]  (الافتراضي: generic)
// • ما يُبنى: الإدارات والأقسام + المدير العام + المدير التنفيذي.
// • أعداد الموظفين في جدول الشركة مضخّمة (الفعلي نحو ٢٥) فلا يُبنى عليها. الأشخاص الحقيقيون ومسؤوليات الوظائف [TBD] حتى يصل التوصيف.
// • --reports: فريق تجريبي صغير (موظف أو اثنان لكل إدارة، أسماؤهم «موظف تجريبي») مع تقارير بنصوص عامة — للعرض فقط.
const base = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const withReports = process.argv.includes('--reports');
import { readFileSync } from 'node:fs';
// الملف الشخصي (profile) يفصل نسخة أسس عن النسخة المحايدة: --profile=asas | generic (الافتراضي generic حتى لا يتسرب هيكل أسس لجهة أخرى)
const pf = (process.argv.find((a) => a.startsWith('--profile=')) || '--profile=generic').slice(10);
const PROFILE = JSON.parse(readFileSync(new URL(`../profiles/${pf.replace(/[^a-z-]/g, '')}.json`, import.meta.url), 'utf8'));
const ORG_NAME = PROFILE.org, DEPS = PROFILE.deps;
const PASS = 'Demo-Pass-2026';
const call = async (m, p, b, tok, org) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(org ? { 'x-org': org } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${d.error || ''} ${d.message || ''}`); return d;
};
const gm = await call('POST', '/api/auth/signup', { email: 'gm@demo.test', password: PASS }).catch(async (e) => { if (/exists|invite-only/.test(e.message)) return call('POST', '/api/auth/login', { email: 'gm@demo.test', password: PASS }); throw e; });
const { id: org } = await call('POST', '/api/orgs', { name: ORG_NAME, my_name: 'المدير العام' }, gm.token);
const A = (p, b) => call('POST', p, b, gm.token, org);
const em = await A('/api/members', { email: 'exec@demo.test', name: 'المدير التنفيذي', role: 'manager' });
const me = (await call('GET', '/api/bootstrap', null, gm.token, org)).me;
await call('PATCH', `/api/members/${em.id}`, { manager_id: me.id }, gm.token, org);
const people = [{ email: 'exec@demo.test', code: em.code, id: em.id }];
let k = 0;
for (const [name, secs] of DEPS) {
  const dep = await A('/api/departments', { name }); k++;
  const ids = [];
  for (const sn of secs) ids.push((await A('/api/sections', { name: sn, department_id: dep.id })).id);
  if (!withReports) continue;
  const mgr = await A('/api/members', { email: `m${k}@demo.test`, name: `مدير تجريبي · ${name}`, role: 'manager', manager_id: em.id, department_id: dep.id, section_id: ids[0] });
  people.push({ email: `m${k}@demo.test`, code: mgr.code, id: mgr.id });
  for (let i = 0; i < Math.min(secs.length, 2); i++) {
    const e = await A('/api/members', { email: `e${k}-${i}@demo.test`, name: `موظف تجريبي ${i + 1} · ${name}`, role: 'employee', manager_id: mgr.id, department_id: dep.id, section_id: ids[i] });
    people.push({ email: `e${k}-${i}@demo.test`, code: e.code, id: e.id });
  }
}
console.log(`org=${org} إدارات=${DEPS.length} أقسام=${DEPS.reduce((t, d) => t + d[1].length, 0)} أعضاء=${people.length + 1}`);
if (withReports) {
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const today = day(0); let sub = 0;
  const TEXT = ['متابعة المهام اليومية للإدارة', 'إعداد ومراجعة المستندات', 'التنسيق مع الجهات ذات العلاقة', 'تحديث السجلات والبيانات', 'اجتماع متابعة مع الفريق'];
  for (const [idx, p] of people.entries()) {
    const s = await call('POST', '/api/auth/code', { email: p.email, code: p.code, password: PASS }).catch(() => null);
    if (!s || idx % 4 === 3) continue; // ~٢٥٪ لم يرفعوا
    for (const d of [today]) { // اليوم فقط (تقرير يوم سابق يُرفع متأخرًا فيظهر «متأخر»)
      const items = TEXT.slice(0, 2 + (idx % 3)).map((t, i) => ({ text: t, minutes: 30 + 15 * i, state: idx % 9 === 5 && i === 0 ? 'blocked' : i === 0 ? 'done' : 'progress', blocker: idx % 9 === 5 && i === 0 ? 'بانتظار موافقة أو مستند' : '' }));
      await call('PUT', `/api/report/${d}`, { today, items }, s.token, org).catch(() => {});
      if (idx % 5 !== 4) await call('POST', `/api/report/${d}/submit`, { today }, s.token, org).catch(() => {});
    }
    sub++;
  }
  console.log('تقارير تجريبية لـ', sub, 'عضوًا');
}
console.log('دخول المدير العام: gm@demo.test /', PASS, '— المدير التنفيذي: exec@demo.test (يدخل برمز الدعوة أو بعد --reports بنفس كلمة المرور)');
