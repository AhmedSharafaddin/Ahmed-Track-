// الهوية (حسابات ITrack الداخلية) والاتصال بخادم ITrack.
import { apiUrl } from '../config.js';
import { onSession, session, expire, login, signup, redeem, changePassword as chPass, logout } from './session.js';

const toUser = (s) => (s ? { uid: s.uid, email: s.email, emailVerified: true } : null);
export async function initAuth(onUser) { onSession((s) => onUser(toUser(s))); }
export const signIn = (email, pass) => login(apiUrl, email, pass);
export const signUp = (email, pass) => signup(apiUrl, email, pass);
export const redeemCode = (email, code, pass) => redeem(apiUrl, email, code, pass);
export const changePassword = (old, pass) => chPass(apiUrl, old, pass);
export const signOut = () => logout(apiUrl);

let health = null;
/** قدرات الخادم: نمط التسجيل (مفتوح/بدعوة) وتوفّر الذكاء الاصطناعي. */
export async function serverInfo() {
  if (!health) health = fetch(apiUrl + '/api/health').then((r) => r.json()).catch(() => { health = null; return {}; });
  return health;
}

export async function api(method, path, body, org) {
  if (apiUrl == null) throw Object.assign(new Error('خادم ITrack لم يُربط بعد (apiUrl في config.js).'), { code: 'no-api' });
  const s = session();
  if (!s) throw Object.assign(new Error('سجّل الدخول.'), { code: 'auth' });
  const headers = { authorization: `Bearer ${s.token}` };
  if (body) headers['content-type'] = 'application/json';
  if (org) headers['x-org'] = org;
  let res;
  try { res = await fetch(apiUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error('لا اتصال بالخادم. سيُعاد الحفظ تلقائيًا.'), { code: 'offline' }); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) expire();
  if (!res.ok) throw Object.assign(new Error(data.message || 'تعذّر الطلب.'), { code: data.error || 'http', status: res.status });
  return data;
}
