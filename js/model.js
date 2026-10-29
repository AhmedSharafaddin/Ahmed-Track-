// المنطق: محددات البيانات والعمليات. لا HTML هنا.
//
// حقول المهمة (كلها اختيارية — البيانات القديمة تعمل كما هي):
//   steps[] {id,title,done}    خطوات صغيرة
//   repeat                      daily | workdays | weekly | monthly | null
//   assignee/assignedAt/followUp  الإسناد والمتابعة
//   nextId                      النسخة التالية التي أنشأها التكرار
//   time       'HH:MM'          وقت الموعد (اختياري)
//   remind     null | 0 | 15 | 60 | 'morning'   التذكير: عند الموعد / قبله بدقائق / صباح يوم الموعد
//   intent     نص                «متى وأين سأبدأ؟» — يظهر في التنبيه نفسه (نية التنفيذ)
//   est        دقائق              تقدير الوقت — يُستخدم لحساب حِمل اليوم
//   snoozes / snoozeUntil       التأجيل من التنبيه (يُعدّ ويظهر)
// الإعدادات المتزامنة بين الأجهزة: مستند reviews/_settings (بلا مجموعة جديدة في Firestore).

import { store } from './store.js';
import { uid, todayKey, keyAdd, daysBetween, parseKey, quadrant, QUADRANT_ORDER, nextOccurrence } from './utils.js';

export const MAX_FOCUS = 3;
export const S = () => store.state;

/* ───────── ذاكرة المحددات: تُحسب مرة لكل تغيير في البيانات أو اليوم ───────── */
let memoKey = '';
let memo = new Map();
function M(key, fn) {
  const k = `${store.rev}|${todayKey()}`;
  if (k !== memoKey) { memoKey = k; memo = new Map(); }
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
}
const index = (coll) => M(`idx:${coll}`, () => new Map(S()[coll].map((x) => [x.id, x])));

/* ───────── محددات ───────── */
export const areas = () => M('areas', () => [...S().areas].sort((a, b) => (a.order || 0) - (b.order || 0)));
export const areaById = (id) => (id ? index('areas').get(id) : undefined);
export const goalById = (id) => (id ? index('goals').get(id) : undefined);
export const taskById = (id) => (id ? index('tasks').get(id) : undefined);
export const isOpen = (t) => t.status !== 'done';
export const openTasks = () => M('open', () => S().tasks.filter(isOpen));
export const isWaiting = (t) => t.status === 'waiting';
// «بانتظار الاعتماد» لا يُحسب تأخيرًا عليك: الكرة عند غيرك، ومتابعته عبر موعد المتابعة.
export const isOverdue = (t) => !!t.due && isOpen(t) && !isWaiting(t) && t.due < todayKey();
export const isFocus = (t) => t.focusDate === todayKey();
export const hasArea = (t) => !!t.areaId && !!areaById(t.areaId);

export const byPriority = (a, b) =>
  QUADRANT_ORDER.indexOf(quadrant(a)) - QUADRANT_ORDER.indexOf(quadrant(b)) ||
  (a.due || '9999').localeCompare(b.due || '9999') ||
  (a.time || '99').localeCompare(b.time || '99') ||
  (a.createdAt || '').localeCompare(b.createdAt || '');

export const focusToday = () => M('focus', () =>
  S().tasks.filter(isFocus).sort((a, b) => (a.focusOrder || 0) - (b.focusOrder || 0)));

export const followDue = (t) => isOpen(t) && !!t.assignee && !!t.followUp && t.followUp <= todayKey();

export const alsoToday = () => M('also', () =>
  openTasks()
    .filter((t) => !isFocus(t) && !isWaiting(t) && ((t.due && t.due <= todayKey()) || followDue(t)))
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99') || byPriority(a, b)));

export const doneToday = () => M('doneToday', () =>
  S().tasks.filter((t) => !isOpen(t) && (t.completedAt || '').slice(0, 10) === todayKey())
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')));

export function score(t) {
  const w = { q1: 40, q2: 30, q3: 14, q4: 4 }[quadrant(t)];
  let s = w;
  if (t.due) {
    const d = daysBetween(todayKey(), t.due);
    s += d < 0 ? 26 : d === 0 ? 22 : d <= 3 ? 10 : 0;
  }
  s += Math.min(t.slips || 0, 4) * 5 + Math.min(t.snoozes || 0, 3) * 3;
  if (t.goalId && goalById(t.goalId)) s += 8;
  if (t.assignee) s -= 18;
  if (t.est && t.est <= 15) s += 3; // البداية السهلة تكسر الجمود
  return s;
}

export const suggestions = (limit = 5) => M(`sug:${limit}`, () =>
  openTasks().filter((t) => !isFocus(t) && !isWaiting(t)).sort((a, b) => score(b) - score(a) || byPriority(a, b)).slice(0, limit));

export const goalTasks = (g) => M(`gt:${g.id}`, () => S().tasks.filter((t) => t.goalId === g.id));
export function goalProgress(g) {
  const ts = goalTasks(g);
  const done = ts.filter((t) => !isOpen(t)).length;
  return { done, total: ts.length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
}

export const people = () => M('people', () => {
  const m = new Map();
  for (const t of S().tasks) if (t.assignee) m.set(t.assignee, (m.get(t.assignee) || 0) + (isOpen(t) ? 1 : 0));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, open]) => ({ name, open }));
});

export const streak = () => M('streak', () => {
  const days = new Set(S().tasks.filter((t) => !isOpen(t) && t.focusDate).map((t) => t.focusDate));
  let k = days.has(todayKey()) ? todayKey() : keyAdd(todayKey(), -1);
  let c = 0;
  while (days.has(k)) { c++; k = keyAdd(k, -1); }
  return c;
});

/* ───────── الإعدادات المتزامنة ───────── */
export const SETTINGS_ID = '_settings';
export const DEFAULT_SETTINGS = { name: '', morning: '08:30', evening: '17:30', capacity: 6 };
export const settings = () => M('settings', () => ({ ...DEFAULT_SETTINGS, ...(S().reviews.find((r) => r.id === SETTINGS_ID) || {}) }));
export function saveSettings(patch) {
  const cur = S().reviews.find((r) => r.id === SETTINGS_ID) || { id: SETTINGS_ID };
  return store.put('reviews', { ...cur, ...patch, id: SETTINGS_ID });
}
export const isReviewDoc = (r) => /^\d{4}-\d{2}-\d{2}$/.test(r.id);

/* ───────── الحِمل والاتزان ───────── */
/** مهام كل يوم (المفتوحة): العدد والدقائق المقدّرة — للتقويم وحِمل اليوم. */
export const dayLoads = () => M('loads', () => {
  const m = new Map();
  for (const t of openTasks()) {
    if (!t.due) continue;
    const d = m.get(t.due) || { count: 0, minutes: 0, unknown: 0 };
    d.count++;
    if (t.est) d.minutes += t.est; else d.unknown++;
    m.set(t.due, d);
  }
  return m;
});

/** حِمل اليوم: الثلاث + المستحق اليوم، مقابل ساعات التركيز المتاحة. */
export const todayLoad = () => M('todayLoad', () => {
  const list = [...focusToday().filter(isOpen), ...alsoToday().filter((t) => !t.assignee)];
  const minutes = list.reduce((s, t) => s + (t.est || 0), 0);
  const unknown = list.filter((t) => !t.est).length;
  const cap = (Number(settings().capacity) || 6) * 60;
  return { minutes, unknown, cap, pct: Math.min(100, Math.round((minutes / cap) * 100)), over: minutes > cap };
});

/* ───────── القوائم الذكية ───────── */
export const SMART = {
  important: { name: 'هام', icon: 'star', filter: (t) => !!t.important },
  planned: { name: 'مخطط', icon: 'cal', filter: (t) => !!t.due },
  assigned: { name: 'المُسندة', icon: 'people', filter: (t) => !!t.assignee },
  inbox: { name: 'الوارد', icon: 'inbox', filter: (t) => !hasArea(t) },
};

export const listTasks = (key) => M(`list:${key}`, () => {
  if (SMART[key]) return S().tasks.filter(SMART[key].filter);
  return S().tasks.filter((t) => t.areaId === key);
});

export const counts = () => M('counts', () => {
  const c = { today: focusToday().filter(isOpen).length + alsoToday().length };
  const open = openTasks();
  for (const k of Object.keys(SMART)) c[k] = open.filter(SMART[k].filter).length;
  for (const t of open) if (t.areaId) c[t.areaId] = (c[t.areaId] || 0) + 1;
  c.all = open.length;
  c.waiting = open.filter(isWaiting).length;
  c.late = 0;
  for (const t of open) if (isOverdue(t)) { c.late++; if (t.areaId) c[`late:${t.areaId}`] = (c[`late:${t.areaId}`] || 0) + 1; }
  return c;
});

/* ───────── عمليات ───────── */
export function createTask(fields) {
  return store.put('tasks', {
    id: uid(), title: '', notes: '', areaId: null, goalId: null,
    urgent: false, important: false, due: null, status: 'todo',
    focusDate: null, focusOrder: 0, slips: 0, completedAt: null,
    steps: [], repeat: null, assignee: null, assignedAt: null, followUp: null,
    time: null, remind: null, intent: '', est: null, snoozes: 0, snoozeUntil: null,
    ...fields,
  });
}

export function updateTask(id, patch) {
  const t = taskById(id);
  if (!t) return null;
  if ('assignee' in patch) {
    const a = (patch.assignee || '').trim() || null;
    patch.assignee = a;
    if (a && a !== t.assignee) {
      patch.assignedAt = todayKey();
      if (!t.followUp && !('followUp' in patch)) patch.followUp = keyAdd(todayKey(), 2);
    }
    if (!a) { patch.assignedAt = null; patch.followUp = null; }
  }
  // تغيير الموعد أو التذكير يلغي أي تأجيل سابق من التنبيه
  if (('due' in patch && patch.due !== t.due) || ('time' in patch && patch.time !== t.time) || ('remind' in patch && patch.remind !== t.remind)) {
    patch.snoozeUntil = null;
  }
  return store.put('tasks', { ...t, ...patch });
}

export function toggleTask(id) {
  const t = taskById(id);
  if (!t) return null;
  const done = isOpen(t);
  const patch = { status: done ? 'done' : 'todo', completedAt: done ? new Date().toISOString() : null };

  if (done && t.repeat && !t.nextId) {
    const base = t.due || todayKey();
    const anchor = t.repeat === 'monthly' ? (t.repeatDay || parseKey(base).getDate()) : null;
    let next = nextOccurrence(base, t.repeat, anchor);
    while (next <= todayKey()) next = nextOccurrence(next, t.repeat, anchor);
    const copy = createTask({
      title: t.title, notes: t.notes, areaId: t.areaId, goalId: t.goalId,
      important: t.important, urgent: t.urgent, repeat: t.repeat, due: next, repeatDay: anchor,
      time: t.time || null, remind: t.remind ?? null, intent: t.intent || '', est: t.est || null,
      assignee: t.assignee, assignedAt: t.assignee ? todayKey() : null,
      followUp: t.assignee ? next : null,
      steps: (t.steps || []).map((s) => ({ ...s, id: uid(), done: false })),
    });
    patch.nextId = copy.id;
  }
  if (!done && t.nextId) {
    const nx = taskById(t.nextId);
    if (nx && isOpen(nx) && !nx.focusDate) store.remove('tasks', nx.id);
    patch.nextId = null;
  }
  updateTask(id, patch);

  if (done && isFocus(t)) {
    const left = focusToday().filter((x) => isOpen(x) && x.id !== id).length;
    return left === 0 ? 'أنجزت أولويات اليوم الثلاث. يوم رابح.' : `أحسنت. بقي ${left === 1 ? 'واحدة' : 'اثنتان'} لليوم.`;
  }
  if (done && t.repeat) return 'أُنجزت، وجُدولت النسخة التالية.';
  return null;
}

export const FULL_MSG = 'أولويات اليوم ثلاث فقط. أنجز واحدة أو أعدها للقائمة أولًا.';

export function focusPatch() {
  if (focusToday().length >= MAX_FOCUS) return null;
  return { focusDate: todayKey(), focusOrder: Date.now() };
}

export function rollover() {
  const today = todayKey();
  const stale = S().tasks.filter((t) => t.focusDate && t.focusDate < today && isOpen(t));
  stale.forEach((t) => store.put('tasks', { ...t, focusDate: null, slips: (t.slips || 0) + 1 }));
  return stale.length;
}

export function setWaiting(id, on) {
  const t = taskById(id);
  if (!t || !isOpen(t)) return;
  const patch = on ? { status: 'waiting', waitingSince: todayKey(), focusDate: null } : { status: 'todo', waitingSince: null };
  // عند الانتظار نضمن موعد متابعة حتى لا تضيع المهمة: بعد ٣ أيام إن لم يكن لها موعد.
  if (on && t.assignee && !t.followUp) patch.followUp = keyAdd(todayKey(), 3);
  updateTask(id, patch);
}

export function followedUp(id, days = 3) { updateTask(id, { followUp: keyAdd(todayKey(), days) }); }

/** تأجيل من التنبيه: دقائق، أو «غدًا». يُعدّ كل تأجيل. */
export function snooze(id, how) {
  const t = taskById(id);
  if (!t) return null;
  const snoozes = (t.snoozes || 0) + 1;
  if (how === 'tomorrow') {
    updateTask(id, { due: keyAdd(todayKey(), 1), snoozes, focusDate: isFocus(t) ? null : t.focusDate });
    return 'نُقلت إلى الغد.';
  }
  const ms = Number(how) * 60_000;
  store.put('tasks', { ...t, snoozeUntil: new Date(Date.now() + ms).toISOString(), snoozes });
  return `سأذكّرك بعد ${how >= 60 ? 'ساعة' : `${how} دقيقة`}.`;
}

/* ───────── الإضافة السريعة: رموز داخل النص ───────── */
export function parseQuick(text) {
  const out = { title: text, important: false, urgent: false, assignee: null, areaId: null, tokens: [] };
  let s = ` ${text} `;
  s = s.replace(/\s@([^\s@#!]+)/g, (_, name) => {
    out.assignee = name.replace(/_/g, ' ');
    out.tokens.push({ k: 'assignee', v: out.assignee });
    return ' ';
  });
  s = s.replace(/\s#([^\s@#!]+)/g, (m, q) => {
    const key = q.replace(/_/g, ' ');
    const a = areas().find((x) => x.name.startsWith(key)) || areas().find((x) => x.name.includes(key));
    if (!a) return m;
    out.areaId = a.id;
    out.tokens.push({ k: 'area', v: a.name, color: a.color, emoji: a.emoji });
    return ' ';
  });
  s = s.replace(/\s(!!|!)(?=\s)/g, (_, b) => {
    out.important = true;
    if (b === '!!') out.urgent = true;
    out.tokens.push({ k: 'prio', v: b === '!!' ? 'مهم وعاجل' : 'مهم' });
    return ' ';
  });
  out.title = s.replace(/\s+/g, ' ').trim();
  return out;
}

/* ───────── جدول التنبيهات ─────────
   يُبنى من البيانات الحالية ويُرسل لخادم التنبيهات (أو يُجدول محليًا والتطبيق مفتوح).
   كل عنصر: {key, at(ms), title, body, url, kind}. المفتاح ثابت ⇒ لا تكرار للتنبيه نفسه. */
const atMs = (dateKey, hhmm) => {
  const d = parseKey(dateKey);
  const [h, m] = (hhmm || '09:00').split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
export const taskFireAt = (t) => {
  if (!t.due || t.remind == null || t.remind === '') return null;
  const s = settings();
  if (t.remind === 'morning') return atMs(t.due, s.morning || '08:30');
  return atMs(t.due, t.time || '09:00') - Number(t.remind) * 60_000;
};

export function buildSchedule(nowMs = Date.now()) {
  const out = [];
  const horizon = nowMs + 21 * 864e5;
  const s = settings();
  const ok = (at) => at > nowMs - 60_000 && at < horizon;

  for (const t of openTasks()) {
    let at = taskFireAt(t);
    const sn = t.snoozeUntil ? Date.parse(t.snoozeUntil) : 0;
    if (at == null && sn > nowMs) at = sn; // تأجيل مهمة بلا تذكير (من تنبيه متابعة مثلًا) يصنع تذكيرًا
    if (at != null) {
      if (sn > at) at = sn;
      if (ok(at)) {
        const step = (t.steps || []).find((x) => !x.done);
        const body = t.snoozes >= 2
          ? `أجّلتها ${t.snoozes} مرات. صغّرها إلى خطوة واحدة الآن، أو أسندها.`
          : t.intent ? `قلت لنفسك: ${t.intent}` : step ? `ابدأ بـ: ${step.title}` : t.time ? `موعدها ${t.time}` : 'خمس دقائق تكفي للبدء.';
        out.push({ key: `t:${t.id}`, at, title: t.title, body, url: `#/task/${t.id}`, kind: 'task' });
        // تذكير ثانٍ بعد نصف ساعة: يُلغى تلقائيًا إن أُنجزت (يُعاد بناء الجدول عند كل تغيير)
        out.push({
          key: `n:${t.id}`, at: at + 30 * 60_000, title: `ما زالت تنتظرك: ${t.title}`,
          body: step ? `خطوة واحدة صغيرة: ${step.title}` : 'ابدأ خمس دقائق فقط، والباقي يأتي.', url: `#/task/${t.id}`, kind: 'task',
        });
      }
    }
    if (t.assignee && t.followUp) {
      const fa = atMs(t.followUp, '10:00');
      if (ok(fa)) out.push({ key: `f:${t.id}:${t.followUp}`, at: fa, title: `تابع مع ${t.assignee}`, body: t.title, url: `#/task/${t.id}`, kind: 'follow' });
    }
  }

  const today = todayKey();
  for (let i = 0; i < 7; i++) {
    const day = keyAdd(today, i);
    const dueCount = openTasks().filter((t) => t.due === day).length;
    if (s.morning) {
      const at = atMs(day, s.morning);
      if (ok(at)) {
        const focus = i === 0 ? focusToday().filter(isOpen) : [];
        out.push({
          key: `m:${day}`, at, kind: 'brief', url: '#/today',
          title: 'صباح الخير. ما الثلاث لهذا اليوم؟',
          body: focus.length ? focus.map((t, j) => `${j + 1}. ${t.title}`).join('\n')
            : dueCount ? `لديك ${dueCount} مستحقة. اختر ثلاثًا في دقيقتين.` : 'اختر ثلاثًا فقط، وابدأ بالأصعب.',
        });
      }
    }
    if (s.evening) {
      const at = atMs(day, s.evening);
      if (ok(at)) {
        const f = i === 0 ? focusToday() : [];
        const d = f.filter((t) => !isOpen(t)).length;
        out.push({
          key: `e:${day}`, at, kind: 'close', url: '#/today',
          title: 'أغلق يومك',
          body: f.length ? `أنجزت ${d} من ${f.length}. قرّر مصير الباقي واختر أولى الغد.` : 'دقيقتان: ما الذي أنجزته؟ وما أهم شيء غدًا؟',
        });
      }
    }
  }
  const cut = (x, n) => (x && x.length > n ? `${x.slice(0, n - 1)}…` : x);
  return out.sort((a, b) => a.at - b.at).slice(0, 200).map((x) => ({ ...x, title: cut(x.title, 180), body: cut(x.body, 480) }));
}

/* ───────── استيراد ملف الإعداد القديم — دمج لا استبدال ───────── */
export function convertSetupFile(data, areaMap) {
  const pri = { 4: { important: true, urgent: true }, 3: { important: true, urgent: false }, 2: { important: true, urgent: false }, 1: { important: false, urgent: false } };
  const goals = (data.projects || []).map((p) => ({
    id: `v3-${p.id}`, title: p.name, why: [p.desc, p.next ? `الخطوة التالية: ${p.next}` : ''].filter(Boolean).join('\n'),
    areaId: null, targetDate: p.target || null, status: p.status === 'active' ? 'active' : p.status === 'done' ? 'done' : 'paused',
  }));
  const goalArea = {};
  const tasks = (data.tasks || []).map((t) => {
    const areaId = areaMap[t.domainId] || null;
    if (t.projectId && !goalArea[t.projectId]) goalArea[t.projectId] = areaId;
    const notes = [t.desc, t.nextStep ? `الخطوة التالية: ${t.nextStep}` : '', t.notes, t.status === 'waiting' ? 'بانتظار رد جهة أخرى.' : ''].filter(Boolean).join('\n');
    return {
      id: `v3-${t.id}`, title: t.title, notes, areaId, goalId: t.projectId ? `v3-${t.projectId}` : null,
      ...(pri[t.priority] || pri[2]), due: t.due || null, status: t.status === 'done' ? 'done' : 'todo',
      completedAt: t.completedAt || null, focusDate: null, focusOrder: 0, slips: 0,
      steps: t.nextStep ? [{ id: uid(), title: t.nextStep, done: false }] : [],
      repeat: null, assignee: null, assignedAt: null, followUp: null, est: t.est || null, createdAt: t.createdAt,
    };
  });
  goals.forEach((g) => { g.areaId = goalArea[g.id.slice(3)] || null; });
  const series = (data.series || []).filter((s) => s.active !== false).map((s) => {
    let due = todayKey();
    for (let i = 0; i < 40; i++) {
      const d = parseKey(due);
      const ok = s.freq === 'monthly' ? d.getDate() === Math.min(s.monthDay || 1, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())
        : s.freq === 'weekly' ? (s.weekdays || []).includes(d.getDay()) : true;
      if (ok) break;
      due = keyAdd(due, 1);
    }
    return {
      id: `v3-${s.id}`, title: s.title, notes: '', areaId: areaMap[s.domainId] || null, goalId: s.projectId ? `v3-${s.projectId}` : null,
      ...(pri[s.priority] || pri[2]), due, status: 'todo', completedAt: null, focusDate: null, focusOrder: 0, slips: 0,
      steps: [], repeat: s.freq === 'monthly' ? 'monthly' : s.freq === 'daily' ? 'daily' : 'weekly',
      assignee: null, assignedAt: null, followUp: null, est: s.est || null,
    };
  });
  return { goals, tasks: [...tasks, ...series] };
}
