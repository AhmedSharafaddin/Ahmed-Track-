// جلسة ITrack الداخلية (بلا Firebase): رمز it_… محفوظ على الجهاز، مشترك بين «العمل» و«مهامي» لأنهما من نفس الموقع.
// الرمز يُحفظ مجزّأً في الخادم ويُلغى عند الخروج أو تغيير كلمة المرور أو إعادة تعيينها.
const KEY = 'it:session';
const subs = new Set();
const read = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); return v && typeof v.token === 'string' ? v : null; } catch { return null; } };
let cur = read();
const emit = () => subs.forEach((f) => f(cur));
function set(v) {
  cur = v;
  try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch {}
  emit();
}
// خروج أو دخول في تبويب آخر ⇒ هذا التبويب يتبعه فورًا
addEventListener('storage', (e) => { if (e.key === KEY) { cur = read(); emit(); } });

export const session = () => cur;
export function onSession(cb) { subs.add(cb); queueMicrotask(() => cb(cur)); return () => subs.delete(cb); }
/** الخادم رفض الرمز (انتهى أو أُلغي) ⇒ نرجع لشاشة الدخول. */
export const expire = () => { if (cur) set(null); };

async function post(base, path, body, token) {
  let res;
  try {
    res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
  } catch { throw Object.assign(new Error('لا اتصال بالخادم.'), { code: 'offline' }); }
  let d = {};
  try { d = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(d.message || 'تعذّر الطلب.'), { code: d.error || 'http', status: res.status });
  return d;
}
const keep = (d) => { set({ token: d.token, uid: d.user.uid, email: d.user.email }); return d; };
export const login = (base, email, password) => post(base, '/api/auth/login', { email, password }).then(keep);
export const signup = (base, email, password) => post(base, '/api/auth/signup', { email, password }).then(keep);
/** رمز دعوة أو إعادة تعيين من مسؤول الجهة. يعيد {org, kind}. */
export const redeem = (base, email, code, password) => post(base, '/api/auth/code', { email, code, password }).then(keep);
export const changePassword = (base, old, password) => post(base, '/api/auth/password', { old, password }, cur?.token);
export function logout(base) {
  const t = cur?.token;
  set(null);
  if (t) post(base, '/api/auth/logout', {}, t).catch(() => {});
}
