// أدوات مساعدة عامة: معرّفات، تواريخ، تنسيق، أمان HTML.

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

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

const fmtShort = new Intl.DateTimeFormat('ar', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = new Intl.DateTimeFormat('ar', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short' });
const fmtNum = new Intl.NumberFormat('ar');

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
