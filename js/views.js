// الشاشات: دوال تُرجع HTML من الحالة. كل الأحداث في app.js عبر data-act.
// الأيقونات من ملف واحد مضمّن في الصفحة (Phosphor) عبر <use> ⇒ HTML أخف وعرض أسرع.

import { store } from './store.js';
import {
  todayKey, weekStart, dateKey, addDays, keyAdd, daysBetween, fmtDate, fmtLongDate, fmtDayMonth, n, esc,
  quadrant, QUADRANTS, QUADRANT_ORDER, AREA_COLORS, REPEATS, REMINDS, ESTS, relDay, initials, personColor, fmtTime, fmtMin,
} from './utils.js';
import {
  S, MAX_FOCUS, areas, areaById, goalById, isOpen, openTasks, isOverdue, isFocus, hasArea, byPriority,
  focusToday, alsoToday, doneToday, suggestions, goalTasks, goalProgress, people, streak, SMART, listTasks, counts, followDue,
  settings, todayLoad, isReviewDoc, taskFireAt, isWaiting,
} from './model.js';
import { vAll } from './tasks.js';
import { vPyramid } from './pyramid.js';
import { notify } from './notify.js';
import { pushConfig } from './config.js';
import { vDash } from './dash.js';

export const ui = {
  route: 'today', param: null, sel: null, q: '', weekOffset: 0, drafts: {},
  tf: { q: '', area: '', pri: '' }, paneMore: false,
  focusId: null, timer: { total: 25 * 60, left: 25 * 60, running: false, endAt: 0 }, justDone: null,
};
export const env = { installPrompt: null, theme: document.documentElement.dataset.theme || 'petrol' };

/* ───────── أيقونات ───────── */
/** I('star') خطية، I('star','d') بلونين، I('star','f') ممتلئة */
export const I = (name, v = 'i', cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${v}-${name}"/></svg>`;

/* ───────── مكوّنات صغيرة ───────── */
/** رمز المجال: إيموجي على خلفية بلونه، أو نقطة ملوّنة إن لم يُختر رمز. */
export const areaMark = (a, size = '') => (a.emoji
  ? `<span class="emo${size ? ` ${size}` : ''}" style="--c:${esc(a.color)}" aria-hidden="true">${esc(a.emoji)}</span>`
  : `<i class="dot${size ? ` ${size}` : ''}" style="--c:${esc(a.color)}" aria-hidden="true"></i>`);
const avatar = (name) => `<span class="ava" style="--c:${personColor(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
const plural = (k, one, two, few, many) => (k === 1 ? one : k === 2 ? two : k <= 10 ? `${n(k)} ${few}` : `${n(k)} ${many}`);
const daysWord = (k) => plural(k, 'يوم', 'يومان', 'أيام', 'يومًا');
const dueLabel = (t) => `${relDay(t.due)}${t.time ? ` ${fmtTime(t.time)}` : ''}`;

/** صف المهمة — لغة واحدة في كل الشاشات. */
export function row(t, o = {}) {
  const q = quadrant(t);
  const done = !isOpen(t);
  const meta = [];
  if (!o.hideArea && hasArea(t)) { const a = areaById(t.areaId); meta.push(`<span class="m">${areaMark(a, 'xs')}${esc(a.name)}</span>`); }
  if (!o.inToday && isFocus(t) && !done) meta.push(`<span class="m m-focus">${I('today')}ضمن الثلاثة</span>`);
  if (isWaiting(t) && !done) meta.push(`<span class="m m-wait">${I('hourglass')}بانتظار الاعتماد</span>`);
  if (t.due) meta.push(`<span class="m ${isOverdue(t) ? 'late' : t.due === todayKey() && !done ? 'soon' : ''}">${I(t.time ? 'clock' : 'cal')}${dueLabel(t)}</span>`);
  if (t.remind != null && t.due && !done) meta.push(`<span class="m" title="تذكير: ${REMINDS[t.remind] || ''}">${I('bell')}</span>`);
  if (t.kind === 'meeting') meta.push(`<span class="m m-meet">${I('meet')}اجتماع${t.place ? `، ${esc(t.place)}` : ''}${t.minutes ? ` ${I('doc')}` : ''}</span>`);
  if (t.est || t.spent) meta.push(`<span class="m" title="${t.spent ? `الوقت الفعلي في وضع التركيز: ${fmtMin(t.spent)}` : 'الوقت المقدّر'}">${I(t.spent ? 'timer' : 'hourglass')}${t.spent ? `${fmtMin(t.spent)}${t.est ? ` من ${fmtMin(t.est)}` : ''}` : fmtMin(t.est)}</span>`);
  if (t.steps?.length) meta.push(`<span class="m">${I('steps')}${n(t.steps.filter((s) => s.done).length)}/${n(t.steps.length)}</span>`);
  if (t.repeat) meta.push(`<span class="m" title="${REPEATS[t.repeat] || ''}">${I('repeat')}</span>`);
  if (t.assignee && !o.hideAssignee) meta.push(`<span class="m ${followDue(t) ? 'late' : ''}">${avatar(t.assignee)}${esc(t.assignee)}${followDue(t) ? '، حان موعد المتابعة' : ''}</span>`);
  if (!o.hideGoal && t.goalId && goalById(t.goalId)) { const g = goalById(t.goalId); meta.push(`<span class="m">${g.emoji ? `<span class="em">${esc(g.emoji)}</span>` : I('flag')}${esc(g.title)}</span>`); }
  if ((t.slips >= 2 || t.snoozes >= 2) && !done) meta.push(`<span class="m slip">${I('fire')}${t.slips >= 2 ? `رُحّلت ${n(t.slips)} مرات` : `أُجّلت ${n(t.snoozes)} مرات`}</span>`);
  if (t.notes) meta.push(`<span class="m" title="ملاحظات">${I('note')}</span>`);

  const acts = [];
  if (o.pick) acts.push(`<button class="mini" data-act="focus" data-id="${t.id}" ${o.full ? 'disabled' : ''} title="أضف لأولويات اليوم">${I('plus')}<span>لليوم</span></button>`);
  if (o.follow && t.assignee && !done) acts.push(`<button class="mini" data-act="followed" data-id="${t.id}" title="سجّل أنك تابعت، والمتابعة التالية بعد 3 أيام">${I('check')}<span>تابعت</span></button>`);
  if (o.slot && !done) {
    acts.push(`<button class="ib" data-act="start-focus" data-id="${t.id}" title="وضع التركيز" aria-label="ابدأ التركيز على هذه المهمة">${I('play', 'f')}</button>`);
    acts.push(`<button class="ib" data-act="unfocus" data-id="${t.id}" title="أعدها للقائمة" aria-label="أزل من أولويات اليوم">${I('x')}</button>`);
  }

  return `<li class="t q-${q}${done ? ' done' : ''}${ui.sel === t.id ? ' sel' : ''}${ui.justDone === t.id ? ' pop' : ''}" data-id="${t.id}"${o.drag ? ' draggable="true"' : ''}>
    <button class="ck" data-act="toggle" data-id="${t.id}" aria-label="${done ? 'إلغاء الإنجاز' : 'إنجاز'}: ${esc(t.title)}">${I('check')}</button>
    <button class="tm" data-act="open" data-id="${t.id}">
      <span class="tt">${esc(t.title)}</span>
      ${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}
    </button>
    ${acts.length ? `<span class="acts">${acts.join('')}</span>` : ''}
    <button class="star${t.important ? ' on' : ''}" data-act="star" data-id="${t.id}" aria-pressed="${!!t.important}" aria-label="مهم">${I('star', t.important ? 'f' : 'i')}</button>
  </li>`;
}

const rows = (list, o) => (list.length ? `<ul class="tl">${list.map((t) => row(t, o)).join('')}</ul>` : '');

function doneBox(list, label = 'المكتملة') {
  if (!list.length) return '';
  const sorted = [...list].sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).slice(0, 40);
  return `<details class="donebox"><summary>${label} <span class="cnt">${n(list.length)}</span></summary>${rows(sorted)}</details>`;
}

/** الحلقات الثلاث — شعار التطبيق نفسه، تمتلئ مع كل أولوية تُنجز. */
export function rings(focus, size = 64) {
  const R = [30, 21.5, 13];
  const arcs = R.map((r, i) => {
    const t = focus[i];
    const c = 2 * Math.PI * r;
    const st = !t ? 'none' : isOpen(t) ? 'open' : 'full';
    return `<circle class="trk ${st}" cx="36" cy="36" r="${r}"/><circle class="arc ${st}" cx="36" cy="36" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${st === 'full' ? 0 : c.toFixed(1)}"/>`;
  }).join('');
  const all = focus.length === MAX_FOCUS && focus.every((t) => !isOpen(t));
  return `<svg class="rings${all ? ' all' : ''}" style="width:${size}px;height:${size}px" viewBox="0 0 72 72" aria-hidden="true">${arcs}<circle class="core" cx="36" cy="36" r="4.5"/></svg>`;
}

const areaOptions = (sel, empty = 'بدون مجال (الوارد)') =>
  `<option value="">${empty}</option>` + areas().map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${a.emoji ? `${esc(a.emoji)} ` : ''}${esc(a.name)}</option>`).join('');
const goalOptions = (sel) =>
  '<option value="">بدون هدف</option>' +
  S().goals.filter((g) => g.status !== 'done' || g.id === sel)
    .map((g) => `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>${g.emoji ? `${esc(g.emoji)} ` : ''}${esc(g.title)}</option>`).join('');

/** الإضافة السريعة — حقل واحد، والرموز ! @ # تغني عن النماذج.
 *  id: معرّف الحقل ('qa' في الصفحة، 'qa-d' في نافذة الإضافة) — والمسودة والموعد المختار
 *  محفوظان في ui.drafts فلا يضيعان إن أُعيد رسم الشاشة بسبب مزامنة. */
export function quickAdd(ctx = {}, placeholder = 'أضف مهمة', id = 'qa') {
  const attrs = Object.entries(ctx).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  const d = ui.drafts[`${id}:date`] || {};
  const label = d.date ? `${relDay(d.date)}${d.time ? ` ${fmtTime(d.time)}` : ''}${d.remind != null ? ' 🔔' : ''}` : 'موعد';
  return `<form class="qa" data-form="quick" data-qid="${id}" ${attrs} autocomplete="off">
    <span class="qa-plus">${I('plus')}</span>
    <input id="${id}" name="title" class="qa-in" data-draft="${id}" value="${esc(ui.drafts[id] || '')}" placeholder="${placeholder}" maxlength="200" aria-label="${placeholder}" enterkeyhint="done" />
    <button type="button" class="qa-mic" data-act="voice" title="إدخال صوتي" aria-label="إدخال صوتي: قل المهمة أو الاجتماع">${I('mic', 'd')}</button>
    <input type="hidden" name="due" value="${esc(d.date || '')}" /><input type="hidden" name="time" value="${esc(d.time || '')}" /><input type="hidden" name="remind" value="${esc(d.remind ?? '')}" /><input type="hidden" name="intent" value="${esc(d.intent || '')}" />
    <div class="qa-more">
      <label class="chip-t"><input type="checkbox" name="important" /> مهم</label>
      <label class="chip-t"><input type="checkbox" name="urgent" /> عاجل</label>
      <button type="button" class="chip-t qa-date${d.date ? ' on' : ''}" data-act="qa-date" aria-pressed="${!!d.date}">${I('cal')}<span>${esc(label)}</span></button>
      <span class="qa-tokens" aria-live="polite"></span>
      <span class="qa-hint">اكتب <b>@الاسم</b> للإسناد، <b>#المجال</b> للتصنيف، <b>!</b> مهم، <b>!!</b> عاجل ومهم</span>
    </div>
  </form>`;
}

function vh(title, sub = '', side = '', icon = '') {
  return `<header class="vh"><div class="vh-t">${icon}<div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div></div>${side ? `<div class="vh-s">${side}</div>` : ''}</header>`;
}

export const localName = () => { try { return settings().name || localStorage.getItem('cc:name') || ''; } catch { return settings().name || ''; } };
function greeting() {
  const h = new Date().getHours();
  const name = localName();
  const g = h < 12 ? 'صباح الخير' : h < 17 ? 'نهارك سعيد' : 'مساء الخير';
  return name ? `${g} يا ${esc(name)}` : g;
}

/* ═════════════ اليوم ═════════════ */
function vToday() {
  const focus = focusToday();
  const doneN = focus.filter((t) => !isOpen(t)).length;
  const full = focus.length >= MAX_FOCUS;
  const st = streak();
  const load = todayLoad();
  const prompts = [
    'ما المهمة التي لو أنجزتها اليوم صار كل ما بعدها أسهل؟',
    'ما الذي يقرّبك من هدف، لا ما يُسكت ضجيجًا؟',
    'مهمة ثالثة صغيرة تُنجزها حتى في يوم مزدحم.',
  ];
  const slots = Array.from({ length: MAX_FOCUS }, (_, i) => {
    const t = focus[i];
    return t
      ? `<li class="slot${i === 0 ? ' first' : ''}${isOpen(t) ? '' : ' won'}"><span class="num">${n(i + 1)}</span><ul class="tl">${row(t, { inToday: true, slot: true })}</ul></li>`
      : `<li class="slot vacant${i === 0 ? ' first' : ''}"><span class="num">${n(i + 1)}</span><p>${prompts[i]}</p></li>`;
  }).join('');

  const sug = full ? [] : suggestions(5);
  const also = alsoToday();
  const done = doneToday().filter((t) => !isFocus(t));
  const allWon = full && doneN === MAX_FOCUS;
  const loadLine = load.minutes || load.unknown
    ? `<div class="load${load.over ? ' over' : ''}" title="مجموع الوقت المقدّر لمهام اليوم مقابل ساعات التركيز المتاحة">
        <div class="bar"><i style="width:${load.pct}%"></i></div>
        <span>${load.minutes ? `${fmtMin(load.minutes)} من ${fmtMin(load.cap)}` : 'قدّر وقت مهامك ليظهر حِمل يومك'}${load.unknown && load.minutes ? `، و${n(load.unknown)} بلا تقدير` : ''}</span></div>`
    : '';
  const score = `<div class="dayscore">${rings(focus)}<div><b>${n(doneN)} من ${n(MAX_FOCUS)}</b><span>${st ? `${I('fire', 'f', 'flame')}${daysWord(st)} متتالية` : 'ابدأ سلسلتك اليوم'}</span></div></div>`;

  const remaining = Math.max(0, MAX_FOCUS - doneN);
  const nextHint = !focus.length ? 'اختر أولوياتك الثلاث وابدأ بخطوة واحدة.'
    : remaining === 0 ? 'ممتاز! أنجزت أولوياتك، خذ لحظة لتقدّر تقدمك.'
      : `تبقّى ${n(remaining)} من أولويات اليوم. ابدأ بالأهم.`;

  return `<div class="today-page">
    <section class="today-hero" aria-label="ملخص يومك">
      <div class="today-hero-content">
        <div class="today-eyebrow"><span class="today-live-dot"></span>مساحة التركيز <span class="today-eyebrow-divider">/</span> ${fmtLongDate()}</div>
        <p class="today-greeting">${greeting()}</p>
        <h1>${nextHint}</h1>
        <div class="today-hero-actions">
          <button type="button" data-act="capture" class="today-hero-primary">${I('plus', 'd')} إضافة مهمة جديدة</button>
          <a href="#/dashboard" class="today-hero-secondary">${I('chart', 'd')} شاهد تقدمك</a>
        </div>
      </div>
      <div class="today-hero-progress" aria-label="أُنجزت ${n(doneN)} من ${n(MAX_FOCUS)} أولويات">
        <div class="today-progress-ring">${rings(focus, 146)}<div class="today-progress-center"><b>${n(doneN)}<small> / ${n(MAX_FOCUS)}</small></b><span>مكتملة</span></div></div>
        <div class="today-progress-caption">${st ? `${I('fire', 'f', 'flame')}${daysWord(st)} متتالية` : 'ابدأ سلسلتك اليوم'}</div>
      </div>
    </section>
    ${load.over ? `<p class="warn">${I('scales', 'd')}يومك أثقل من طاقتك بـ${fmtMin(load.minutes - load.cap)}. نقل مهمة إلى الغد أو إسنادها قد يساعدك.</p>` : ''}
    <section class="today-priorities" aria-labelledby="priorities-title">
      <div class="today-section-head">
        <div class="today-section-title"><span class="today-section-mark">${I('bolt', 'i')}</span><div><h2 id="priorities-title">أولويات اليوم</h2><p>ثلاث خطوات أساسية تستحق تركيزك</p></div></div>
        <span class="today-section-count">${n(focus.length)} / ${n(MAX_FOCUS)}</span>
      </div>
      <ol class="three${allWon ? ' allwon' : ''}">${slots}</ol>
      ${loadLine}
      ${allWon ? `<p class="won-msg">${I('sparkle', 'd')}أنجزت الثلاث. ما يأتي بعدها مكسب إضافي، لا التزام.</p>` : ''}
      ${quickAdd({ ctx: 'today' }, full ? 'أضف مهمة إلى اليوم' : 'أضف مهمة أو أولوية جديدة')}
    </section>
    ${sug.length ? `<section class="blk today-list-section"><div class="today-section-head"><div class="today-section-title"><span class="today-section-mark soft">${I('star', 'd')}</span><div><h2>مقترحة لك</h2><p>المهام الأقرب والأكثر أهمية</p></div></div></div>${rows(sug, { pick: true, full })}</section>` : ''}
    ${also.length ? `<section class="blk today-list-section"><div class="today-section-head"><div class="today-section-title"><span class="today-section-mark soft">${I('cal', 'd')}</span><div><h2>أيضاً على جدولك</h2><p>مواعيد ومتابعات تستحق الانتباه</p></div></div><span class="today-section-count">${n(also.length)}</span></div>${rows(also, { pick: !full, full, follow: true })}</section>` : ''}
    ${!focus.length && !sug.length && !also.length ? `<div class="empty today-empty">${I('sun', 'd', 'big')}<p>لا توجد مهام حتى الآن. أضف أول مهمة، ثم اختر ثلاث أولويات فقط لهذا اليوم.</p></div>` : ''}
    ${doneBox(done, 'أنجزت اليوم')}
    <nav class="today-shortcuts" aria-label="انتقال سريع">
      <a href="#/list/planned">${I('cal', 'd')} <span>المهام القادمة</span>${I('back', 'i')}</a>
      <a href="#/goals">${I('flag', 'd')} <span>أهدافي</span>${I('back', 'i')}</a>
      <a href="#/matrix">${I('grid', 'd')} <span>مصفوفة الأولويات</span>${I('back', 'i')}</a>
    </nav>
  </div>`;
}

/* ═════════════ القوائم ═════════════ */
const EMPTY = {
  important: ['star', 'اضغط النجمة بجانب أي مهمة لتظهر هنا.'],
  planned: ['cal', 'المهام التي لها موعد تظهر هنا مرتبة حسب القرب.'],
  assigned: ['people', 'أسند مهمة لشخص بكتابة @الاسم، أو من تفاصيل المهمة، ثم تابعها من هنا.'],
  inbox: ['inbox', 'الوارد فارغ. كل ما تلتقطه دون مجال يصل هنا، وتصنّفه في المراجعة الأسبوعية.'],
  area: ['list', 'لا مهام مفتوحة في هذا المجال.'],
};

function vList() {
  const key = ui.param;
  const smart = SMART[key];
  const area = smart ? null : areaById(key);
  if (!smart && !area) return vToday();
  const all = listTasks(key);
  const open = all.filter(isOpen).sort(byPriority);
  const ctx = smart ? { list: key } : { area: key };
  const icon = smart ? `<span class="vh-i k-${key}">${I(smart.icon, 'd')}</span>` : areaMark(area, 'xl');
  const title = smart ? smart.name : esc(area.name);
  let body;

  if (key === 'planned') {
    const t0 = todayKey();
    const ws = dateKey(addDays(weekStart(), 7));
    const B = [
      ['متأخرة', (t) => t.due < t0], ['اليوم', (t) => t.due === t0], ['غدًا', (t) => t.due === keyAdd(t0, 1)],
      ['هذا الأسبوع', (t) => t.due > keyAdd(t0, 1) && t.due < ws], ['لاحقًا', (t) => t.due >= ws && t.due > keyAdd(t0, 1)],
    ];
    const sorted = open.sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || byPriority(a, b));
    body = B.map(([lbl, f]) => {
      const l = sorted.filter(f);
      return l.length ? `<section class="blk"><p class="lbl${lbl === 'متأخرة' ? ' late' : ''}">${lbl} <span class="cnt">${n(l.length)}</span></p>${rows(l, { follow: true })}</section>` : '';
    }).join('');
  } else if (key === 'assigned') {
    body = people().filter((p) => p.open).map((p) => {
      const l = open.filter((t) => t.assignee === p.name).sort((a, b) => (a.followUp || '9').localeCompare(b.followUp || '9'));
      return `<section class="blk person"><p class="lbl">${avatar(p.name)}${esc(p.name)} <span class="cnt">${n(l.length)}</span></p>${rows(l, { follow: true, hideAssignee: true })}</section>`;
    }).join('');
  } else {
    body = rows(open, { hideArea: !!area });
  }

  const [ei, et] = EMPTY[smart ? key : 'area'];
  const sub = `${n(open.length)} مفتوحة${key === 'inbox' && open.length ? '، صنّفها حين يكون لديك دقيقتان' : ''}`;
  return `${vh(title, sub, area ? `<button class="ib" data-act="edit-area-emoji" data-id="${area.id}" title="تغيير الرمز" aria-label="تغيير رمز المجال">${I('smiley')}</button>` : '', icon)}
    ${quickAdd(ctx, 'أضف مهمة')}
    ${body || `<div class="empty">${I(ei, 'd', 'big')}<p>${et}</p></div>`}
    ${doneBox(all.filter((t) => !isOpen(t)))}`;
}

/* ═════════════ المصفوفة ═════════════ */
function vMatrix() {
  const open = openTasks();
  const quads = QUADRANT_ORDER.map((q) => {
    const l = open.filter((t) => quadrant(t) === q).sort(byPriority);
    return `<section class="quad ${q}" data-quad="${q}">
      <header><div><h2>${QUADRANTS[q].label}</h2><p>${QUADRANTS[q].hint}</p></div>
        <span class="cnt">${n(l.length)}</span>
        <button class="ib" data-act="new-in-quad" data-q="${q}" aria-label="أضف مهمة إلى ${QUADRANTS[q].label}">${I('plus')}</button></header>
      ${rows(l, { drag: true }) || '<p class="qempty">اسحب مهمة إلى هنا</p>'}
    </section>`;
  }).join('');
  const total = open.length || 1;
  const q2 = open.filter((t) => quadrant(t) === 'q2').length;
  return `${vh('المصفوفة', 'هل هي مهمة؟ هل هي عاجلة؟ اسحب المهمة بين المربعات لتغيير تصنيفها.', `<div class="q2meter" title="نسبة المهام في «خطّط لها»"><b>${n(Math.round((q2 / total) * 100))}%</b><span>من عملك استراتيجي</span></div>`)}
    <div class="matrix">${quads}</div>`;
}

/* ═════════════ المراجعة ═════════════ */
function vReview() {
  const ws = addDays(weekStart(), ui.weekOffset * 7);
  const we = addDays(ws, 7);
  const wk = dateKey(ws);
  const inWeek = (iso) => iso && new Date(iso) >= ws && new Date(iso) < we;
  const done = S().tasks.filter((t) => !isOpen(t) && inWeek(t.completedAt));
  const q2 = done.filter((t) => quadrant(t) === 'q2').length;
  const overdue = openTasks().filter(isOverdue);
  const slipped = openTasks().filter((t) => t.slips > 0 || t.snoozes > 1).sort((a, b) => ((b.slips || 0) + (b.snoozes || 0)) - ((a.slips || 0) + (a.snoozes || 0))).slice(0, 8);
  const stuck = openTasks().filter((t) => t.assignee && t.followUp && t.followUp < todayKey());
  const inbox = openTasks().filter((t) => !hasArea(t));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i);
    const k = dateKey(d);
    return { k, c: done.filter((t) => t.completedAt.slice(0, 10) === k).length, lbl: ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'][d.getDay()] };
  });
  const dmax = Math.max(1, ...days.map((d) => d.c));
  const amax = Math.max(1, ...areas().map((a) => done.filter((t) => t.areaId === a.id).length));
  const rev = S().reviews.find((r) => r.id === wk) || {};
  const past = S().reviews.filter((r) => isReviewDoc(r) && r.id !== wk).sort((a, b) => b.id.localeCompare(a.id));
  const isCur = ui.weekOffset === 0;
  const val = (k) => esc(ui.drafts[`rv-${wk}-${k}`] ?? rev[k] ?? '');

  const todo = [
    inbox.length && `<li>${I('inbox', 'd')}<span><b>${n(inbox.length)}</b> في الوارد بلا مجال. <a href="#/list/inbox">صنّفها</a></span></li>`,
    overdue.length && `<li>${I('cal', 'd')}<span><b>${n(overdue.length)}</b> متأخرة. أعد جدولتها أو احذف ما لم يعد مهمًا. <a href="#/list/planned">افتح المخطط</a></span></li>`,
    stuck.length && `<li>${I('people', 'd')}<span><b>${n(stuck.length)}</b> مُسندة فات موعد متابعتها. <a href="#/list/assigned">تابعها</a></span></li>`,
  ].filter(Boolean);

  return `${vh('المراجعة الأسبوعية', `من ${fmtDayMonth(ws)} إلى ${fmtDayMonth(addDays(we, -1))}${isCur ? '، هذا الأسبوع' : ''}`,
    `<div class="seg"><button class="ib" data-act="week" data-d="-1" aria-label="الأسبوع السابق">${I('back')}</button><button class="ib" data-act="week" data-d="1" ${isCur ? 'disabled' : ''} aria-label="الأسبوع التالي">${I('fwd')}</button></div>`)}
  <div class="board">
    <div><b>${n(done.length)}</b><span>مهمة منجزة</span></div>
    <div><b>${n(done.length ? Math.round((q2 / done.length) * 100) : 0)}%</b><span>منها عمل استراتيجي</span></div>
    <div><b>${n(overdue.length)}</b><span>متأخرة الآن</span></div>
    <div><b>${n(streak())}</b><span>أيام متتالية</span></div>
  </div>
  <div class="two-col">
    <section class="panel"><p class="lbl">الإنجاز يومًا بيوم</p>
      <div class="week">${days.map((d) => `<div class="wd${d.k === todayKey() ? ' now' : ''}"><i style="height:${Math.round((d.c / dmax) * 100)}%"></i><b>${d.c ? n(d.c) : ''}</b><span>${d.lbl}</span></div>`).join('')}</div></section>
    <section class="panel"><p class="lbl">توازن المجالات</p>
      <div class="bars">${areas().map((a) => { const c = done.filter((t) => t.areaId === a.id).length; return `<div class="bl" style="--c:${esc(a.color)}"><span>${areaMark(a, 'xs')}${esc(a.name)}</span><div class="bar"><i style="width:${(c / amax) * 100}%"></i></div><b>${n(c)}</b></div>`; }).join('') || '<p class="note">لا مجالات.</p>'}</div></section>
  </div>
  ${isCur && todo.length ? `<section class="blk"><p class="lbl">رتّب قبل أن تبدأ أسبوعك</p><ul class="todo">${todo.join('')}</ul></section>` : ''}
  ${slipped.length ? `<section class="blk"><p class="lbl">تتكرر في الترحيل والتأجيل <span class="cnt">قرّر: صغّرها، أسندها، أو احذفها</span></p>${rows(slipped)}</section>` : ''}
  <form class="panel reflect" data-form="review" data-week="${wk}">
    <label><span>ما الذي أنجزته وأفخر به؟</span><textarea name="wins" data-draft="rv-${wk}-wins" rows="2">${val('wins')}</textarea></label>
    <label><span>ما الذي عطّلني أو شتّتني؟</span><textarea name="blockers" data-draft="rv-${wk}-blockers" rows="2">${val('blockers')}</textarea></label>
    <label><span>أهم ثلاثة أشياء للأسبوع القادم</span><textarea name="next" data-draft="rv-${wk}-next" rows="3">${val('next')}</textarea></label>
    <div class="row"><button class="btn primary" type="submit">حفظ المراجعة</button>${rev.updatedAt ? `<span class="sub">حُفظت ${fmtDate(rev.updatedAt.slice(0, 10))}</span>` : ''}</div>
  </form>
  ${past.length ? `<details class="donebox"><summary>مراجعات سابقة <span class="cnt">${n(past.length)}</span></summary>${past.map((r) => `
    <div class="past"><b>أسبوع ${fmtDate(r.id)}</b>${r.wins ? `<p><span>الإنجاز</span>${esc(r.wins)}</p>` : ''}${r.blockers ? `<p><span>المعطّلات</span>${esc(r.blockers)}</p>` : ''}${r.next ? `<p><span>التالي</span>${esc(r.next)}</p>` : ''}</div>`).join('')}</details>` : ''}`;
}

/* ═════════════ التنقل والقوائم (للجوال) والبحث ═════════════ */
export function navItems() {
  const c = counts();
  const item = (href, icon, label, cnt, cls = '', bad = false) =>
    `<a href="${href}" class="ni ${cls}" data-nav="${href}">${icon}<span>${label}</span>${cnt ? `<em${bad ? ' class="bad"' : ''}>${n(cnt)}</em>` : ''}</a>`;
  const grp = (t) => `<p class="ngrp">${t}</p>`;
  return {
    ctrl: [
      item('#/today', I('today', 'd'), 'اليوم', c.today, 'k-today'),
      item('#/dashboard', I('chart', 'd'), 'لوحة القيادة', 0),
      item('#/all', I('list', 'd'), 'كل المهام', c.all),
      item('#/all/late', I('fire', 'd'), 'المتأخرة', c.late, 'k-late', true),
      item('#/all/waiting', I('hourglass', 'd'), 'بانتظار الاعتماد', c.waiting, 'k-wait'),
    ].join(''),
    smart: Object.entries(SMART).map(([k, s]) => item(`#/list/${k}`, I(s.icon, 'd'), s.name, c[k], `k-${k}`)).join(''),
    views: [
      item('#/matrix', I('grid', 'd'), 'المصفوفة', 0), item('#/goals', I('flag', 'd'), 'هرم الأهداف', S().goals.filter((g) => g.status === 'active').length), item('#/review', I('note', 'd'), 'المراجعة', 0),
    ].join(''),
    lists: areas().map((a) => {
      const late = c[`late:${a.id}`] || 0;
      return `<a href="#/area/${a.id}" class="ni" data-nav="#/area/${a.id}">${areaMark(a, 'sm')}<span>${esc(a.name)}</span>${late ? `<em class="bad" title="${n(late)} متأخرة">${n(late)}</em>` : c[a.id] ? `<em>${n(c[a.id])}</em>` : ''}</a>`;
    }).join(''),
    grp,
  };
}

function vLists() {
  const nv = navItems();
  return `${vh('القوائم')}
    <label class="search big">${I('search')}<input type="search" id="q2" data-act="search" placeholder="ابحث في كل المهام" value="${esc(ui.q)}" /></label>
    <nav class="hub">${nv.ctrl.replace(/<a href="#\/today"[^]*?<\/a>/, '')}<hr />${nv.smart}<hr />${nv.lists}<a href="#/settings#areas" class="ni addlist">${I('plus')}<span>مجال جديد</span></a><hr /><a href="#/settings" class="ni">${I('gear', 'd')}<span>الإعدادات</span></a></nav>`;
}

function vSearch() {
  const q = ui.q.trim();
  const hit = (t) => [t.title, t.notes, t.assignee, t.intent, areaById(t.areaId)?.name, goalById(t.goalId)?.title, ...(t.steps || []).map((s) => s.title)]
    .some((x) => x && x.includes(q));
  const res = q ? S().tasks.filter(hit) : [];
  const open = res.filter(isOpen).sort(byPriority);
  return `${vh(q ? `نتائج «${esc(q)}»` : 'بحث', q ? `${n(open.length)} مفتوحة` : 'ابحث في العنوان والملاحظات والخطوات والأشخاص.')}
    <label class="search big only-m">${I('search')}<input type="search" id="q2" data-act="search" placeholder="ابحث" value="${esc(ui.q)}" /></label>
    ${rows(open) || (q ? `<div class="empty">${I('search', 'i', 'big')}<p>لا نتائج مفتوحة.</p></div>` : '')}
    ${doneBox(res.filter((t) => !isOpen(t)))}`;
}

/* ═════════════ الإعدادات ═════════════ */
const timeOpts = (sel, from, to) => {
  const out = ['<option value="">إيقاف</option>'];
  for (let m = from * 60; m <= to * 60; m += 30) {
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    out.push(`<option value="${v}"${v === sel ? ' selected' : ''}>${fmtTime(v)}</option>`);
  }
  return out.join('');
};

function notifyPanel() {
  const s = settings();
  const perm = notify.permission;
  let state;
  if (!notify.supported) state = `<p>${I('bell')}هذا المتصفح لا يدعم التنبيهات.</p>`;
  else if (notify.needsInstall) state = '<p class="warn">على الآيفون تعمل التنبيهات فقط من التطبيق المضاف إلى الشاشة الرئيسية: افتحه في Safari، ثم مشاركة، ثم «إضافة إلى الشاشة الرئيسية»، وافتحه من أيقونته.</p>';
  else if (perm === 'denied') state = '<p class="warn">التنبيهات مرفوضة لهذا الموقع. فعّلها من إعدادات المتصفح أو الجهاز، ثم عد هنا.</p>';
  else if (perm !== 'granted') state = `<p>فعّل التنبيهات ليذكّرك التطبيق في الوقت الذي تحدّده، ويرسل لك خطة الصباح وإغلاق اليوم.</p><div class="row"><button class="btn primary" data-act="notify-on">${I('bell', 'd')}فعّل التنبيهات على هذا الجهاز</button></div>`;
  else if (notify.pushed) state = `<p class="ok">${I('check')}مفعّلة، وتصلك حتى والتطبيق مغلق.</p><div class="row"><button class="btn" data-act="notify-test">أرسل تنبيهًا تجريبيًا</button><button class="btn ghost" data-act="notify-off">إيقاف على هذا الجهاز</button></div>`;
  else if (notify.serverReady && store.mode === 'cloud') state = `<p>مفعّلة والتطبيق مفتوح فقط. اربط هذا الجهاز بخادم التنبيهات لتصلك والتطبيق مغلق.</p><div class="row"><button class="btn primary" data-act="notify-on">${I('bell', 'd')}اربط هذا الجهاز</button></div>`;
  else state = `<p class="ok">${I('check')}مفعّلة والتطبيق مفتوح أو مصغّر.</p><p class="note">لتصلك والتطبيق مغلق (خاصة على الآيفون) يلزم تشغيل خادم التنبيهات المجاني مرة واحدة: الخطوات في <code>worker/README.md</code>.</p>`;

  return `<section class="panel" id="notify"><h2>${I('bell', 'd')}التنبيهات</h2>${state}
    <div class="srow"><span>${I('sun', 'd')}خطة الصباح</span><select class="in sm" data-set="morning" aria-label="وقت خطة الصباح">${timeOpts(s.morning, 5, 11)}</select></div>
    <div class="srow"><span>${I('moon', 'd')}إغلاق اليوم</span><select class="in sm" data-set="evening" aria-label="وقت إغلاق اليوم">${timeOpts(s.evening, 14, 23)}</select></div>
    <div class="srow"><span>${I('scales', 'd')}ساعات التركيز المتاحة يوميًا</span><div class="seg">${[4, 5, 6, 7, 8].map((h) => `<button class="${Number(s.capacity) === h ? 'on' : ''}" aria-pressed="${Number(s.capacity) === h}" data-act="set-capacity" data-v="${h}">${h}</button>`).join('')}</div></div>
    <p class="note">كل مهمة لها تذكير تصلك مرتين: في موعدها، ثم بعد نصف ساعة إن لم تُنجز. وكل تأجيل يُحسب ويظهر لك.</p>
  </section>`;
}

function vSettings() {
  const m = store.mode;
  let sync;
  if (m === 'local') sync = '<p>يعمل التطبيق على هذا الجهاز فقط. لتفعيل المزامنة أضف إعدادات Firebase في <code>js/config.js</code> (الخطوات في README).</p>';
  else if (m === 'cloud-error') sync = '<p>تعذّر تحميل خدمة المزامنة (غالبًا لا يوجد اتصال). تعمل النسخة المحلية الآن، وتعود المزامنة عند فتح التطبيق مع اتصال.</p>';
  else if (m === 'cloud-signed-out') {
    sync = `<p>سجّل الدخول لمزامنة بياناتك بين أجهزتك. أول دخول يرفع ما على هذا الجهاز إلى حسابك.</p>
      <form data-form="auth" autocomplete="on" class="stack">
        <label class="fld"><span>البريد الإلكتروني</span><input class="in" type="email" name="email" autocomplete="email" required dir="ltr" /></label>
        <label class="fld"><span>كلمة المرور</span><input class="in" type="password" name="password" autocomplete="current-password" minlength="6" required dir="ltr" /></label>
        <div class="row"><button class="btn primary" type="submit" name="op" value="in">دخول</button><button class="btn" type="submit" name="op" value="up">إنشاء حساب</button><button class="btn ghost" type="submit" name="op" value="reset" formnovalidate>نسيت كلمة المرور</button></div>
      </form>`;
  } else {
    sync = `<p>متصل بحساب <b dir="ltr">${esc(store.user?.email || '')}</b>. أي تغيير يظهر على أجهزتك الأخرى خلال ثوانٍ، ويعمل التطبيق دون إنترنت ثم يزامن.</p>
      <div class="row"><button class="btn" data-act="signout">تسجيل الخروج</button></div>`;
  }
  const swatches = (a) => AREA_COLORS.map((c) => `<button type="button" class="sw${c === a.color ? ' on' : ''}" style="--c:${c}" data-act="area-color" data-id="${a.id}" data-v="${c}" aria-label="اللون ${c}"></button>`).join('');
  const areaRows = areas().map((a) => `
    <div class="arow2">
      <form class="arow" data-form="area" data-id="${a.id}">
        <button type="button" class="emo-btn" data-act="edit-area-emoji" data-id="${a.id}" style="--c:${esc(a.color)}" aria-label="رمز ${esc(a.name)}">${a.emoji ? esc(a.emoji) : I('smiley')}</button>
        <input class="in" name="name" value="${esc(a.name)}" required maxlength="40" aria-label="اسم المجال" />
        <button class="btn sm" type="submit">حفظ</button>
        <button class="ib" type="button" data-act="del-area" data-id="${a.id}" aria-label="حذف ${esc(a.name)}">${I('trash')}</button>
      </form>
      <div class="swatches">${swatches(a)}</div>
    </div>`).join('');

  return `${vh('الإعدادات')}
  <div class="settings">
    <section class="panel"><h2>${I('sparkle', 'i')}المظهر</h2>
      <p class="note">ثلاثة ثيمات بألوان ثابتة مريحة لا تتأثر بالوضع الداكن للجهاز.</p>
      <div class="chips" style="margin-top:10px">${[['petrol', 'بترولي فاخر'], ['navy', 'كحلي فاخر'], ['aqua', 'سماوي وفوشيا']].map(([k, l]) => `<button class="chip-b${env.theme === k ? ' on' : ''}" data-act="theme" data-v="${k}" aria-pressed="${env.theme === k}">${l}</button>`).join('')}</div></section>
    <section class="panel"><h2>${I('user', 'i')}اسمك</h2>
      <form class="arow" data-form="name"><input class="in" name="name" value="${esc(localName())}" maxlength="30" placeholder="يظهر في التحية" /><button class="btn sm" type="submit">حفظ</button></form></section>
    ${notifyPanel()}
    <section class="panel"><h2>${I('mic', 'd')}الإدخال الصوتي ومحضر الاجتماع</h2>
      ${!pushConfig?.url ? '<p class="note">يعمل بعد تشغيل خادم التطبيق (نفس خادم التنبيهات). حتى ذلك الحين يظهر زر الميكروفون لكنه لا يعمل.</p>'
    : store.mode !== 'cloud' ? '<p class="warn">سجّل الدخول للمزامنة أولًا.</p>'
      : '<p class="ok">جاهز. اضغط الميكروفون بجانب حقل الإضافة وتكلّم، أو افتح أي اجتماع واضغط «سجّل محضر الاجتماع».</p>'}
      <ul class="steps"><li>الصوت يُحوَّل إلى نص على خادمك ثم يُحذف، ولا يُضاف شيء قبل أن تراجعه.</li><li>الحد المجاني يكفي نحو ساعتين ونصف من التفريغ يوميًا.</li><li>على الآيفون: افتح التطبيق من أيقونة الشاشة الرئيسية واسمح بالميكروفون.</li></ul></section>
    <section class="panel"><h2>${I('arrow', 'i')}المزامنة</h2>${sync}</section>
    <section class="panel" id="areas"><h2>${I('list', 'd')}المجالات</h2>${areaRows}
      <form class="arow" data-form="new-area">
        <span class="emo-btn ghost">${I('plus')}</span>
        <input class="in" name="name" placeholder="مجال جديد" required maxlength="40" />
        <button class="btn sm primary" type="submit">إضافة</button>
      </form></section>
    <section class="panel"><h2>${I('bolt', 'i')}الكتابة السريعة</h2>
      <ul class="steps">
        <li><b>!</b> مهم، و <b>!!</b> مهم وعاجل. مثال: <code>تقرير الرواتب !!</code></li>
        <li><b>@الاسم</b> يُسند المهمة لشخص ويحدد متابعة بعد يومين. للاسم المركّب: <code>@محمد_علي</code></li>
        <li><b>#المجال</b> يكفي أول حروفه. مثال: <code>#أسس</code></li>
        <li>اختصارات لوحة المفاتيح: <kbd>N</kbd> مهمة جديدة، <kbd>/</kbd> بحث، <kbd>Esc</kbd> إغلاق.</li>
      </ul></section>
    <section class="panel"><h2>${I('share', 'i')}التثبيت والـWidget</h2>
      ${env.installPrompt ? '<div class="row" style="margin-bottom:10px"><button class="btn primary" data-act="install">تثبيت التطبيق على هذا الجهاز</button></div>' : ''}
      <ul class="steps">
        <li><b>ويندوز:</b> افتح الرابط في Edge أو Chrome، ثم قائمة المتصفح، ثم «تثبيت مركز القيادة».</li>
        <li><b>آيفون:</b> افتح الرابط في Safari، ثم زر المشاركة، ثم «إضافة إلى الشاشة الرئيسية».</li>
        <li><b>الـWidget:</b> نافذة صغيرة تعرض أولويات اليوم فقط، ضعها في زاوية الشاشة.</li>
      </ul>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="open-widget">فتح نافذة الـWidget</button></div></section>
    <section class="panel"><h2>${I('tray', 'i')}نسخة احتياطية</h2>
      <p class="note">التصدير يحفظ كل بياناتك في ملف. استيراد النسخة الاحتياطية يستبدل البيانات الحالية. أما ملف الإعداد القديم (<code>command-center-setup.json</code>) فيُدمج دون حذف شيء.</p>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-act="export">تصدير</button>
        <label class="btn">استيراد<input type="file" accept="application/json,.json" data-act="import" hidden /></label>
      </div></section>
    <section class="panel"><h2>${I('sparkle', 'i')}الإصدار</h2>
      <p class="note">الإصدار المثبّت على هذا الجهاز: <b dir="ltr">${esc(env.appVersion || '—')}</b>. التحديثات تصل تلقائيًا عند فتح التطبيق مع اتصال.</p>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="check-update">البحث عن تحديث الآن</button></div></section>
  </div>`;
}

/* ═════════════ المحضر (قابل للطباعة كـPDF) ═════════════ */
function vMinutes() {
  const t = ui.param ? S().tasks.find((x) => x.id === ui.param) : null;
  const m = t?.minutes;
  if (!m) return `${vh('المحضر')}<div class="empty">${I('doc', 'd', 'big')}<p>لا محضر لهذا الاجتماع بعد. افتح الاجتماع واضغط «سجّل محضر الاجتماع».</p></div>`;
  const a = hasArea(t) ? areaById(t.areaId) : null;
  const list = (arr) => (arr?.length ? `<ol>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '<p class="note">لا شيء.</p>');
  const when = t.due ? `${fmtDate(t.due)}${t.time ? ` ${fmtTime(t.time)}` : ''}` : fmtDate(m.at.slice(0, 10));
  return `<article class="minutes">
    <header class="min-h"><p class="min-k">محضر اجتماع</p><h1>${esc(t.title)}</h1>
      <p class="sub">${esc(when)}${t.place ? ` · ${esc(t.place)}` : ''}${a ? ` · ${esc(a.name)}` : ''}</p>
      <div class="row no-print"><button class="btn primary" data-act="print">${I('print')}طباعة أو حفظ PDF</button><button class="btn" data-act="open" data-id="${t.id}">فتح الاجتماع</button></div></header>
    ${m.attendees?.length ? `<section><h2>الحضور</h2><p>${m.attendees.map(esc).join('، ')}</p></section>` : ''}
    <section><h2>الملخص</h2><p>${esc(m.summary || '—')}</p></section>
    <section><h2>القرارات</h2>${list(m.decisions)}</section>
    <section><h2>المطلوب</h2>${m.actions?.length ? `<table class="db-team"><thead><tr><th>المطلوب</th><th>المسؤول</th><th>الموعد</th><th>الحالة</th></tr></thead><tbody>${m.actions.map((x) => { const tk = x.taskId ? S().tasks.find((y) => y.id === x.taskId) : null; return `<tr><td>${esc(x.title)}</td><td>${esc(x.owner || '—')}</td><td>${x.due ? fmtDate(x.due) : '—'}</td><td>${tk ? (isOpen(tk) ? 'مفتوحة' : 'منجزة') : '—'}</td></tr>`; }).join('')}</tbody></table>` : '<p class="note">لا شيء.</p>'}</section>
    ${m.dates?.length ? `<section><h2>مواعيد قادمة</h2><ul>${m.dates.map((d) => `<li>${esc(d.what)}${d.date ? ` — ${fmtDate(d.date)}` : ''}</li>`).join('')}</ul></section>` : ''}
    ${m.transcript ? `<details class="no-print"><summary>النص الكامل المفرّغ</summary><p class="transcript">${esc(m.transcript)}</p></details>` : ''}
    <p class="note min-f">أُعدّ بمساعدة الذكاء الاصطناعي من تسجيل الاجتماع، وروجع قبل الحفظ · ${fmtDate(m.at.slice(0, 10))}</p>
  </article>`;
}

/* ═════════════ الـWidget ═════════════ */
function vWidget() {
  const focus = focusToday();
  const doneN = focus.filter((t) => !isOpen(t)).length;
  const slots = Array.from({ length: MAX_FOCUS }, (_, i) => {
    const t = focus[i];
    return `<li class="slot${t ? (isOpen(t) ? '' : ' won') : ' vacant'}"><span class="num">${n(i + 1)}</span>${t ? `<ul class="tl">${row(t, { inToday: true, hideGoal: true })}</ul>` : '<p>—</p>'}</li>`;
  }).join('');
  return `<div class="widget">
    <header>${rings(focus, 44)}<div><b>أولويات اليوم</b><span>${n(doneN)} من ${n(MAX_FOCUS)}، ${fmtDate(todayKey())}</span></div></header>
    <ol class="three">${slots}</ol>
    <a class="wopen" href="#/today" data-act="widget-open">فتح مركز القيادة</a>
  </div>`;
}

export const ROUTES = {
  today: vToday, list: vList, area: vList, matrix: vMatrix, goals: () => vPyramid({ I, vh, ui }), review: vReview,
  dashboard: () => vDash({ I, areaMark, row, vh }), all: () => vAll({ I, row, vh, ui }), minutes: vMinutes, lists: vLists, search: vSearch, settings: vSettings, widget: vWidget,
};

/* ═════════════ لوحة التفاصيل ═════════════ */
function whenLabel(t) {
  if (!t.due) return 'أضف موعدًا وتذكيرًا';
  return [relDay(t.due), t.time ? fmtTime(t.time) : ''].filter(Boolean).join('، ');
}
const fireFmt = new Intl.DateTimeFormat('ar-u-nu-latn', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function pane(t) {
  if (!t) return '';
  const done = !isOpen(t);
  const q = quadrant(t);
  const steps = t.steps || [];
  const inFocus = isFocus(t);
  const full = focusToday().length >= MAX_FOCUS;
  const ppl = people().map((p) => `<option value="${esc(p.name)}">`).join('');
  const fire = taskFireAt(t);
  const a = hasArea(t) ? areaById(t.areaId) : null;
  const g = t.goalId ? goalById(t.goalId) : null;
  const meet = t.kind === 'meeting';
  const more = ui.paneMore;

  // البومودورو: جلسات منجزة مقابل المقدّرة (٢٥ دقيقة للجلسة)
  const planned = t.est ? Math.min(8, Math.max(1, Math.ceil(t.est / 25))) : 0;
  const pomos = t.pomos || 0;
  const dots = Array.from({ length: Math.max(planned, Math.min(pomos, 8)) }, (_, i) => `<i class="${i < pomos ? 'on' : ''}"></i>`).join('');
  const pomoTxt = pomos || planned
    ? `${n(pomos)}${planned ? ` من ${n(planned)}` : ''} ${pomos === 1 && !planned ? 'جلسة' : 'جلسات'}${t.spent ? ` · ${fmtMin(t.spent)}` : ''}`
    : 'جلسة واحدة ٢٥ دقيقة تكفي لتبدأ';

  // ملخص هادئ لما هو مضبوط فعلًا؛ التفاصيل كلها خلف زر واحد
  const chips = [];
  if (a) chips.push(`<span class="m">${areaMark(a, 'xs')}${esc(a.name)}</span>`);
  if (g) chips.push(`<span class="m">${g.emoji ? `<span class="em">${esc(g.emoji)}</span>` : I('flag')}${esc(g.title)}</span>`);
  if (t.important || t.urgent) chips.push(`<span class="m">${QUADRANTS[q].label}</span>`);
  if (t.est) chips.push(`<span class="m">${I('hourglass')}${fmtMin(t.est)}</span>`);
  if (t.repeat) chips.push(`<span class="m">${I('repeat')}${REPEATS[t.repeat]}</span>`);
  if (t.assignee) chips.push(`<span class="m ${followDue(t) ? 'late' : ''}">${avatar(t.assignee)}${esc(t.assignee)}</span>`);
  if (isWaiting(t)) chips.push(`<span class="m m-wait">${I('hourglass')}بانتظار الاعتماد</span>`);
  if (t.parked) chips.push(`<span class="m m-wait">${I('hourglass')}تنتظر دورها في الهدف</span>`);
  if (t.notes) chips.push(`<span class="m">${I('note')}ملاحظات</span>`);

  const meetBlock = meet ? `<div class="pblk meetblk">
      <div class="prow static">${I('pin')}<span>المكان</span><input class="in sm" data-f="place" value="${esc(t.place || '')}" maxlength="120" placeholder="المكتب، أونلاين…" aria-label="مكان الاجتماع" /></div>
      <div class="prow static">${I('clock')}<span>المدة</span><div class="seg sm">${[30, 60, 90, 120].map((m) => `<button class="${(t.duration || 60) === m ? 'on' : ''}" aria-pressed="${(t.duration || 60) === m}" data-act="set-dur" data-v="${m}">${fmtMin(m)}</button>`).join('')}</div></div>
      <button class="prow" data-act="ics" data-id="${t.id}">${I('calplus', 'i')}<span>أضف لتقويم الجوال<small>${t.due ? 'ملف تقويم بتنبيه قبل ١٥ دقيقة' : 'حدّد موعد الاجتماع أولًا'}</small></span></button>
      ${t.minutes ? `<a class="prow" href="#/minutes/${t.id}">${I('doc', 'd')}<span><b>المحضر</b><small>${n(t.minutes.decisions?.length || 0)} قرار، ${n(t.minutes.actions?.length || 0)} مطلوب</small></span></a>` : ''}
      <button class="prow" data-act="minutes" data-id="${t.id}">${I('mic', 'd')}<span>${t.minutes ? 'محضر جديد يحلّ محل الحالي' : 'سجّل محضر الاجتماع'}<small>تسجيل أو نص ← قرارات ومهام مُسندة</small></span></button>
    </div>` : '';

  return `<div class="pane-in calm q-${q}${done ? ' done' : ''}" data-id="${t.id}">
    <div class="pane-top">
      <button class="ib only-m" data-act="close-pane" aria-label="رجوع">${I('back')}</button>
      <span class="quadtag">${meet ? 'اجتماع' : QUADRANTS[q].label}</span>
      <span class="spacer"></span>
      <button class="ib only-d" data-act="close-pane" aria-label="إغلاق التفاصيل">${I('x')}</button>
    </div>
    ${(t.slips >= 3 || t.snoozes >= 3) && !done ? `<div class="decide"><b>${I('fire', 'f', 'flame')}${t.slips >= 3 ? `رُحّلت ${n(t.slips)} مرات` : `أُجّلت ${n(t.snoozes)} مرات`}.</b> المهمة التي تتكرر في التأجيل غالبًا كبيرة أو غير واضحة أو ليست لك. اختر:
      <div class="row"><button class="btn sm" data-act="focus-steps">قسّمها إلى خطوات</button><button class="btn sm" data-act="focus-assign">أسندها</button><button class="btn sm" data-act="reset-slips">سأنجزها، صفّر العدّاد</button></div></div>` : ''}
    <div class="ph">
      <button class="ck big" data-act="toggle" data-id="${t.id}" aria-label="${done ? 'إلغاء الإنجاز' : 'إنجاز'}">${I('check')}</button>
      <textarea class="ptitle" id="p-title" data-f="title" rows="1" maxlength="200" aria-label="عنوان المهمة">${esc(t.title)}</textarea>
      <button class="star${t.important ? ' on' : ''}" data-act="star" data-id="${t.id}" aria-pressed="${!!t.important}" aria-label="مهم">${I('star', t.important ? 'f' : 'i')}</button>
    </div>

    ${!done && !meet ? `<div class="pomo">
      <div class="pomo-i"><span class="pomo-dots" aria-hidden="true">${dots || '<i></i>'}</span><span class="pomo-t">${pomoTxt}</span></div>
      <button class="btn primary pomo-go" data-act="pomo-start" data-id="${t.id}">${I('play', 'f')}ابدأ تركيز ٢٥ د</button>
    </div>` : ''}

    <div class="pblk">
      <button class="prow when${t.due ? ' on' : ''}${isOverdue(t) ? ' late' : ''}" data-act="pick-due">${I(t.time ? 'clock' : 'cal', 'd')}<span><b>${esc(whenLabel(t))}</b>${t.remind != null && t.due ? `<small>${I('bell')}${REMINDS[t.remind]}${fire ? `، ${fireFmt.format(fire)}` : ''}</small>` : ''}${t.intent ? `<small class="intent">«${esc(t.intent)}»</small>` : ''}</span>${I('fwd')}</button>
      ${!done ? `<button class="prow${inFocus ? ' on' : ''}" data-act="${inFocus ? 'unfocus' : 'focus'}" data-id="${t.id}" ${!inFocus && full ? 'disabled' : ''}>${I('today', 'd')}<span>${inFocus ? 'ضمن أولويات اليوم' : full ? 'أولويات اليوم ممتلئة (٣)' : 'أضف إلى أولويات اليوم'}</span>${inFocus ? `<em>${I('x')}</em>` : ''}</button>` : ''}
      ${globalThis.CC_BACKEND ? `<button class="prow${t.shared ? ' on' : ''}" data-act="share" data-id="${t.id}" aria-pressed="${!!t.shared}">${I('people', 'd')}<span><b>${t.shared ? 'يراها مديرك (اضغط للإخفاء)' : 'خاصة بي'}</b><small>${t.shared ? 'للقراءة فقط، لمن فوقك في الهيكل' : 'اضغط لإظهارها لمديرك'}</small></span></button>` : ''}
    </div>

    <div class="psteps" id="steps">
      ${steps.map((s, i) => `<div class="step${s.done ? ' done' : ''}">
        <button class="ck sm" data-act="step-toggle" data-i="${i}" aria-label="إنجاز الخطوة">${I('check')}</button>
        <textarea class="sin" id="st-${s.id}" data-step="${i}" rows="1" maxlength="400" aria-label="خطوة">${esc(s.title)}</textarea>
        <button class="ib xs" data-act="step-del" data-i="${i}" aria-label="حذف الخطوة">${I('x')}</button></div>`).join('')}
      <form class="step add" data-form="step"><span class="ck sm ghost">${I('plus')}</span><textarea class="sin" id="p-newstep" name="title" rows="1" placeholder="${steps.length ? 'خطوة تالية' : 'أصغر خطوة تبدأ بها (اختياري)'}" maxlength="400"></textarea></form>
    </div>

    ${meetBlock}

    <button class="pmore${more ? ' open' : ''}" data-act="pane-more" aria-expanded="${more}" aria-controls="p-more">
      <span class="pmore-l">${more ? 'إخفاء التفاصيل' : 'التفاصيل'}</span>
      ${!more && chips.length ? `<span class="pmore-c">${chips.join('')}</span>` : ''}
      ${I(more ? 'x' : 'down')}</button>

    ${more ? `<div id="p-more" class="pmore-b">
    <div class="pblk">
      <div class="prow static">${I('list', 'd')}<span>المجال</span><select class="in sm" data-f="areaId" aria-label="المجال">${areaOptions(t.areaId)}</select></div>
      <div class="prow static">${I('flag', 'd')}<span>الهدف</span><select class="in sm" data-f="goalId" aria-label="الهدف">${goalOptions(t.goalId)}</select></div>
    </div>
    <div class="pblk">
      <div class="prow static">${I('hourglass', 'd')}<span>الوقت المتوقع</span>
        <div class="seg sm">${ESTS.map((m) => `<button class="${t.est === m ? 'on' : ''}" aria-pressed="${t.est === m}" data-act="set-est" data-v="${m}">${fmtMin(m)}</button>`).join('')}</div></div>
      <div class="prow static">${I('grid', 'd')}<span>التصنيف</span>
        <label class="chip-t"><input type="checkbox" data-f="important" ${t.important ? 'checked' : ''} /> مهم</label>
        <label class="chip-t"><input type="checkbox" data-f="urgent" ${t.urgent ? 'checked' : ''} /> عاجل</label></div>
      <div class="prow static">${I('repeat')}<span>التكرار</span><select class="in sm" data-f="repeat" aria-label="التكرار"><option value="">لا يتكرر</option>${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}"${t.repeat === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="pblk" id="assign">
      <div class="prow static">${I('people', 'd')}<span>مُسندة إلى</span><input class="in sm" id="p-assignee" data-f="assignee" list="ppl" value="${esc(t.assignee || '')}" placeholder="أنا المسؤول" maxlength="40" /><datalist id="ppl">${ppl}</datalist></div>
      ${t.assignee ? `<button class="prow" data-act="pick-follow">${I('bell', 'd')}<span><b>المتابعة القادمة: ${t.followUp ? relDay(t.followUp) : 'بلا موعد'}</b><small>أُسندت ${t.assignedAt ? `قبل ${daysWord(Math.max(0, daysBetween(t.assignedAt, todayKey())))}` : ''}${followDue(t) ? '، وحان موعد المتابعة' : ''}</small></span>${I('fwd')}</button>
        <div class="hint"><button class="link" data-act="followed" data-id="${t.id}">تابعت اليوم</button></div>` : ''}
      ${!done ? `<button class="prow${isWaiting(t) ? ' on wait' : ''}" data-act="waiting" data-id="${t.id}" aria-pressed="${isWaiting(t)}">${I('hourglass', 'd')}<span>${isWaiting(t) ? `<b>بانتظار الاعتماد</b><small>منذ ${t.waitingSince ? relDay(t.waitingSince) : 'اليوم'}. لا تُحسب متأخرة عليك.</small>` : 'بانتظار اعتماد أو موافقة من غيري'}</span></button>` : ''}
      <button class="prow${meet ? ' on' : ''}" data-act="meeting-toggle" data-id="${t.id}" aria-pressed="${meet}">${I('meet', 'd')}<span>${meet ? 'اجتماع (اضغط لإلغاء)' : 'هذا اجتماع'}</span></button>
    </div>
    <textarea class="pnotes" id="p-notes" data-f="notes" maxlength="4000" placeholder="ملاحظات، روابط، تفاصيل…" aria-label="ملاحظات">${esc(t.notes || '')}</textarea>
    </div>` : ''}

    <footer class="pfoot"><span>${done ? `أُنجزت ${fmtDate((t.completedAt || '').slice(0, 10))}` : t.createdAt ? `أُنشئت ${fmtDate(t.createdAt.slice(0, 10))}` : ''}</span>
      <button class="ib" data-act="del-task" data-id="${t.id}" aria-label="حذف المهمة" title="حذف">${I('trash')}</button></footer>
  </div>`;
}

/* ═════════════ لحظة القرار (عند فتح تنبيه) ═════════════ */
export function commitSheet(t) {
  const step = (t.steps || []).find((s) => !s.done);
  return `<div class="commit">
    <div class="cap-h"><p class="pk-t">${I('alarm', 'd')}حان وقتها</p><button class="ib" data-act="close" aria-label="إغلاق">${I('x')}</button></div>
    <h2>${esc(t.title)}</h2>
    ${t.intent ? `<p class="intent-q">قلت لنفسك: «${esc(t.intent)}»</p>` : ''}
    ${step ? `<p class="sub">أول خطوة: ${esc(step.title)}</p>` : ''}
    <button class="btn primary big" data-act="commit-start" data-id="${t.id}">${I('play', 'f')}ابدأ الآن، 25 دقيقة تركيز</button>
    <div class="commit-later"><span>ليس الآن؟</span>
      <button class="chip-b" data-act="commit-snooze" data-id="${t.id}" data-v="15">بعد 15 د</button>
      <button class="chip-b" data-act="commit-snooze" data-id="${t.id}" data-v="60">بعد ساعة</button>
      <button class="chip-b" data-act="commit-snooze" data-id="${t.id}" data-v="tomorrow">غدًا</button>
    </div>
    ${(t.snoozes || 0) >= 1 ? `<p class="note">${I('fire', 'f', 'flame')}أجّلتها ${n(t.snoozes)} ${t.snoozes === 1 ? 'مرة' : 'مرات'}. التأجيل الثالث يعني أنها تحتاج تقسيمًا أو إسنادًا.</p>` : ''}
    <button class="link" data-act="commit-done" data-id="${t.id}">أنجزتها بالفعل</button>
  </div>`;
}

/* ═════════════ وضع التركيز ═════════════ */
export const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
export function focusView(t) {
  if (!t) return '';
  const steps = t.steps || [];
  const T = ui.timer;
  const pct = 1 - T.left / T.total;
  const c = 2 * Math.PI * 92;
  const brk = T.mode === 'break';
  const sess = (t.pomos || 0) + (brk ? 0 : 1);
  return `<div class="fx-in${brk ? ' fx-break' : ''}">
    <button class="ib fx-close" data-act="end-focus" aria-label="إنهاء التركيز">${I('x')}</button>
    <p class="fx-lbl">${brk ? 'استراحة. قم وتحرّك واشرب ماءً' : `ركّز على شيء واحد · الجلسة ${n(sess)}`}</p>
    <h2 class="fx-title">${esc(t.title)}</h2>
    <div class="fx-clock"><svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="92" class="trk"/><circle cx="100" cy="100" r="92" class="arc" id="fx-arc" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}"/></svg>
      <b id="fx-time">${fmtClock(T.left)}</b></div>
    <div class="fx-ctl">
      ${brk ? `<button class="btn" data-act="fx-skip">تخطَّ الاستراحة</button>` : [15, 25, 50].map((m) => `<button class="chip-b${T.total === m * 60 ? ' on' : ''}" aria-pressed="${T.total === m * 60}" data-act="fx-len" data-m="${m}">${n(m)} د</button>`).join('')}
      <button class="btn primary fx-go" data-act="fx-toggle">${T.running ? `${I('pause')}إيقاف مؤقت` : `${I('play', 'f')}${T.left < T.total ? 'استئناف' : 'ابدأ'}`}</button>
    </div>
    ${steps.length && !brk ? `<ul class="fx-steps">${steps.map((s, i) => `<li class="${s.done ? 'done' : ''}"><button class="ck sm" data-act="step-toggle" data-i="${i}" data-id="${t.id}">${I('check')}</button><span>${esc(s.title)}</span></li>`).join('')}</ul>` : ''}
    <form class="fx-catch" data-form="catch"${brk ? ' hidden' : ''}><label>${I('brain', 'd')}<input name="title" id="fx-catch" maxlength="200" placeholder="فكرة طارئة؟ اكتبها هنا لتذهب للوارد، وعد للتركيز" /></label></form>
    <button class="btn fx-done" data-act="toggle" data-id="${t.id}" data-end="1">${I('check')}أنجزتها</button>
  </div>`;
}
