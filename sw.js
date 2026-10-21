// Service Worker: يجعل التطبيق يفتح ويعمل دون إنترنت.
// • ملفات التطبيق: من الذاكرة فورًا، مع تحديثها بالخلفية (stale-while-revalidate).
// • مكتبة Firebase (روابط بإصدار ثابت): من الذاكرة أولًا — لتعمل المزامنة دون اتصال.
// • غير ذلك (طلبات Firestore/المصادقة): يمر للشبكة كما هو.
// عند تغيير ملفات التطبيق جوهريًا: ارفع رقم VERSION.

const VERSION = 'cc-v1';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/store.js', './js/utils.js', './js/config.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'cc-libs').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(req, { ignoreSearch: true });
        const network = fetch(req)
          .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => cached || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error()));
        return cached || network;
      })
    );
    return;
  }

  const isLib = url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (isLib || isFont) {
    e.respondWith(
      caches.open('cc-libs').then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      })
    );
  }
});
