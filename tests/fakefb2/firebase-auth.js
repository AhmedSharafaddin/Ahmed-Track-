// مصادقة وهمية: المستخدم يُحدَّد من window.__fakeUser بعد تأخير window.__authDelay
export const getAuth = () => ({ currentUser: null });
export const onAuthStateChanged = (auth, cb) => { setTimeout(() => { auth.currentUser = window.__fakeUser ? { ...window.__fakeUser, getIdToken: async () => 'tok' } : null; cb(auth.currentUser); }, window.__authDelay ?? 300); return () => {}; };
export const signInWithEmailAndPassword = async () => {}; export const createUserWithEmailAndPassword = async () => {};
export const sendPasswordResetEmail = async () => {}; export const signOut = async () => {};
