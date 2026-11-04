// الهوية (Firebase Auth) والاتصال بخادم ITrack.
import { firebaseConfig, apiUrl } from '../config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
let A = null;
let auth = null;

export async function initAuth(onUser) {
  const [appM, authM] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js')]);
  A = authM;
  auth = A.getAuth(appM.initializeApp(firebaseConfig, 'itrack'));
  A.onAuthStateChanged(auth, onUser);
}
const authMsg = (e) => ({
  'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة.', 'auth/wrong-password': 'البريد أو كلمة المرور غير صحيحة.',
  'auth/user-not-found': 'لا حساب بهذا البريد. اختر «حساب جديد».', 'auth/email-already-in-use': 'لهذا البريد حساب بالفعل. اختر «دخول».',
  'auth/weak-password': 'كلمة المرور قصيرة: ٨ أحرف على الأقل.', 'auth/invalid-email': 'البريد غير صحيح.',
  'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.', 'auth/network-request-failed': 'لا اتصال بالإنترنت.',
  'auth/operation-not-allowed': 'إنشاء الحسابات مغلق في إعداد Firebase.',
}[e?.code] || 'تعذّر إتمام العملية. حاول مرة أخرى.');
const wrap = (p) => p.catch((e) => { throw Object.assign(new Error(authMsg(e)), { code: e?.code }); });

export const signIn = (email, pass) => wrap(A.signInWithEmailAndPassword(auth, email, pass));
export async function signUp(email, pass) {
  const cred = await wrap(A.createUserWithEmailAndPassword(auth, email, pass));
  await A.sendEmailVerification(cred.user).catch(() => {});
  return cred;
}
export const resendVerify = () => wrap(A.sendEmailVerification(auth.currentUser));
export const resetPassword = (email) => wrap(A.sendPasswordResetEmail(auth, email));
export const signOut = () => A.signOut(auth);
/** بعد الضغط على رابط التأكيد: نحدّث المستخدم والرمز حتى يرى الخادم أن البريد مؤكد. */
export async function refreshUser() {
  await A.reload(auth.currentUser);
  await auth.currentUser.getIdToken(true);
  return auth.currentUser;
}

export async function api(method, path, body, org) {
  if (!apiUrl) throw Object.assign(new Error('خادم ITrack لم يُربط بعد (apiUrl في config.js).'), { code: 'no-api' });
  const u = auth?.currentUser;
  if (!u) throw Object.assign(new Error('سجّل الدخول.'), { code: 'auth' });
  const headers = { authorization: `Bearer ${await u.getIdToken()}` };
  if (body) headers['content-type'] = 'application/json';
  if (org) headers['x-org'] = org;
  let res;
  try { res = await fetch(apiUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error('لا اتصال بالخادم. سيُعاد الحفظ تلقائيًا.'), { code: 'offline' }); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data.message || 'تعذّر الطلب.'), { code: data.error || 'http', status: res.status });
  return data;
}
