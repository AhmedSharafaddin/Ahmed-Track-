// ITrack Service Worker: يحفظ واجهة التطبيق للفتح السريع ودون اتصال. البيانات لا تُحفظ هنا (تأتي من الخادم).
// ⚠️ ارفع VERSION عند أي تعديل على ملفات الواجهة.
const VERSION = 'it-v13';
const SHELL = ['./', './index.html', './styles.css', './config.js', './js/app.js', './js/core.js', './js/session.js', './js/track.js', './manifest.webmanifest', './icons/icon.svg', './fonts/readex-ar.woff2', './fonts/readex-latin.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // بيانات الخادم (/api/) لا تُخزَّن أبدًا: خاصة بصاحبها وتتغير (مهم حين يُخدم التطبيق والخادم من نفس العنوان)
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // الواجهة: الشبكة أولًا (تحديث فوري)، والمخزّن عند انقطاع الاتصال
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then((x) => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
