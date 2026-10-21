// أدوات مساعدة عامة: معرّفات، تواريخ، تنسيق، أمان HTML.

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// أرقام لاتينية صريحة: نفس الشكل على ويندوز (Chrome/Edge) والآيفون (Safari)
const LOCALE = 'ar-u-nu-latn';

const pad = (n) => String(n).padStart(2, '0');

/** مفتاح تاريخ محلي بصيغة YYYY-MM-DD (بتوقيت الجهاز، لا UTC). */
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

/** بداية الأسبوع = السبت (أسبوع العمل في اليمن). */
export const weekStart = (d = new Date()) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 1) % 7));
  return x;
};

export const weekKey = (d = new Date()) => dateKey(weekStart(d));

export const todayKey = () => dateKey();

const fmtShort = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const fmtNum = new Intl.NumberFormat(LOCALE);

export const fmtDate = (key) => (key ? fmtShort.format(parseKey(key)) : '');
export const fmtLongDate = (d = new Date()) => fmtLong.format(d);
export const fmtDayMonth = (d) => fmtDay.format(d);
export const n = (x) => fmtNum.format(x);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const now = () => new Date().toISOString();

/** مصفوفة أيزنهاور: تحديد الربع من علامتي العاجل/المهم. */
export const quadrant = (t) => (t.important ? (t.urgent ? 'q1' : 'q2') : t.urgent ? 'q3' : 'q4');

export const QUADRANTS = {
  q1: { label: 'افعلها الآن', hint: 'عاجل ومهم' },
  q2: { label: 'خطّط لها', hint: 'مهم وغير عاجل — هنا يُبنى المستقبل' },
  q3: { label: 'فوّضها أو اختصرها', hint: 'عاجل وغير مهم' },
  q4: { label: 'احذفها أو أجّلها', hint: 'لا عاجل ولا مهم' },
};

export const QUADRANT_ORDER = ['q1', 'q2', 'q3', 'q4'];

export const AREA_COLORS = ['#2f7d6d', '#b5832a', '#5b6bbf', '#a24d6b', '#3f8fb0', '#7a6a55'];

/* ───────── إضافات الإصدار ٢ ───────── */
export const keyAdd = (k, days) => dateKey(addDays(parseKey(k), days));
export const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);

/** التكرار (مثل Microsoft To Do): عند إنجاز مهمة متكررة تُنشأ النسخة التالية. */
export const REPEATS = {
  daily: 'يوميًا',
  workdays: 'أيام العمل (عدا الجمعة)',
  weekly: 'أسبوعيًا',
  monthly: 'شهريًا',
};

export function nextOccurrence(fromKey, repeat) {
  const d = parseKey(fromKey);
  if (repeat === 'daily') return keyAdd(fromKey, 1);
  if (repeat === 'weekly') return keyAdd(fromKey, 7);
  if (repeat === 'workdays') {
    let x = addDays(d, 1);
    while (x.getDay() === 5) x = addDays(x, 1); // الجمعة
    return dateKey(x);
  }
  if (repeat === 'monthly') {
    const last = new Date(d.getFullYear(), d.getMonth() + 2, 0).getDate();
    return dateKey(new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), last)));
  }
  return null;
}

/** وصف نسبي للتاريخ: اليوم، غدًا، أمس، وإلا التاريخ المختصر. */
export function relDay(k) {
  const diff = daysBetween(todayKey(), k);
  if (diff === 0) return 'اليوم';
  if (diff === 1) return 'غدًا';
  if (diff === -1) return 'أمس';
  return fmtDate(k);
}

export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('') || '؟';

/** لون ثابت لكل شخص مُسند إليه (من اسمه). */
export function personColor(name = '') {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 45% 45%)`;
}
