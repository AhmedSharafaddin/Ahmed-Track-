// مركز القيادة — الواجهة.
// كل الشاشات دوال تُرجع HTML من الحالة الحالية، وكل الأحداث تمر عبر معالج واحد (data-act).

import { store } from './store.js';
import {
  uid, todayKey, weekStart, dateKey, addDays, fmtDate, fmtLongDate, fmtDayMonth, n, esc,
  quadrant, QUADRANTS, QUADRANT_ORDER, AREA_COLORS,
} from './utils.js';

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const dlg = $('#dlg');
const MAX_FOCUS = 3;

const ui = { route: 'today', areaFilter: 'all', showDone: false, weekOffset: 0, drafts: {} };
let installPrompt = null;
let lastDay = todayKey();

/* ═════════════ محددات البيانات ═════════════ */
const S = () => store.state;
const areas = () => [...S().areas].sort((a, b) => (a.order || 0) - (b.order || 0));
const areaById = (id) => S().areas.find((a) => a.id === id);
const goalById = (id) => S().goals.find((g) => g.id === id);
const openTasks = () => S().tasks.filter((t) => t.status !== 'done');
const isOverdue = (t) => t.due && t.status !== 'done' && t.due < todayKey();
const byPriority = (a, b) =>
  QUADRANT_ORDER.indexOf(quadrant(a)) - QUADRANT_ORDER.indexOf(quadrant(b)) ||
  (a.due || '9999').localeCompare(b.due || '9999') ||
  (a.createdAt || '').localeCompare(b.createdAt || '');
const focusToday = () =>
  S().tasks.filter((t) => t.focusDate === todayKey()).sort((a, b) => (a.focusOrder || 0) - (b.focusOrder || 0));
const goalTasks = (g) => S().tasks.filter((t) => t.goalId === g.id);
const goalProgress = (g) => {
  const ts = goalTasks(g);
  const done = ts.filter((t) => t.status === 'done').length;
  return { done, total: ts.length, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
};

/* ═════════════ عمليات ═════════════ */
function createTask(fields) {
  return store.put('tasks', {
    id: uid(), title: '', notes: '', areaId: null, goalId: null,
    urgent: false, important: false, due: null, status: 'todo',
    focusDate: null, focusOrder: 0, slips: 0, completedAt: null,
    ...fields,
  });
}

function updateTask(id, patch) {
  const t = S().tasks.find((x) => x.id === id);
  if (t) store.put('tasks', { ...t, ...patch });
}

function toggleTask(id) {
  const t = S().tasks.find((x) => x.id === id);
  if (!t) return;
  const done = t.status !== 'done';
  updateTask(id, { status: done ? 'done' : 'todo', completedAt: done ? new Date().toISOString() : null });
  if (done && t.focusDate === todayKey()) {
    const left = focusToday().filter((x) => x.status !== 'done' && x.id !== id).length;
    toast(left === 0 ? 'أنجزت أولويات اليوم كلها. يوم رابح.' : `أحسنت — بقي ${n(left)} لليوم.`);
  }
}

const FULL_MSG = 'ثلاث مهام فقط لليوم. أنجز واحدة أو أزلها أولًا.';

function addToFocus(id) {
  if (focusToday().length >= MAX_FOCUS) {
    toast(FULL_MSG);
    return false;
  }
  updateTask(id, { focusDate: todayKey(), focusOrder: Date.now() });
  return true;
}

/** حقول التركيز تُحسب داخل نفس عملية الحفظ (لا كتابة ثانية تعتمد على حالة لم تتزامن بعد). */
function focusFields(want, current = {}) {
  const isToday = current.focusDate === todayKey();
  if (!want) return { focusDate: isToday ? null : current.focusDate ?? null };
  if (isToday) return {};
  if (focusToday().length >= MAX_FOCUS) {
    toast(FULL_MSG);
    return {};
  }
  return { focusDate: todayKey(), focusOrder: Date.now() };
}

/** ما لم يُنجز من أولويات أيام سابقة يعود للقائمة ويُحسب «ترحيلًا». */
function rollover() {
  const today = todayKey();
  const stale = S().tasks.filter((t) => t.focusDate && t.focusDate < today && t.status !== 'done');
  stale.forEach((t) => store.put('tasks', { ...t, focusDate: null, slips: (t.slips || 0) + 1 }));
  if (stale.length) toast(`رُحّلت ${n(stale.length)} من أولويات الأمس لم تُنجز — راجعها في «مرشّحة لليوم».`);
}

/* ═════════════ مكوّنات ═════════════ */
const icoCheck = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function areaChip(id) {
  const a = areaById(id);
  return a ? `<span class="chip" style="--c:${esc(a.color)}">${esc(a.name)}</span>` : '';
}

function taskItem(t, opts = {}) {
  const q = quadrant(t);
  const g = t.goalId ? goalById(t.goalId) : null;
  const meta = [
    areaChip(t.areaId),
    opts.hideQuad ? '' : `<span>${QUADRANTS[q].label}</span>`,
    t.due ? `<span class="${isOverdue(t) ? 'late' : ''}">${isOverdue(t) ? 'متأخرة · ' : ''}${fmtDate(t.due)}</span>` : '',
    g ? `<span>🎯 ${esc(g.title)}</span>` : '',
    t.slips ? `<span class="slip">رُحّلت ×${n(t.slips)}</span>` : '',
  ].filter(Boolean).join('');
  const actions = [
    opts.focusBtn
      ? `<button class="btn sm" data-act="focus" data-id="${t.id}" ${opts.focusFull ? 'disabled' : ''} title="أضف لأولويات اليوم">＋ لليوم</button>`
      : '',
    opts.unfocusBtn
      ? `<button class="btn sm ghost" data-act="unfocus" data-id="${t.id}" title="أعدها للقائمة" aria-label="أزل من أولويات اليوم">✕</button>`
      : '',
  ].join('');
  return `<li class="task q-${q} ${t.status === 'done' ? 'done' : ''}">
    <button class="check" data-act="toggle" data-id="${t.id}" aria-label="${t.status === 'done' ? 'إلغاء الإنجاز' : 'تم الإنجاز'}">${icoCheck}</button>
    <button class="task-main" data-act="edit-task" data-id="${t.id}">
      <span class="task-title">${esc(t.title)}</span>
      ${meta ? `<span class="meta">${meta}</span>` : ''}
    </button>
    ${actions ? `<span class="task-actions">${actions}</span>` : ''}
  </li>`;
}

const taskList = (list, opts) =>
  list.length ? `<ul class="tasks">${list.map((t) => taskItem(t, opts)).join('')}</ul>` : '';

const areaOptions = (selected, emptyLabel = 'بدون مجال') =>
  `<option value="">${emptyLabel}</option>` +
  areas().map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');

const goalOptions = (selected) =>
  '<option value="">بدون هدف</option>' +
  S().goals
    .filter((g) => g.status !== 'done' || g.id === selected)
    .map((g) => `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}>${esc(g.title)}</option>`)
    .join('');

function quickAdd({ withFocus = false, areaId = '', placeholder = 'مهمة جديدة… (Enter للإضافة)' } = {}) {
  const d = ui.drafts;
  return `<form class="quick card" data-form="quick" autocomplete="off">
    <div class="row">
      <input class="input" id="qa-title" name="title" data-draft="qa-title" value="${esc(d['qa-title'] || '')}" placeholder="${placeholder}" required maxlength="200" />
      <select class="input" name="areaId" aria-label="المجال">${areaOptions(areaId)}</select>
    </div>
    <div class="row">
      <label class="toggle"><input type="checkbox" name="important" /> مهم</label>
      <label class="toggle"><input type="checkbox" name="urgent" /> عاجل</label>
      ${withFocus ? `<label class="toggle"><input type="checkbox" name="focus" ${focusToday().length >= MAX_FOCUS ? 'disabled' : ''} /> لأولويات اليوم</label>` : ''}
      <span class="spacer"></span>
      <button class="btn primary" type="submit">إضافة</button>
    </div>
  </form>`;
}

/* ═════════════ الشاشات ═════════════ */
function renderToday() {
  const focus = focusToday();
  const doneCount = focus.filter((t) => t.status === 'done').length;
  const full = focus.length >= MAX_FOCUS;
  const candidates = openTasks().filter((t) => t.focusDate !== todayKey()).sort(byPriority).slice(0, 8);
  const overdue = openTasks().filter(isOverdue).length;

  const slots = Array.from({ length: MAX_FOCUS }, (_, i) => {
    const t = focus[i];
    return `<div class="slot"><span class="slot-num">${n(i + 1)}</span>${
      t ? `<ul class="tasks" style="flex:1">${taskItem(t, { unfocusBtn: t.status !== 'done' })}</ul>`
        : '<div class="slot-empty">اختر مهمة من «مرشّحة لليوم» أو أضف واحدة.</div>'
    }</div>`;
  }).join('');

  return `
  <div class="view-head">
    <div><h1>أولويات اليوم</h1><p class="sub">${fmtLongDate()}</p></div>
  </div>
  ${overdue ? `<div class="banner">لديك ${n(overdue)} مهام متأخرة عن موعدها. <a href="#/matrix">راجعها في المصفوفة</a>.</div>` : ''}
  <div class="day-progress"><div class="bar"><i style="width:${(doneCount / MAX_FOCUS) * 100}%"></i></div><span class="sub">${n(doneCount)} من ${n(MAX_FOCUS)}</span></div>
  <div class="top3">${slots}</div>
  ${focus.length === MAX_FOCUS && doneCount === MAX_FOCUS ? '<div class="win">أنجزت الثلاث. ما بعدها إضافة، لا التزام.</div>' : '<p class="note">ثلاث مهام فقط. القليل المُنجز يتفوّق على الكثير المؤجَّل.</p>'}

  <div class="section">${quickAdd({ withFocus: true })}</div>

  <div class="section">
    <h2 class="section-title">مرشّحة لليوم <small>مرتّبة حسب المصفوفة ثم الموعد</small></h2>
    ${taskList(candidates, { focusBtn: true, focusFull: full }) || '<div class="empty">لا مهام مفتوحة. أضف أول مهمة بالأعلى.</div>'}
  </div>`;
}

function renderMatrix() {
  const open = openTasks();
  const quads = QUADRANT_ORDER.map((q) => {
    const list = open.filter((t) => quadrant(t) === q).sort(byPriority);
    return `<section class="card quad ${q}">
      <div class="quad-head">
        <div><h2>${QUADRANTS[q].label}</h2><p>${QUADRANTS[q].hint}</p></div>
        <div class="row"><span class="count">${n(list.length)}</span>
          <button class="btn sm" data-act="new-task" data-q="${q}" aria-label="إضافة مهمة إلى ${QUADRANTS[q].label}">＋</button></div>
      </div>
      ${taskList(list, { hideQuad: true }) || '<div class="empty">فارغ</div>'}
    </section>`;
  }).join('');
  return `
  <div class="view-head"><div><h1>المصفوفة</h1><p class="sub">صنّف كل مهمة: هل هي مهمة؟ هل هي عاجلة؟</p></div></div>
  <div class="matrix">${quads}</div>
  <p class="note">الهدف: أن يكبر ربع «خطّط لها» ويصغر ربع «افعلها الآن» مع الوقت — هذا معنى أنك تقود عملك لا أن يقودك.</p>`;
}

function renderAreas() {
  const list = areas();
  const filters = [{ id: 'all', name: 'الكل' }, ...list, { id: 'none', name: 'بدون مجال' }]
    .map((a) => `<button class="btn sm" data-act="area-filter" data-id="${a.id}" aria-pressed="${ui.areaFilter === a.id}">${esc(a.name)}</button>`)
    .join('');
  const shown = ui.areaFilter === 'all' ? [...list, { id: 'none', name: 'بدون مجال' }]
    : ui.areaFilter === 'none' ? [{ id: 'none', name: 'بدون مجال' }]
    : list.filter((a) => a.id === ui.areaFilter);

  const groups = shown.map((a) => {
    const all = S().tasks.filter((t) => (a.id === 'none' ? !t.areaId || !areaById(t.areaId) : t.areaId === a.id));
    const open = all.filter((t) => t.status !== 'done').sort(byPriority);
    const done = all.filter((t) => t.status === 'done').sort((x, y) => (y.completedAt || '').localeCompare(x.completedAt || ''));
    if (a.id === 'none' && !all.length) return '';
    return `<div class="group">
      <div class="group-head"><span class="chip" style="--c:${esc(a.color || 'var(--q4)')}">${esc(a.name)}</span>
        <span class="count">${n(open.length)} مفتوحة</span><span class="spacer"></span>
        <button class="btn sm" data-act="new-task" data-area="${a.id === 'none' ? '' : a.id}">＋ مهمة</button></div>
      ${taskList(open, { focusBtn: true, focusFull: focusToday().length >= MAX_FOCUS }) || '<div class="empty">لا مهام مفتوحة</div>'}
      ${ui.showDone && done.length ? `<div style="margin-top:8px">${taskList(done.slice(0, 20))}</div>` : ''}
    </div>`;
  }).join('');

  return `
  <div class="view-head"><div><h1>المجالات والمهام</h1><p class="sub">كل عملك مقسّم حسب الجهة.</p></div>
    <label class="toggle"><input type="checkbox" data-act="show-done" ${ui.showDone ? 'checked' : ''} /> إظهار المنجزة</label></div>
  <div class="filters" role="group" aria-label="تصفية حسب المجال">${filters}</div>
  ${groups || '<div class="empty">لا مهام بعد.</div>'}
  <p class="note">لإضافة مجال أو تعديله: <a href="#/settings">الإعدادات</a>.</p>`;
}

function renderGoals() {
  const goals = [...S().goals].sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.targetDate || '9999').localeCompare(b.targetDate || '9999'));
  const cards = goals.map((g) => {
    const p = goalProgress(g);
    const open = goalTasks(g).filter((t) => t.status !== 'done').sort(byPriority).slice(0, 5);
    return `<article class="card goal ${g.status === 'done' ? 'done' : ''}">
      <div class="row"><h3>${g.status === 'done' ? '✓ ' : ''}${esc(g.title)}</h3><span class="spacer"></span>
        <button class="btn sm" data-act="edit-goal" data-id="${g.id}">تعديل</button></div>
      <div class="meta" style="margin-top:4px">${areaChip(g.areaId)}${g.targetDate ? `<span class="${g.status !== 'done' && g.targetDate < todayKey() ? 'late' : ''}">الموعد: ${fmtDate(g.targetDate)}</span>` : ''}</div>
      ${g.why ? `<p class="why">${esc(g.why)}</p>` : '<div style="height:10px"></div>'}
      <div class="progress"><div class="bar"><i style="width:${p.pct}%"></i></div><span>${n(p.pct)}٪ · ${n(p.done)}/${n(p.total)}</span></div>
      ${taskList(open, { focusBtn: true, focusFull: focusToday().length >= MAX_FOCUS })}
      ${g.status !== 'done' ? `<div class="row" style="margin-top:10px"><button class="btn sm" data-act="new-task" data-goal="${g.id}" data-area="${g.areaId || ''}">＋ خطوة لهذا الهدف</button></div>` : ''}
      ${p.total === 0 && g.status !== 'done' ? '<p class="note">الهدف بلا مهام لا يتقدّم. قسّمه إلى خطوات صغيرة.</p>' : ''}
    </article>`;
  }).join('');
  return `
  <div class="view-head"><div><h1>الأهداف</h1><p class="sub">التقدّم يُحسب تلقائيًا من المهام المرتبطة بكل هدف.</p></div>
    <button class="btn primary" data-act="new-goal">＋ هدف</button></div>
  <div class="goals">${cards || '<div class="empty">لا أهداف بعد. ابدأ بهدف واحد لكل مجال.</div>'}</div>`;
}

function renderReview() {
  const ws = addDays(weekStart(), ui.weekOffset * 7);
  const we = addDays(ws, 7);
  const wk = dateKey(ws);
  const inWeek = (iso) => iso && new Date(iso) >= ws && new Date(iso) < we;
  const done = S().tasks.filter((t) => t.status === 'done' && inWeek(t.completedAt));
  const q2 = done.filter((t) => quadrant(t) === 'q2').length;
  const overdue = openTasks().filter(isOverdue);
  const slipped = openTasks().filter((t) => t.slips > 0).sort((a, b) => b.slips - a.slips).slice(0, 8);
  const max = Math.max(1, ...areas().map((a) => done.filter((t) => t.areaId === a.id).length));
  const bars = areas().map((a) => {
    const c = done.filter((t) => t.areaId === a.id).length;
    return `<div class="line" style="--c:${esc(a.color)}"><span>${esc(a.name)}</span><div class="bar"><i style="width:${(c / max) * 100}%"></i></div><b>${n(c)}</b></div>`;
  }).join('');
  const rev = S().reviews.find((r) => r.id === wk) || {};
  const past = [...S().reviews].filter((r) => r.id !== wk).sort((a, b) => b.id.localeCompare(a.id));
  const isCurrent = ui.weekOffset === 0;
  const d = ui.drafts;
  const val = (k) => esc(d[`rv-${wk}-${k}`] ?? rev[k] ?? '');

  return `
  <div class="view-head">
    <div><h1>المراجعة الأسبوعية</h1><p class="sub">من ${fmtDayMonth(ws)} إلى ${fmtDayMonth(addDays(we, -1))}${isCurrent ? ' · هذا الأسبوع' : ''}</p></div>
    <div class="week-nav">
      <button class="btn sm" data-act="week" data-d="-1" aria-label="الأسبوع السابق">→ السابق</button>
      <button class="btn sm" data-act="week" data-d="1" ${isCurrent ? 'disabled' : ''} aria-label="الأسبوع التالي">التالي ←</button>
    </div>
  </div>
  <div class="stats">
    <div class="card stat"><b>${n(done.length)}</b><span>مهمة منجزة</span></div>
    <div class="card stat"><b>${n(done.length ? Math.round((q2 / done.length) * 100) : 0)}٪</b><span>من المنجز عمل استراتيجي («خطّط لها»)</span></div>
    <div class="card stat"><b>${n(overdue.length)}</b><span>متأخرة الآن</span></div>
    <div class="card stat"><b>${n(slipped.length)}</b><span>مهام تتكرر في الترحيل</span></div>
  </div>

  <div class="section"><h2 class="section-title">المنجز حسب المجال</h2>
    <div class="card bars">${bars || '<div class="empty">لا مجالات</div>'}</div></div>

  ${slipped.length ? `<div class="section"><h2 class="section-title">ما تأخّر <small>قرّر: أنجزها، صغّرها، أو احذفها</small></h2>${taskList(slipped)}</div>` : ''}

  <div class="section">
    <h2 class="section-title">تأمّل الأسبوع</h2>
    <form class="card" data-form="review" data-week="${wk}">
      <label class="field"><span>ما الذي أنجزته وأفخر به؟</span><textarea class="input" name="wins" data-draft="rv-${wk}-wins">${val('wins')}</textarea></label>
      <label class="field"><span>ما الذي عطّلني أو شتّتني؟</span><textarea class="input" name="blockers" data-draft="rv-${wk}-blockers">${val('blockers')}</textarea></label>
      <label class="field"><span>أهم ٣ أشياء للأسبوع القادم</span><textarea class="input" name="next" data-draft="rv-${wk}-next">${val('next')}</textarea></label>
      <div class="row"><button class="btn primary" type="submit">حفظ المراجعة</button>${rev.updatedAt ? `<span class="sub">حُفظت ${fmtDate(rev.updatedAt.slice(0, 10))}</span>` : ''}</div>
    </form>
  </div>

  ${past.length ? `<div class="section"><h2 class="section-title">مراجعات سابقة</h2>${past.map((r) => `
    <details class="past"><summary>أسبوع ${fmtDate(r.id)}</summary>
      ${r.wins ? `<p><b>الإنجاز:</b> ${esc(r.wins)}</p>` : ''}${r.blockers ? `<p><b>المعطّلات:</b> ${esc(r.blockers)}</p>` : ''}${r.next ? `<p><b>التالي:</b> ${esc(r.next)}</p>` : ''}
    </details>`).join('')}</div>` : ''}`;
}

function renderSettings() {
  const m = store.mode;
  let sync;
  if (m === 'local') {
    sync = `<p>يعمل التطبيق الآن <b>على هذا الجهاز فقط</b>. البيانات محفوظة في المتصفح.</p>
      <p class="note">لتفعيل المزامنة بين اللابتوب والآيفون: أنشئ مشروع Firebase مجاني والصق إعداداته في <code>js/config.js</code> — الخطوات في README.</p>`;
  } else if (m === 'cloud-error') {
    sync = `<p>تعذّر تحميل خدمة المزامنة (غالبًا لا يوجد اتصال). تعمل الآن النسخة المحلية، وستعود المزامنة عند فتح التطبيق مع اتصال.</p>`;
  } else if (m === 'cloud-signed-out') {
    sync = `<p>سجّل الدخول لمزامنة بياناتك بين أجهزتك. أول دخول يرفع ما على هذا الجهاز إلى حسابك.</p>
      <form data-form="auth" autocomplete="on">
        <label class="field"><span>البريد الإلكتروني</span><input class="input" type="email" name="email" autocomplete="email" required dir="ltr" /></label>
        <label class="field"><span>كلمة المرور</span><input class="input" type="password" name="password" autocomplete="current-password" minlength="6" required dir="ltr" /></label>
        <div class="row">
          <button class="btn primary" type="submit" name="op" value="in">دخول</button>
          <button class="btn" type="submit" name="op" value="up">إنشاء حساب</button>
          <button class="btn ghost" type="submit" name="op" value="reset" formnovalidate>نسيت كلمة المرور</button>
        </div>
      </form>`;
  } else {
    sync = `<p>متصل بحساب <b dir="ltr">${esc(store.user?.email || '')}</b>. أي تغيير يظهر على أجهزتك الأخرى خلال ثوانٍ، ويعمل التطبيق دون إنترنت ويزامن لاحقًا.</p>
      <div class="row"><button class="btn" data-act="signout">تسجيل الخروج</button></div>`;
  }

  const areaRows = areas().map((a) => `
    <form class="area-row" data-form="area" data-id="${a.id}">
      <input type="color" name="color" value="${esc(a.color)}" aria-label="لون ${esc(a.name)}" />
      <input class="input" name="name" value="${esc(a.name)}" required maxlength="40" aria-label="اسم المجال" />
      <button class="btn sm" type="submit">حفظ</button>
      <button class="btn sm danger" type="button" data-act="del-area" data-id="${a.id}" aria-label="حذف ${esc(a.name)}">حذف</button>
    </form>`).join('');

  return `
  <div class="view-head"><div><h1>الإعدادات</h1></div></div>
  <div class="settings">
    <section class="card"><h2>المزامنة</h2>${sync}</section>

    <section class="card"><h2>المجالات</h2>${areaRows}
      <form class="area-row" data-form="new-area">
        <input type="color" name="color" value="${AREA_COLORS[areas().length % AREA_COLORS.length]}" aria-label="لون المجال" />
        <input class="input" name="name" placeholder="مجال جديد" required maxlength="40" />
        <button class="btn sm primary" type="submit">إضافة</button>
      </form>
    </section>

    <section class="card"><h2>التثبيت والـWidget</h2>
      ${installPrompt ? '<div class="row" style="margin-bottom:10px"><button class="btn primary" data-act="install">تثبيت التطبيق على هذا الجهاز</button></div>' : ''}
      <ul class="steps">
        <li><b>ويندوز:</b> افتح الرابط في Edge أو Chrome ← قائمة المتصفح ← «تثبيت مركز القيادة». يظهر كتطبيق مستقل في قائمة ابدأ ويمكن تثبيته على شريط المهام.</li>
        <li><b>آيفون:</b> افتح الرابط في Safari ← زر المشاركة ← «إضافة إلى الشاشة الرئيسية».</li>
        <li><b>نافذة الـWidget:</b> نافذة صغيرة تعرض أولويات اليوم فقط — ضعها في زاوية الشاشة.</li>
      </ul>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="open-widget">فتح نافذة الـWidget</button></div>
    </section>

    <section class="card"><h2>نسخة احتياطية</h2>
      <p class="note" style="margin-top:0">صدّر كل بياناتك كملف JSON واحتفظ به. الاستيراد يستبدل البيانات الحالية بالكامل.</p>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-act="export">تصدير</button>
        <label class="btn">استيراد<input type="file" accept="application/json,.json" data-act="import" hidden /></label>
      </div>
    </section>
  </div>`;
}

function renderWidget() {
  const focus = focusToday();
  const done = focus.filter((t) => t.status === 'done').length;
  const slots = Array.from({ length: MAX_FOCUS }, (_, i) => {
    const t = focus[i];
    return `<div class="slot"><span class="slot-num">${n(i + 1)}</span>${
      t ? `<ul class="tasks" style="flex:1">${taskItem(t, { hideQuad: true })}</ul>` : '<div class="slot-empty">—</div>'
    }</div>`;
  }).join('');
  return `<div class="widget">
    <div class="row" style="margin-bottom:10px"><h1>أولويات اليوم</h1><span class="spacer"></span><span class="sub">${n(done)}/${n(MAX_FOCUS)}</span></div>
    <div class="top3">${slots}</div>
    <div class="foot"><span>${fmtDate(todayKey())}</span><a href="#/today" data-act="widget-open">فتح مركز القيادة</a></div>
  </div>`;
}

const ROUTES = {
  today: renderToday, matrix: renderMatrix, areas: renderAreas, goals: renderGoals,
  review: renderReview, settings: renderSettings, widget: renderWidget,
};

/* ═════════════ الحوارات ═════════════ */
function openTaskDialog(t) {
  const isNew = !t.id;
  dlg.innerHTML = `<form method="dialog" data-form="task" data-id="${t.id || ''}">
    <h2>${isNew ? 'مهمة جديدة' : 'تعديل المهمة'}</h2>
    <label class="field"><span>المهمة</span><input class="input" name="title" value="${esc(t.title || '')}" required maxlength="200" autofocus /></label>
    <div class="two">
      <label class="field"><span>المجال</span><select class="input" name="areaId">${areaOptions(t.areaId)}</select></label>
      <label class="field"><span>الهدف</span><select class="input" name="goalId">${goalOptions(t.goalId)}</select></label>
    </div>
    <div class="row" style="margin-bottom:14px">
      <label class="toggle"><input type="checkbox" name="important" ${t.important ? 'checked' : ''} /> مهم</label>
      <label class="toggle"><input type="checkbox" name="urgent" ${t.urgent ? 'checked' : ''} /> عاجل</label>
      <label class="toggle"><input type="checkbox" name="focus" ${t.focusDate === todayKey() ? 'checked' : ''} /> لأولويات اليوم</label>
      ${isNew ? '' : `<label class="toggle"><input type="checkbox" name="done" ${t.status === 'done' ? 'checked' : ''} /> منجزة</label>`}
    </div>
    <label class="field"><span>الموعد النهائي</span><input class="input" type="date" name="due" value="${esc(t.due || '')}" /></label>
    <label class="field"><span>ملاحظات</span><textarea class="input" name="notes" maxlength="2000">${esc(t.notes || '')}</textarea></label>
    <div class="actions">
      <button class="btn primary" type="submit" value="save">حفظ</button>
      <button class="btn" type="button" data-act="close">إلغاء</button>
      <span class="spacer"></span>
      ${isNew ? '' : `<button class="btn danger" type="button" data-act="del-task" data-id="${t.id}">حذف</button>`}
    </div>
  </form>`;
  dlg.showModal();
}

function openGoalDialog(g) {
  const isNew = !g.id;
  dlg.innerHTML = `<form method="dialog" data-form="goal" data-id="${g.id || ''}">
    <h2>${isNew ? 'هدف جديد' : 'تعديل الهدف'}</h2>
    <label class="field"><span>الهدف</span><input class="input" name="title" value="${esc(g.title || '')}" required maxlength="160" autofocus placeholder="نتيجة واضحة يمكن قياسها" /></label>
    <label class="field"><span>لماذا هذا الهدف؟</span><textarea class="input" name="why" maxlength="1000" placeholder="ما الذي سيتغيّر إن تحقق؟">${esc(g.why || '')}</textarea></label>
    <div class="two">
      <label class="field"><span>المجال</span><select class="input" name="areaId">${areaOptions(g.areaId)}</select></label>
      <label class="field"><span>الموعد المستهدف</span><input class="input" type="date" name="targetDate" value="${esc(g.targetDate || '')}" /></label>
    </div>
    ${isNew ? '' : `<label class="toggle" style="margin-bottom:14px"><input type="checkbox" name="done" ${g.status === 'done' ? 'checked' : ''} /> تحقق الهدف</label>`}
    <div class="actions">
      <button class="btn primary" type="submit">حفظ</button>
      <button class="btn" type="button" data-act="close">إلغاء</button>
      <span class="spacer"></span>
      ${isNew ? '' : `<button class="btn danger" type="button" data-act="del-goal" data-id="${g.id}">حذف</button>`}
    </div>
  </form>`;
  dlg.showModal();
}

/* ═════════════ الأحداث ═════════════ */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const { act, id } = el.dataset;
  switch (act) {
    case 'toggle': toggleTask(id); break;
    case 'focus': addToFocus(id); break;
    case 'unfocus': updateTask(id, { focusDate: null }); break;
    case 'edit-task': openTaskDialog(S().tasks.find((t) => t.id === id)); break;
    case 'new-task': {
      const q = el.dataset.q;
      openTaskDialog({
        areaId: el.dataset.area || null, goalId: el.dataset.goal || null,
        important: q === 'q1' || q === 'q2', urgent: q === 'q1' || q === 'q3',
      });
      break;
    }
    case 'new-goal': openGoalDialog({}); break;
    case 'edit-goal': openGoalDialog(goalById(id)); break;
    case 'close': dlg.close(); break;
    case 'del-task':
      if (confirm('حذف هذه المهمة نهائيًا؟')) { store.remove('tasks', id); dlg.close(); toast('حُذفت المهمة.'); }
      break;
    case 'del-goal':
      if (confirm('حذف الهدف؟ مهامه تبقى لكن بدون هدف.')) {
        S().tasks.filter((t) => t.goalId === id).forEach((t) => updateTask(t.id, { goalId: null }));
        store.remove('goals', id); dlg.close(); toast('حُذف الهدف.');
      }
      break;
    case 'del-area': {
      const a = areaById(id);
      const used = S().tasks.filter((t) => t.areaId === id).length;
      if (confirm(`حذف مجال «${a?.name}»؟${used ? ` ${n(used)} مهمة ستصبح بدون مجال.` : ''}`)) {
        S().tasks.filter((t) => t.areaId === id).forEach((t) => updateTask(t.id, { areaId: null }));
        S().goals.filter((g) => g.areaId === id).forEach((g) => store.put('goals', { ...g, areaId: null }));
        store.remove('areas', id);
      }
      break;
    }
    case 'area-filter': ui.areaFilter = id; render(); break;
    case 'week': ui.weekOffset = Math.min(0, ui.weekOffset + Number(el.dataset.d)); render(); break;
    case 'signout': store.signOut(); break;
    case 'export': exportData(); break;
    case 'install': installPrompt?.prompt(); installPrompt = null; break;
    case 'open-widget':
      window.open(`${location.pathname}#/widget`, 'cc-widget', 'width=380,height=560');
      break;
    case 'widget-open':
      if (window.opener && !window.opener.closed) { e.preventDefault(); window.opener.focus(); }
      break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'show-done') { ui.showDone = el.checked; render(); }
  if (el.dataset.act === 'import' && el.files[0]) importData(el.files[0]).finally(() => { el.value = ''; });
});

document.addEventListener('input', (e) => {
  const k = e.target.dataset?.draft;
  if (k) ui.drafts[k] = e.target.value;
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const get = (k) => (fd.get(k) || '').toString().trim();
  const on = (k) => fd.get(k) === 'on';

  switch (form.dataset.form) {
    case 'quick': {
      const title = get('title');
      if (!title) return;
      createTask({
        title, areaId: get('areaId') || null, important: on('important'), urgent: on('urgent'),
        ...(on('focus') ? focusFields(true) : {}),
      });
      delete ui.drafts['qa-title'];
      form.reset();
      render();
      $('#qa-title')?.focus();
      break;
    }
    case 'task': {
      const id = form.dataset.id;
      const old = id ? S().tasks.find((t) => t.id === id) : null;
      const fields = {
        title: get('title'), areaId: get('areaId') || null, goalId: get('goalId') || null,
        important: on('important'), urgent: on('urgent'), due: get('due') || null, notes: get('notes'),
      };
      if (!fields.title) return;
      const focus = focusFields(on('focus'), old || {});
      if (old) {
        const done = on('done');
        store.put('tasks', {
          ...old, ...fields, ...focus,
          status: done ? 'done' : 'todo',
          completedAt: done ? old.completedAt || new Date().toISOString() : null,
        });
      } else {
        createTask({ ...fields, ...focus });
      }
      dlg.close();
      break;
    }
    case 'goal': {
      const id = form.dataset.id;
      const old = id ? goalById(id) : {};
      const title = get('title');
      if (!title) return;
      store.put('goals', {
        id: id || uid(), ...old, title, why: get('why'), areaId: get('areaId') || null,
        targetDate: get('targetDate') || null, status: on('done') ? 'done' : 'active',
      });
      dlg.close();
      break;
    }
    case 'review': {
      const wk = form.dataset.week;
      const old = S().reviews.find((r) => r.id === wk) || {};
      store.put('reviews', { ...old, id: wk, wins: get('wins'), blockers: get('blockers'), next: get('next') });
      ['wins', 'blockers', 'next'].forEach((k) => delete ui.drafts[`rv-${wk}-${k}`]);
      toast('حُفظت المراجعة.');
      break;
    }
    case 'area': {
      const a = areaById(form.dataset.id);
      if (a && get('name')) { store.put('areas', { ...a, name: get('name'), color: get('color') }); toast('حُفظ المجال.'); }
      break;
    }
    case 'new-area': {
      if (!get('name')) return;
      const order = Math.max(0, ...S().areas.map((a) => a.order || 0)) + 1;
      store.put('areas', { id: uid(), name: get('name'), color: get('color'), order });
      form.reset();
      break;
    }
    case 'auth': {
      const op = e.submitter?.value || 'in';
      const email = get('email');
      const pass = fd.get('password') || '';
      const msgs = {
        'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة.',
        'auth/email-already-in-use': 'هذا البريد مسجّل — استخدم «دخول».',
        'auth/weak-password': 'كلمة المرور قصيرة (٦ أحرف على الأقل).',
        'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت.',
        'auth/operation-not-allowed': 'إنشاء الحسابات مغلق في إعدادات Firebase.',
        'auth/admin-restricted-operation': 'إنشاء الحسابات مغلق في إعدادات Firebase.',
        'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.',
      };
      const fail = (err) => toast(msgs[err.code] || `تعذّر الإجراء (${err.code || err.message}).`);
      if (op === 'reset') {
        if (!email) return toast('اكتب بريدك أولًا.');
        store.resetPassword(email).then(() => toast('أُرسل رابط إعادة التعيين إلى بريدك.'), fail);
      } else {
        (op === 'up' ? store.signUp(email, pass) : store.signIn(email, pass)).then(() => toast('تم الدخول. جارٍ المزامنة…'), fail);
      }
      break;
    }
  }
});

dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // إغلاق بالنقر خارج الحوار

/* ═════════════ النسخ الاحتياطي ═════════════ */
function exportData() {
  const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `command-center-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'command-center') throw new Error('not a backup');
    const count = (data.tasks || []).length;
    if (!confirm(`استيراد ${n(count)} مهمة سيستبدل كل البيانات الحالية. متابعة؟`)) return;
    store.importAll(data);
    toast('تم الاستيراد.');
  } catch {
    toast('الملف ليس نسخة احتياطية صالحة لمركز القيادة.');
  }
}

/* ═════════════ العرض ═════════════ */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function renderSync() {
  const el = $('#sync');
  const st = store.status;
  const states = {
    local: ['', 'محلي'],
    'cloud-error': ['error', 'غير متصل'],
    'cloud-signed-out': ['error', 'سجّل الدخول'],
    cloud: st.error ? ['error', 'خطأ مزامنة'] : st.pending || !st.serverConfirmed ? ['pending', 'يزامن…'] : ['ok', 'متزامن'],
  };
  const [state, label] = states[store.mode] || ['', ''];
  el.dataset.state = state;
  el.textContent = label;
}

let scheduled = false;
function render() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!store.status.ready) return;
    const active = document.activeElement;
    const keepId = active && view.contains(active) && active.id ? active.id : null;
    const sel = keepId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

    view.innerHTML = (ROUTES[ui.route] || renderToday)();
    document.body.classList.toggle('widget-mode', ui.route === 'widget');
    document.querySelectorAll('.tabbar a').forEach((a) =>
      a.setAttribute('aria-current', a.dataset.route === ui.route ? 'page' : 'false'));
    renderSync();

    if (keepId) {
      const el = document.getElementById(keepId);
      if (el) { el.focus(); if (sel) try { el.setSelectionRange(...sel); } catch {} }
    }
  });
}

function onRoute() {
  const r = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'today';
  const changed = r !== ui.route;
  ui.route = ROUTES[r] ? r : 'today';
  if (changed && ui.route !== 'review') ui.weekOffset = 0;
  document.title = ui.route === 'widget' ? 'أولويات اليوم' : 'مركز القيادة';
  render();
  if (changed) window.scrollTo(0, 0);
}

function checkDay() {
  if (todayKey() !== lastDay) { lastDay = todayKey(); if (store.status.ready) rollover(); render(); }
}

/* ═════════════ التشغيل ═════════════ */
let rolledFor = null; // الترحيل مرة لكل مصدر بيانات (محلي / حساب)
store.subscribe((state, status) => {
  // في السحابة: بعد تأكيد الخادم فقط لتجنّب ترحيل مكرر من نسخة قديمة
  const source = store.mode === 'cloud' ? store.user?.uid : 'local';
  if (rolledFor !== source && status.ready && (store.mode !== 'cloud' || status.serverConfirmed)) {
    rolledFor = source;
    rollover();
  }
  render();
});

window.addEventListener('hashchange', onRoute);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDay(); });
setInterval(checkDay, 60_000);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (ui.route === 'settings') render(); });

onRoute();
store.boot().catch((e) => { console.error(e); view.innerHTML = '<p class="loading">تعذّر تشغيل التطبيق.</p>'; });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
