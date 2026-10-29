// Service Worker: فتح فوري ودون إنترنت، تحديث موثوق، واستقبال التنبيهات.
//
// آلية التحديث:
//  1) كل نشر جديد يرفع VERSION ⇒ يتغيّر sw.js ⇒ يكتشفه المتصفح (يُفحص عند كل فتح وعودة للتطبيق).
//  2) الإصدار الجديد يُنزّل كل الملفات دفعة واحدة في ذاكرة جديدة، متجاوزًا ذاكرة HTTP.
//  3) بعد اكتماله يتولّى فورًا، والصفحة تعيد تحميل نفسها مرة واحدة.
//
// القراءة: ملفات التطبيق والخط من ذاكرة الإصدار الحالي (فتح فوري دون شبكة)، وإن لم توجد فمن الشبكة.
// مكتبة Firebase (روابط بإصدار ثابت): من الذاكرة أولًا.
//
// ⚠️ عند أي تعديل على ملفات التطبيق: ارفع رقم VERSION — وإلا لن يصل التعديل للأجهزة المثبّت عليها.

const VERSION = 'cc-v6';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/model.js', './js/views.js', './js/store.js', './js/utils.js', './js/config.js',
  './js/picker.js', './js/notify.js', './js/dash.js',
  './fonts/readex-ar.woff2', './fonts/readex-latin.woff2',
  './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png', './icons/badge-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
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

  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
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

/* ───────── التنبيهات ───────── */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'مركز القيادة', body: e.data?.text() || '' }; }
  const task = d.kind === 'task';
  e.waitUntil(self.registration.showNotification(d.title || 'مركز القيادة', {
    body: d.body || '',
    tag: d.tag || d.url || 'cc',
    renotify: true,
    requireInteraction: task,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: d.url || '#/today' },
    actions: task ? [{ action: 'start', title: 'ابدأ الآن' }, { action: 'snooze', title: 'أجّل 15 دقيقة' }] : [],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let hash = e.notification.data?.url || '#/today';
  if (e.action && hash.startsWith('#/task/')) hash += `?a=${e.action}`;
  const target = new URL(`./${hash}`, self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // نفضّل نافذة التطبيق الكاملة على نافذة الـWidget الصغيرة
    const app = all.filter((c) => c.url.startsWith(self.registration.scope) && !c.url.includes('#/widget'));
    const win = app.find((c) => c.focused) || app.find((c) => c.visibilityState === 'visible') || app[0];
    if (win) {
      win.postMessage({ type: 'nav', hash });
      return win.focus();
    }
    return self.clients.openWindow(target);
  })());
});
