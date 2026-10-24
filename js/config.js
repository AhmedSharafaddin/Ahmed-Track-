// إعدادات المزامنة السحابية (Firebase).
//
// • اتركها null ⇒ يعمل التطبيق محليًا فقط على الجهاز الحالي (دون حساب).
// • لتفعيل المزامنة بين اللابتوب والآيفون: أنشئ مشروع Firebase مجاني والصق
//   كائن firebaseConfig هنا بدل null — الخطوات كاملة في README.md.
//
// ملاحظة أمنية: هذه القيم ليست أسرارًا (تظهر لأي متصفح يفتح التطبيق).
// الحماية الفعلية تأتي من قواعد Firestore (firestore.rules) وتسجيل الدخول.

export const firebaseConfig = {
  apiKey: 'AIzaSyCpTlAtL7Rkfj5sRh-cWXVcdgdx4ZVaWec',
  authDomain: 'track-b87ef.firebaseapp.com',
  projectId: 'track-b87ef',
  storageBucket: 'track-b87ef.firebasestorage.app',
  messagingSenderId: '873398442659',
  appId: '1:873398442659:web:9eef72f6dd453d23e5fd16',
};

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

// خادم التنبيهات (Cloudflare Worker مجاني) — يرسل التنبيهات للجوال واللابتوب حتى والتطبيق مغلق.
// اتركه null ⇒ التنبيهات تعمل فقط والتطبيق مفتوح. خطوات التفعيل في worker/README.md.
export const pushConfig = { url: null };
