// المنطق: محددات البيانات والعمليات. لا HTML هنا.
// حقول أضافها الإصدار ٢ على المهمة (اختيارية — البيانات القديمة تعمل كما هي):
//   steps[]      خطوات صغيرة داخل المهمة {id, title, done}
//   repeat       daily | workdays | weekly | monthly | null
//   assignee     اسم الشخص المُسندة إليه
//   assignedAt   تاريخ الإسناد (YYYY-MM-DD)
//   followUp     موعد المتابعة القادم (YYYY-MM-DD)
//   nextId       معرّف النسخة التالية التي أنشأها التكرار
// لا مجموعات جديدة في Firestore: كل شيء داخل areas / goals / tasks / reviews.

import { store } from './store.js';
import { uid, todayKey, keyAdd, daysBetween, quadrant, QUADRANT_ORDER, nextOccurrence } from './utils.js';

export const MAX_FOCUS = 3;
export const S = () => store.state;

/* ───────── محددات ───────── */
export const areas = () => [...S().areas].sort((a, b) => (a.order || 0) - (b.order || 0));
export const areaById = (id) => S().areas.find((a) => a.id === id);
export const goalById = (id) => S().goals.find((g) => g.id === id);
export const taskById = (id) => S().tasks.find((t) => t.id === id);
export const isOpen = (t) => t.status !== 'done';
export const openTasks = () => S().tasks.filter(isOpen);
export const isOverdue = (t) => !!t.due && isOpen(t) && t.due < todayKey();
export const isFocus = (t) => t.focusDate === todayKey();
export const hasArea = (t) => !!t.areaId && !!areaById(t.areaId);

export const byPriority = (a, b) =>
  QUADRANT_ORDER.indexOf(quadrant(a)) - QUADRANT_ORDER.indexOf(quadrant(b)) ||
  (a.due || '9999').localeCompare(b.due || '9999') ||
  (a.createdAt || '').localeCompare(b.createdAt || '');

export const focusToday = () =>
  S().tasks.filter(isFocus).sort((a, b) => (a.focusOrder || 0) - (b.focusOrder || 0));

/** متابعة مستحقة لمهمة مُسندة. */
export const followDue = (t) => isOpen(t) && !!t.assignee && !!t.followUp && t.followUp <= todayKey();

/** «أيضًا اليوم»: المستحق اليوم أو المتأخر، والمتابعات المستحقة — خارج الثلاثة. */
export const alsoToday = () =>
  openTasks()
    .filter((t) => !isFocus(t) && ((t.due && t.due <= todayKey()) || followDue(t)))
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || byPriority(a, b));

export const doneToday = () =>
  S().tasks.filter((t) => !isOpen(t) && (t.completedAt || '').slice(0, 10) === todayKey())
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

/** درجة الترشيح لليوم: الربع + الموعد + الترحيل + الارتباط بهدف. */
export function score(t) {
  const w = { q1: 40, q2: 30, q3: 14, q4: 4 }[quadrant(t)];
  let s = w;
  if (t.due) {
    const d = daysBetween(todayKey(), t.due);
    s += d < 0 ? 26 : d === 0 ? 22 : d <= 3 ? 10 : 0;
  }
  s += Math.min(t.slips || 0, 4) * 5;
  if (t.goalId && goalById(t.goalId)) s += 8;
  if (t.assignee) s -= 18; // ما عند الآخرين ليس عملك اليوم
  return s;
}

export const suggestions = (limit = 5) =>
  openTasks().filter((t) => !isFocus(t)).sort((a, b) => score(b) - score(a) || byPriority(a, b)).slice(0, limit);

export const goalTasks = (g) => S().tasks.filter((t) => t.goalId === g.id);
export function goalProgress(g) {
  const ts = goalTasks(g);
  const done = ts.filter((t) => !isOpen(t)).length;
  return { done, total: ts.length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
}

export const people = () => {
  const m = new Map();
  for (const t of S().tasks) if (t.assignee) m.set(t.assignee, (m.get(t.assignee) || 0) + (isOpen(t) ? 1 : 0));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, open]) => ({ name, open }));
};

/** أيام متتالية أُنجزت فيها مهمة واحدة على الأقل من أولويات اليوم. */
export function streak() {
  const days = new Set(S().tasks.filter((t) => !isOpen(t) && t.focusDate).map((t) => t.focusDate));
  let k = days.has(todayKey()) ? todayKey() : keyAdd(todayKey(), -1);
  let c = 0;
  while (days.has(k)) { c++; k = keyAdd(k, -1); }
  return c;
}

/* ───────── القوائم الذكية (مثل To Do) ───────── */
export const SMART = {
  important: { name: 'هام', icon: 'star', filter: (t) => !!t.important },
  planned: { name: 'مخطط', icon: 'cal', filter: (t) => !!t.due },
  assigned: { name: 'المُسندة', icon: 'people', filter: (t) => !!t.assignee },
  inbox: { name: 'الوارد', icon: 'inbox', filter: (t) => !hasArea(t) },
};

export const listTasks = (key) => {
  if (SMART[key]) return S().tasks.filter(SMART[key].filter);
  return S().tasks.filter((t) => t.areaId === key);
};

export const counts = () => {
  const open = openTasks();
  const c = { today: focusToday().filter(isOpen).length + alsoToday().length };
  for (const k of Object.keys(SMART)) c[k] = open.filter(SMART[k].filter).length;
  for (const a of S().areas) c[a.id] = open.filter((t) => t.areaId === a.id).length;
  return c;
};

/* ───────── عمليات ───────── */
export function createTask(fields) {
  return store.put('tasks', {
    id: uid(), title: '', notes: '', areaId: null, goalId: null,
    urgent: false, important: false, due: null, status: 'todo',
    focusDate: null, focusOrder: 0, slips: 0, completedAt: null,
    steps: [], repeat: null, assignee: null, assignedAt: null, followUp: null,
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
  return store.put('tasks', { ...t, ...patch });
}

/** إنجاز/إلغاء إنجاز. المتكررة تولّد نسختها التالية مرة واحدة. يُرجع رسالة للمستخدم أو null. */
export function toggleTask(id) {
  const t = taskById(id);
  if (!t) return null;
  const done = isOpen(t);
  const patch = { status: done ? 'done' : 'todo', completedAt: done ? new Date().toISOString() : null };

  if (done && t.repeat && !t.nextId) {
    const base = t.due && t.due > todayKey() ? t.due : t.due || todayKey();
    let next = nextOccurrence(base, t.repeat);
    while (next <= todayKey()) next = nextOccurrence(next, t.repeat);
    const copy = createTask({
      title: t.title, notes: t.notes, areaId: t.areaId, goalId: t.goalId,
      important: t.important, urgent: t.urgent, repeat: t.repeat, due: next,
      assignee: t.assignee, assignedAt: t.assignee ? todayKey() : null,
      followUp: t.assignee ? next : null,
      steps: (t.steps || []).map((s) => ({ ...s, id: uid(), done: false })),
    });
    patch.nextId = copy.id;
  }
  if (!done && t.nextId) {
    const nx = taskById(t.nextId);
    if (nx && isOpen(nx) && !nx.focusDate) store.remove('tasks', nx.id); // تراجع نظيف
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

/** يُرجع حقول التركيز (أو null إن امتلأت الثلاث). */
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

export function followedUp(id, days = 3) {
  updateTask(id, { followUp: keyAdd(todayKey(), days) });
}

/* ───────── الإضافة السريعة: رموز داخل النص ─────────
   !  مهم     !!  مهم وعاجل     @اسم  إسناد (الشرطة السفلية = مسافة)     #مجال  أول مجال يبدأ بالنص */
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
    out.tokens.push({ k: 'area', v: a.name, color: a.color });
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

/* ───────── استيراد ملف الإعداد القديم (الإصدار السابق المقترح) — دمج لا استبدال ───────── */
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
      repeat: null, assignee: null, assignedAt: null, followUp: null, createdAt: t.createdAt,
    };
  });
  goals.forEach((g) => { g.areaId = goalArea[g.id.slice(3)] || null; });
  const series = (data.series || []).filter((s) => s.active !== false).map((s) => {
    let due = todayKey();
    for (let i = 0; i < 40; i++) {
      const d = new Date(`${due}T00:00:00`);
      const ok = s.freq === 'monthly' ? d.getDate() === Math.min(s.monthDay || 1, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())
        : s.freq === 'weekly' ? (s.weekdays || []).includes(d.getDay()) : true;
      if (ok) break;
      due = keyAdd(due, 1);
    }
    return {
      id: `v3-${s.id}`, title: s.title, notes: '', areaId: areaMap[s.domainId] || null, goalId: s.projectId ? `v3-${s.projectId}` : null,
      ...(pri[s.priority] || pri[2]), due, status: 'todo', completedAt: null, focusDate: null, focusOrder: 0, slips: 0,
      steps: [], repeat: s.freq === 'monthly' ? 'monthly' : s.freq === 'daily' ? 'daily' : 'weekly',
      assignee: null, assignedAt: null, followUp: null,
    };
  });
  return { goals, tasks: [...tasks, ...series] };
}
