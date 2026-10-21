// إعدادات المزامنة السحابية (Firebase).
//
// • اتركها null ⇒ يعمل التطبيق محليًا فقط على الجهاز الحالي (دون حساب).
// • لتفعيل المزامنة بين اللابتوب والآيفون: أنشئ مشروع Firebase مجاني والصق
//   كائن firebaseConfig هنا بدل null — الخطوات كاملة في README.md.
//
// ملاحظة أمنية: هذه القيم ليست أسرارًا (تظهر لأي متصفح يفتح التطبيق).
// الحماية الفعلية تأتي من قواعد Firestore (firestore.rules) وتسجيل الدخول.

export const firebaseConfig = null;

/* مثال على الشكل المطلوب:
export const firebaseConfig = {
  apiKey: '...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '...',
  appId: '...',
};
*/
