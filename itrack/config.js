// إعداد ITrack.
// • firebaseConfig: الدخول فقط (Firebase Authentication المجاني). البيانات ليست في Firebase بل في خادم ITrack.
// • apiUrl: رابط Worker الخاص بـITrack على Cloudflare بعد نشره (خطوات README.md). null = لم يُنشر بعد.
export const firebaseConfig = {
  apiKey: 'AIzaSyCpTlAtL7Rkfj5sRh-cWXVcdgdx4ZVaWec',
  authDomain: 'track-b87ef.firebaseapp.com',
  projectId: 'track-b87ef',
  appId: '1:873398442659:web:9eef72f6dd453d23e5fd16',
};
export const apiUrl = 'https://itrack-api.sharafaddinahmed.workers.dev';
