// التنبيهات: مسار واحد للتطبيق، ومحرّكان خلفه.
//  • محلي: والتطبيق مفتوح (أو مصغّر على اللابتوب) تُجدول التنبيهات القادمة خلال 24 ساعة بمؤقتات.
//  • خادم (Cloudflare Worker): يرسل التنبيه في وقته حتى والتطبيق مغلق — على الآيفون واللابتوب.
//    التطبيق يرسل له «الجدول» (buildSchedule) عند كل تغيير، والخادم يرسل ما حان وقته كل دقيقة.
// الجهاز المشترك في الخادم لا يستخدم المؤقتات المحلية ⇒ لا تنبيه مكرر.

import { store } from './store.js';
import { pushConfig } from './config.js';
import { buildSchedule } from './model.js';

const LS_PUSH = 'cc:push'; // '1' إن كان هذا الجهاز مشتركًا في الخادم
const base = () => (pushConfig?.url || '').replace(/\/$/, '');
const has = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function api(path, body) {
  const token = await store.idToken();
  if (!token) throw Object.assign(new Error('signin'), { code: 'signin' });
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status });
  return res.json().catch(() => ({}));
}

export const notify = {
  supported: typeof Notification !== 'undefined' && 'serviceWorker' in navigator,
  get serverReady() { return Boolean(base()) && typeof PushManager !== 'undefined'; },
  get permission() { return this.supported ? Notification.permission : 'unsupported'; },
  get pushed() { return has(LS_PUSH); },
  /** آيفون خارج الشاشة الرئيسية لا يدعم التنبيهات. */
  get needsInstall() { return /iP(hone|ad|od)/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches; },

  timers: new Map(),
  lastHash: '',

  /** يُستدعى من زر المستخدم فقط (المتصفحات تمنع الطلب التلقائي). */
  async enable() {
    if (!this.supported) return 'unsupported';
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return perm;
    if (this.serverReady && store.mode === 'cloud') {
      try { await this.subscribe(); } catch (e) { console.warn('push subscribe failed', e); return 'server-failed'; }
    }
    this.plan(true);
    return 'granted';
  },

  async subscribe() {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch(`${base()}/vapid`)).json();
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey) {
      const cur = new Uint8Array(sub.options.applicationServerKey);
      const want = b64urlToBytes(publicKey);
      if (cur.length !== want.length || cur.some((x, i) => x !== want[i])) { await sub.unsubscribe(); sub = null; }
    }
    sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
    await api('/subscribe', { subscription: sub.toJSON(), device: deviceLabel() });
    try { localStorage.setItem(LS_PUSH, '1'); } catch {}
    this.lastHash = '';
    await this.syncNow();
  },

  async disable() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager?.getSubscription();
      if (sub) { await api('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    } catch {}
    try { localStorage.removeItem(LS_PUSH); } catch {}
    this.clearTimers();
  },

  test() { return api('/test', {}); },

  /** يُستدعى بعد كل تغيير في البيانات: يجدول محليًا، ويرسل للخادم إن تغيّر الجدول. */
  plan(force = false) {
    if (!this.supported || Notification.permission !== 'granted') return;
    const items = buildSchedule();
    if (!this.pushed) this.planLocal(items);
    if (this.pushed && this.serverReady && store.mode === 'cloud') this.syncSoon(items, force);
  },

  clearTimers() { this.timers.forEach((t) => clearTimeout(t)); this.timers.clear(); },

  planLocal(items) {
    this.clearTimers();
    const now = Date.now();
    for (const it of items) {
      const ms = it.at - now;
      if (ms < -60_000 || ms > 24 * 3600_000) continue;
      this.timers.set(it.key, setTimeout(() => this.show(it), Math.max(0, ms)));
    }
  },

  async show(it) {
    if (Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(it.title, notificationOptions(it));
  },

  _t: 0,
  syncSoon(items, force) {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.syncNow(items, force), 2000);
  },

  async syncNow(items = buildSchedule(), force = false) {
    // الجدول يتغيّر بالدقيقة لا بالثانية ⇒ نقارن بصمة المحتوى لتجنّب طلبات لا داعي لها
    const hash = JSON.stringify(items.map((i) => [i.key, i.at, i.title, i.body]));
    if (!force && hash === this.lastHash) return;
    try {
      await api('/schedule', { items, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      this.lastHash = hash;
    } catch (e) {
      console.warn('schedule sync failed', e);
      if (e.code === 401 || e.code === 404 || e.code === 410) { try { localStorage.removeItem(LS_PUSH); } catch {} }
    }
  },
};

/** نفس خيارات العرض للتنبيه المحلي ولتنبيه الخادم (تُكرَّر في sw.js). */
export function notificationOptions(it) {
  const task = it.kind === 'task';
  return {
    body: it.body,
    tag: it.key,
    renotify: true,
    requireInteraction: task,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: it.url || '#/today' },
    actions: task ? [{ action: 'start', title: 'ابدأ الآن' }, { action: 'snooze', title: 'أجّل 15 دقيقة' }] : [],
  };
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'آيفون';
  if (/iPad/.test(ua)) return 'آيباد';
  if (/Android/.test(ua)) return 'أندرويد';
  if (/Windows/.test(ua)) return 'ويندوز';
  if (/Mac/.test(ua)) return 'ماك';
  return 'جهاز';
}
