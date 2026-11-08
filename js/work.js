// المهام المسندة والواجبات داخل «مهامي» (عند التشغيل داخل ITrack فقط: window.CC_BACKEND).
// المهمة المسندة وثيقة عادية في مهام الموظف ⇒ تعمل عليها كل أدوات التطبيق (اليوم، المصفوفة، التركيز، الخطوات)،
// وهذه الوحدة تضيف ما يخص العمل: صور الإنجاز، والتعليقات، وتقسيم المهمة بالذكاء الاصطناعي.
// الحماية الحقيقية في الخادم؛ هنا تجربة استخدام فقط.
import { store } from './store.js';

const BK = globalThis.CC_BACKEND || null;
export const isWork = (t) => !!(BK && t?.asg);
export const FREQ_AR = { daily: 'يومي', weekly: 'أسبوعي', monthly: 'شهري' };
export const wk = { thread: new Map(), photos: new Map(), busy: new Set(), loading: new Set() };
let rerender = () => {};
export const onWork = (fn) => { rerender = fn; };

async function api(method, path, body, raw, type) {
  const token = await store.idToken();
  const org = BK?.org?.();
  if (!token || !org) throw Object.assign(new Error('سجّل الدخول من جديد.'), { code: 'signin' });
  const headers = { authorization: `Bearer ${token}`, 'x-org': org };
  if (raw) headers['content-type'] = type; else if (body) headers['content-type'] = 'application/json';
  let res;
  try { res = await fetch(BK.api + path, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) }); }
  catch { throw Object.assign(new Error('لا اتصال بالخادم. أعد المحاولة.'), { code: 'offline' }); }
  if (!res.ok) { let d = {}; try { d = await res.json(); } catch {} throw Object.assign(new Error(d.message || 'تعذّر الطلب.'), { code: d.error, status: res.status }); }
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : res.blob();
}

/** بعد تغيير يحسبه الخادم (الإنجاز ← بانتظار الاعتماد، الصور) نسحب النسخة الرسمية بسرعة بدل انتظار ٩٠ ثانية. */
export function syncSoon() {
  const pull = () => store.adapter?._pull?.();
  setTimeout(pull, 1500); setTimeout(pull, 4500);
}

/* ───── الصور: تُضغط في الجهاز (أبعد ضلع ١٦٠٠ بكسل، JPEG حتى ~٣٠٠ ك.ب) قبل الرفع ───── */
const MAX_SIDE = 1600; const TARGET = 300_000;
export async function compress(file) {
  if (!/^image\//.test(file.type)) throw new Error('اختر صورة.');
  const bmp = await (globalThis.createImageBitmap ? createImageBitmap(file) : new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(file); }));
  let side = MAX_SIDE; let q = 0.8; let blob = null;
  for (let i = 0; i < 6; i++) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', q));
    if (blob && blob.size <= TARGET) break;
    if (q > 0.55) q -= 0.12; else side = Math.round(side * 0.8);
  }
  bmp.close?.();
  if (!blob || blob.size > 390_000) throw new Error('الصورة كبيرة جدًا حتى بعد الضغط.');
  return blob;
}
export async function uploadPhoto(t, file) {
  if (wk.busy.has(t.id)) return null;
  wk.busy.add(t.id); rerender();
  try {
    const blob = await compress(file);
    const r = await api('POST', `/api/files?task=${encodeURIComponent(t.id)}`, null, blob, 'image/jpeg');
    wk.photos.set(r.id, URL.createObjectURL(blob));
    syncSoon();
    return r.id;
  } finally { wk.busy.delete(t.id); rerender(); }
}
export async function deletePhoto(fid) { await api('POST', `/api/files/${encodeURIComponent(fid)}/delete`, {}); syncSoon(); }
async function loadPhoto(fid) {
  if (wk.photos.has(fid) || wk.loading.has(fid)) return;
  wk.loading.add(fid);
  try { wk.photos.set(fid, URL.createObjectURL(await api('GET', `/api/files/${encodeURIComponent(fid)}`))); }
  catch { wk.photos.set(fid, ''); }
  finally { wk.loading.delete(fid); rerender(); }
}

/* ───── التعليقات ───── */
export async function loadThread(tid, force = false) {
  const cur = wk.thread.get(tid);
  if (!force && cur && (cur.loading || Date.now() - cur.at < 30_000)) return;
  wk.thread.set(tid, { ...(cur || { comments: [] }), loading: true, at: Date.now() });
  try {
    const d = await api('GET', `/api/task/me/${encodeURIComponent(tid)}`);
    wk.thread.set(tid, { comments: d.comments, trail: d.trail, at: Date.now() });
  } catch (e) { wk.thread.set(tid, { comments: cur?.comments || [], error: e.message, at: Date.now() }); }
  rerender();
}
export async function postComment(tid, body) {
  await api('POST', `/api/task/me/${encodeURIComponent(tid)}/comments`, { body });
  await loadThread(tid, true);
}
/** يملأ ما تحتاجه لوحة المهمة بعد رسمها: الصور والتعليقات. */
export function hydrate(t) {
  if (!isWork(t)) return;
  for (const fid of t.photos || []) loadPhoto(fid);
  loadThread(t.id);
}

/* ───── الذكاء الاصطناعي: تقسيم مهمة كبيرة (اقتراح تراجعه قبل الحفظ) ───── */
export const aiOn = () => !!BK?.ai;
export async function aiSteps(t) {
  const d = await api('POST', '/api/ai/steps', { title: t.title, desc: t.asg?.desc || t.notes || '' });
  return d.steps || [];
}
