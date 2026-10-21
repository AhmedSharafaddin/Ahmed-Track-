// Service Worker: يجعل التطبيق يفتح ويعمل دون إنترنت، ويصل التحديث للأجهزة بشكل موثوق.
//
// آلية التحديث:
//  1) كل نشر جديد يرفع VERSION ⇒ يتغيّر sw.js ⇒ يكتشفه المتصفح (يُفحص عند كل فتح وعودة للتطبيق).
//  2) الإصدار الجديد يُنزّل كل الملفات دفعة واحدة في ذاكرة جديدة، متجاوزًا ذاكرة HTTP
//     (GitHub Pages يطلب من المتصفح حفظ الملفات ١٠ دقائق — بدون هذا قد تختلط ملفات قديمة بجديدة).
//  3) بعد اكتماله يتولّى فورًا، والصفحة تعيد تحميل نفسها مرة واحدة ⇒ تظهر النسخة الجديدة كاملة.
//
// القراءة: ملفات التطبيق من ذاكرة الإصدار الحالي (متّسقة ولا تختلط)، وإن لم توجد فمن الشبكة.
// مكتبة Firebase والخطوط (روابط بإصدار ثابت): من الذاكرة أولًا لتعمل المزامنة دون اتصال.
//
// ⚠️ عند أي تعديل على ملفات التطبيق: ارفع رقم VERSION — وإلا لن يصل التعديل للأجهزة المثبّت عليها.

const VERSION = 'cc-v3';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/model.js', './js/views.js', './js/store.js', './js/utils.js', './js/config.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' = من الخادم مباشرة، لا من ذاكرة المتصفح
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'cc-libs').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    e.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const key = req.mode === 'navigate' ? './index.html' : req;
        const cached = await cache.match(key, { ignoreSearch: true });
        if (cached) return cached;
        try {
          const res = await fetch(req, { cache: 'no-cache' });
          if (res.ok && req.mode !== 'navigate') cache.put(req, res.clone());
          return res;
        } catch {
          return (await cache.match('./index.html')) || Response.error();
        }
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
