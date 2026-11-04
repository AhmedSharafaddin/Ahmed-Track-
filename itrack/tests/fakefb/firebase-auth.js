// دخول Firebase وهمي للاختبار: الحسابات في localStorage، والرموز يوقّعها خادم الاختبار (/__token) بمفتاح اختبار.
const users = () => JSON.parse(localStorage.getItem('fake:users') || '{}');
const saveUsers = (u) => localStorage.setItem('fake:users', JSON.stringify(u));
const mk = (rec) => rec && ({ uid: rec.uid, email: rec.email, emailVerified: !!rec.verified,
  getIdToken: async () => (await fetch(`/__token?uid=${rec.uid}&email=${encodeURIComponent(rec.email)}&v=${users()[rec.email]?.verified ? 1 : 0}`)).text() });
const listeners = [];
const auth = { currentUser: null };
function emit() { listeners.forEach((cb) => cb(auth.currentUser)); }
function setCur(rec) { auth.currentUser = mk(rec); if (rec) localStorage.setItem('fake:cur', rec.email); else localStorage.removeItem('fake:cur'); emit(); }
const err = (code) => Object.assign(new Error(code), { code });
export const getAuth = () => auth;
export const onAuthStateChanged = (a, cb) => { listeners.push(cb); setTimeout(() => { const e = localStorage.getItem('fake:cur'); auth.currentUser = e ? mk(users()[e]) : null; cb(auth.currentUser); }, 80); return () => {}; };
export const signInWithEmailAndPassword = async (a, email, pass) => { const u = users()[email.toLowerCase()]; if (!u || u.pass !== pass) throw err('auth/invalid-credential'); setCur(u); return { user: auth.currentUser }; };
export const createUserWithEmailAndPassword = async (a, email, pass) => { const all = users(); const e = email.toLowerCase(); if (all[e]) throw err('auth/email-already-in-use'); if (pass.length < 6) throw err('auth/weak-password'); all[e] = { uid: 'u-' + Math.random().toString(36).slice(2, 10), email: e, pass, verified: false }; saveUsers(all); setCur(all[e]); return { user: auth.currentUser }; };
export const sendEmailVerification = async () => { window.__verifySent = (window.__verifySent || 0) + 1; };
export const sendPasswordResetEmail = async () => {};
export const signOut = async () => setCur(null);
export const reload = async (u) => { const rec = users()[u.email]; auth.currentUser = mk(rec); };
// للاختبار: «فتح رابط التأكيد»
window.__verify = (email) => { const all = users(); all[email].verified = true; saveUsers(all); };
