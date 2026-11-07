// إعداد ITrack.
// apiUrl: عنوان خادم ITrack.
//   • على سيرفر الشركة (itrack/server) يُخدم التطبيق والخادم من نفس العنوان ⇒ '' (لا شيء لتغييره).
//   • على GitHub Pages الخادم في Cloudflare Worker مستقل.
export const apiUrl = location.hostname === 'ahmedsharafaddin.github.io' ? 'https://itrack-api.sharafaddinahmed.workers.dev' : '';
