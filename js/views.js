// الشاشات: دوال تُرجع HTML من الحالة. كل الأحداث في app.js عبر data-act.

import { store } from './store.js';
import {
  todayKey, weekStart, dateKey, addDays, keyAdd, daysBetween, fmtDate, fmtLongDate, fmtDayMonth, n, esc,
  quadrant, QUADRANTS, QUADRANT_ORDER, AREA_COLORS, REPEATS, relDay, initials, personColor,
} from './utils.js';
import {
  S, MAX_FOCUS, areas, areaById, goalById, taskById, isOpen, openTasks, isOverdue, isFocus, hasArea, byPriority,
  focusToday, alsoToday, doneToday, suggestions, goalTasks, goalProgress, people, streak, SMART, listTasks, counts, followDue,
} from './model.js';

export const ui = {
  route: 'today', param: null, sel: null, q: '', weekOffset: 0, drafts: {},
  focusId: null, timer: { total: 25 * 60, left: 25 * 60, running: false, endAt: 0 }, justDone: null,
};
export const env = { installPrompt: null };

/* ───────── أيقونات (خط واحد، 24×24) ───────── */
const P = {
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.8c1.8.6 3 2.2 3.5 4.7"/>',
  inbox: '<path d="M3.5 13.5l2.4-7.2A2 2 0 0 1 7.8 5h8.4a2 2 0 0 1 1.9 1.3l2.4 7.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h4.5l1.5 2.5h5l1.5-2.5h4.5"/>',
  grid: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.8"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.8"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.8"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.8"/>',
  flag: '<path d="M5.5 21V4M5.5 4.5h11.5l-2.3 4 2.3 4H5.5"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M2.5 20.5h19"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  repeat: '<path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19l-3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5l3 3"/>',
  steps: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M3.8 6.5l1.3 1.3 2.3-2.6M3.8 12l1.3 1.3 2.3-2.6"/><circle cx="5.3" cy="17.5" r="1.2"/>',
  note: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8.5h5M9 13h7M9 16.5h5"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13.5h9l1-13.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  back: '<path d="M9 5l7 7-7 7"/>',
  list: '<path d="M8.5 6.5h11.5M8.5 12h11.5M8.5 17.5h11.5"/><circle cx="4.5" cy="6.5" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17.5" r="1"/>',
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6"/>',
  bolt: '<path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  bell: '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
};
export const I = Object.fromEntries(Object.entries(P).map(([k, d]) => [k, `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`]));

/* ───────── مكوّنات صغيرة ───────── */
const areaDot = (a) => `<i class="dot" style="--c:${esc(a.color)}"></i>`;
const avatar = (name) => `<span class="ava" style="--c:${personColor(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
const plural = (k, one, two, few, many) => (k === 1 ? one : k === 2 ? two : k <= 10 ? `${n(k)} ${few}` : `${n(k)} ${many}`);
const daysWord = (k) => plural(k, 'يوم', 'يومان', 'أيام', 'يومًا');

/** صف المهمة — لغة واحدة في كل الشاشات. */
export function row(t, o = {}) {
  const q = quadrant(t);
  const done = !isOpen(t);
  const meta = [];
  if (!o.hideArea && hasArea(t)) { const a = areaById(t.areaId); meta.push(`<span class="m">${areaDot(a)}${esc(a.name)}</span>`); }
  if (!o.inToday && isFocus(t) && !done) meta.push(`<span class="m m-focus">${I.target}ضمن الثلاثة</span>`);
  if (t.due) meta.push(`<span class="m ${isOverdue(t) ? 'late' : t.due === todayKey() && !done ? 'soon' : ''}">${I.cal}${relDay(t.due)}</span>`);
  if (t.steps?.length) meta.push(`<span class="m">${I.steps}${n(t.steps.filter((s) => s.done).length)}/${n(t.steps.length)}</span>`);
  if (t.repeat) meta.push(`<span class="m" title="${REPEATS[t.repeat] || ''}">${I.repeat}</span>`);
  if (t.assignee && !o.hideAssignee) meta.push(`<span class="m ${followDue(t) ? 'late' : ''}">${avatar(t.assignee)}${esc(t.assignee)}${followDue(t) ? '، حان موعد المتابعة' : ''}</span>`);
  if (!o.hideGoal && t.goalId && goalById(t.goalId)) meta.push(`<span class="m">${I.flag}${esc(goalById(t.goalId).title)}</span>`);
  if (t.slips >= 2 && !done) meta.push(`<span class="m slip">رُحّلت ${n(t.slips)} مرات</span>`);
  if (t.notes) meta.push(`<span class="m" title="ملاحظات">${I.note}</span>`);

  const acts = [];
  if (o.pick) acts.push(`<button class="mini" data-act="focus" data-id="${t.id}" ${o.full ? 'disabled' : ''} title="أضف لأولويات اليوم">${I.plus}<span>لليوم</span></button>`);
  if (o.follow && t.assignee && !done) acts.push(`<button class="mini" data-act="followed" data-id="${t.id}" title="سجّل أنك تابعت، والمتابعة التالية بعد ٣ أيام">${I.check}<span>تابعت</span></button>`);
  if (o.slot && !done) {
    acts.push(`<button class="ib" data-act="start-focus" data-id="${t.id}" title="وضع التركيز" aria-label="ابدأ التركيز على هذه المهمة">${I.play}</button>`);
    acts.push(`<button class="ib" data-act="unfocus" data-id="${t.id}" title="أعدها للقائمة" aria-label="أزل من أولويات اليوم">${I.x}</button>`);
  }

  return `<li class="t q-${q}${done ? ' done' : ''}${ui.sel === t.id ? ' sel' : ''}${ui.justDone === t.id ? ' pop' : ''}" data-id="${t.id}"${o.drag ? ' draggable="true"' : ''}>
    <button class="ck" data-act="toggle" data-id="${t.id}" aria-label="${done ? 'إلغاء الإنجاز' : 'إنجاز'}: ${esc(t.title)}">${I.check}</button>
    <button class="tm" data-act="open" data-id="${t.id}">
      <span class="tt">${esc(t.title)}</span>
      ${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}
    </button>
    ${acts.length ? `<span class="acts">${acts.join('')}</span>` : ''}
    <button class="star${t.important ? ' on' : ''}" data-act="star" data-id="${t.id}" aria-pressed="${!!t.important}" aria-label="مهم">${I.star}</button>
  </li>`;
}

const rows = (list, o) => (list.length ? `<ul class="tl">${list.map((t) => row(t, o)).join('')}</ul>` : '');

function doneBox(list, label = 'المكتملة') {
  if (!list.length) return '';
  const sorted = [...list].sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).slice(0, 40);
  return `<details class="donebox"><summary>${label} <span class="cnt">${n(list.length)}</span></summary>${rows(sorted)}</details>`;
}

/** الحلقات الثلاث — نفس شعار التطبيق، تمتلئ مع كل أولوية تُنجز. */
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
  `<option value="">${empty}</option>` + areas().map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
const goalOptions = (sel) =>
  '<option value="">بدون هدف</option>' +
  S().goals.filter((g) => g.status !== 'done' || g.id === sel)
    .map((g) => `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>${esc(g.title)}</option>`).join('');

/** الإضافة السريعة — حقل واحد، والرموز ! @ # تغني عن النماذج. */
export function quickAdd(ctx = {}, placeholder = 'أضف مهمة') {
  const attrs = Object.entries(ctx).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<form class="qa" data-form="quick" ${attrs} autocomplete="off">
    <span class="qa-plus">${I.plus}</span>
    <input id="qa" name="title" class="qa-in" data-draft="qa" value="${esc(ui.drafts.qa || '')}" placeholder="${placeholder}" maxlength="200" aria-label="${placeholder}" enterkeyhint="done" />
    <div class="qa-more">
      <label class="chip-t"><input type="checkbox" name="important" /> مهم</label>
      <label class="chip-t"><input type="checkbox" name="urgent" /> عاجل</label>
      <label class="chip-t date"><span>${I.cal}</span><input type="date" name="due" aria-label="الموعد" /></label>
      <span class="qa-tokens" aria-live="polite"></span>
      <span class="qa-hint">اكتب <b>@الاسم</b> للإسناد، <b>#المجال</b> للتصنيف، <b>!</b> مهم، <b>!!</b> عاجل ومهم</span>
    </div>
  </form>`;
}

function vh(title, sub = '', side = '', icon = '') {
  return `<header class="vh"><div class="vh-t">${icon}<div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div></div>${side ? `<div class="vh-s">${side}</div>` : ''}</header>`;
}

function greeting() {
  const h = new Date().getHours();
  const name = localName();
  const g = h < 12 ? 'صباح الخير' : h < 17 ? 'نهارك سعيد' : 'مساء الخير';
  return name ? `${g} يا ${esc(name)}` : g;
}
export const localName = () => { try { return localStorage.getItem('cc:name') || ''; } catch { return ''; } };

/* ═════════════ اليوم ═════════════ */
function vToday() {
  const focus = focusToday();
  const doneN = focus.filter((t) => !isOpen(t)).length;
  const full = focus.length >= MAX_FOCUS;
  const st = streak();
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
  const score = `<div class="dayscore">${rings(focus)}<div><b>${n(doneN)} من ${n(MAX_FOCUS)}</b><span>${st ? `${daysWord(st)} متتالية` : 'ابدأ سلسلتك اليوم'}</span></div></div>`;
  const allWon = full && doneN === MAX_FOCUS;

  return `${vh('اليوم', `${greeting()}، ${fmtLongDate()}`, score)}
  <ol class="three${allWon ? ' allwon' : ''}">${slots}</ol>
  ${allWon ? '<p class="won-msg">أنجزت الثلاث. ما يأتي بعدها مكسب إضافي، لا التزام.</p>' : ''}
  ${quickAdd({ ctx: 'today' }, full ? 'أضف مهمة لليوم' : 'أضف أولوية لليوم')}
  ${sug.length ? `<section class="blk"><p class="lbl">${I.bolt}اقتراحات حسب الأهمية والموعد</p>${rows(sug, { pick: true, full })}</section>` : ''}
  ${also.length ? `<section class="blk"><p class="lbl">أيضًا اليوم <span class="cnt">${n(also.length)}</span></p>${rows(also, { pick: !full, full, follow: true })}</section>` : ''}
  ${!focus.length && !sug.length && !also.length ? '<div class="empty">ابدأ بإضافة أول مهمة بالأعلى. سجّل كل ما في رأسك، ثم اختر ثلاثًا فقط.</div>' : ''}
  ${doneBox(done, 'أنجزت اليوم')}`;
}

/* ═════════════ القوائم ═════════════ */
const EMPTY = {
  important: 'اضغط النجمة بجانب أي مهمة لتظهر هنا.',
  planned: 'المهام التي لها موعد تظهر هنا مرتبة حسب القرب.',
  assigned: 'أسند مهمة لشخص بكتابة @الاسم، أو من تفاصيل المهمة، ثم تابعها من هنا.',
  inbox: 'الوارد فارغ. كل ما تلتقطه دون مجال يصل هنا، وتصنّفه في المراجعة الأسبوعية.',
  area: 'لا مهام مفتوحة في هذا المجال.',
};

function vList() {
  const key = ui.param;
  const smart = SMART[key];
  const area = smart ? null : areaById(key);
  if (!smart && !area) return vToday();
  const all = listTasks(key);
  const open = all.filter(isOpen).sort(byPriority);
  const ctx = smart ? { list: key } : { area: key };
  const icon = smart ? `<span class="vh-i k-${key}">${I[smart.icon]}</span>` : `<span class="vh-i dotbig" style="--c:${esc(area.color)}"></span>`;
  const title = smart ? smart.name : esc(area.name);
  let body;

  if (key === 'planned') {
    const t0 = todayKey();
    const ws = dateKey(addDays(weekStart(), 7));
    const B = [
      ['متأخرة', (t) => t.due < t0], ['اليوم', (t) => t.due === t0], ['غدًا', (t) => t.due === keyAdd(t0, 1)],
      ['هذا الأسبوع', (t) => t.due > keyAdd(t0, 1) && t.due < ws], ['لاحقًا', (t) => t.due >= ws && t.due > keyAdd(t0, 1)],
    ];
    const sorted = open.sort((a, b) => a.due.localeCompare(b.due) || byPriority(a, b));
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

  const sub = `${n(open.length)} مفتوحة${key === 'inbox' && open.length ? '، صنّفها حين يكون لديك دقيقتان' : ''}`;
  return `${vh(title, sub, '', icon)}
    ${quickAdd(ctx, 'أضف مهمة')}
    ${body || `<div class="empty">${EMPTY[smart ? key : 'area']}</div>`}
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
        <button class="ib" data-act="new-in-quad" data-q="${q}" aria-label="أضف مهمة إلى ${QUADRANTS[q].label}">${I.plus}</button></header>
      ${rows(l, { drag: true }) || '<p class="qempty">اسحب مهمة إلى هنا</p>'}
    </section>`;
  }).join('');
  const total = open.length || 1;
  const q2 = open.filter((t) => quadrant(t) === 'q2').length;
  return `${vh('المصفوفة', 'هل هي مهمة؟ هل هي عاجلة؟ اسحب المهمة بين المربعات لتغيير تصنيفها.', `<div class="q2meter" title="نسبة المهام في «خطّط لها»"><b>${n(Math.round((q2 / total) * 100))}%</b><span>من عملك استراتيجي</span></div>`)}
    <div class="matrix">${quads}</div>`;
}

/* ═════════════ الأهداف ═════════════ */
function goalCard(g) {
  const p = goalProgress(g);
  const a = g.areaId ? areaById(g.areaId) : null;
  const open = goalTasks(g).filter(isOpen).sort(byPriority).slice(0, 4);
  const late = g.status === 'active' && g.targetDate && g.targetDate < todayKey();
  return `<article class="goal${g.status !== 'active' ? ' dim' : ''}">
    <header>
      <div class="gh"><h3>${esc(g.title)}</h3>
        <p class="meta">${a ? `<span class="m">${areaDot(a)}${esc(a.name)}</span>` : ''}${g.targetDate ? `<span class="m ${late ? 'late' : ''}">${I.cal}${fmtDate(g.targetDate)}</span>` : ''}</p></div>
      <button class="ib" data-act="edit-goal" data-id="${g.id}" aria-label="تعديل الهدف">${I.gear}</button>
    </header>
    ${g.why ? `<p class="why">${esc(g.why)}</p>` : ''}
    <div class="gp"><div class="bar"><i style="width:${p.pct}%"></i></div><span>${n(p.pct)}%</span><small>${n(p.done)} من ${n(p.total)}</small></div>
    ${rows(open, { hideGoal: true })}
    ${g.status === 'active' ? `<button class="addstep" data-act="new-for-goal" data-id="${g.id}">${I.plus}${p.total ? 'أضف خطوة' : 'قسّم الهدف إلى أول خطوة'}</button>` : ''}
  </article>`;
}

function vGoals() {
  const by = (a, b) => (a.targetDate || '9999').localeCompare(b.targetDate || '9999');
  const active = S().goals.filter((g) => g.status === 'active' || !g.status).sort(by);
  const paused = S().goals.filter((g) => g.status === 'paused').sort(by);
  const done = S().goals.filter((g) => g.status === 'done').sort(by);
  return `${vh('الأهداف', 'التقدّم يُحسب من المهام المنجزة في كل هدف.', `<button class="btn primary" data-act="new-goal">${I.plus}هدف</button>`)}
    ${active.length ? `<div class="goals">${active.map(goalCard).join('')}</div>` : '<div class="empty">لا أهداف نشطة. ابدأ بهدف واحد واضح لكل مجال، لا أكثر.</div>'}
    ${active.length > 3 ? '<p class="note">أكثر من ٣ أهداف نشطة يوزّع طاقتك. فكّر في تأجيل أحدها.</p>' : ''}
    ${paused.length ? `<details class="donebox"><summary>مؤجلة بوعي <span class="cnt">${n(paused.length)}</span></summary><div class="goals">${paused.map(goalCard).join('')}</div></details>` : ''}
    ${done.length ? `<details class="donebox"><summary>تحققت <span class="cnt">${n(done.length)}</span></summary><div class="goals">${done.map(goalCard).join('')}</div></details>` : ''}`;
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
  const slipped = openTasks().filter((t) => t.slips > 0).sort((a, b) => b.slips - a.slips).slice(0, 8);
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
  const past = [...S().reviews].filter((r) => r.id !== wk).sort((a, b) => b.id.localeCompare(a.id));
  const isCur = ui.weekOffset === 0;
  const val = (k) => esc(ui.drafts[`rv-${wk}-${k}`] ?? rev[k] ?? '');

  const todo = [
    inbox.length && `<li><b>${n(inbox.length)}</b> في الوارد بلا مجال. <a href="#/list/inbox">صنّفها</a></li>`,
    overdue.length && `<li><b>${n(overdue.length)}</b> متأخرة. أعد جدولتها أو احذف ما لم يعد مهمًا. <a href="#/list/planned">افتح المخطط</a></li>`,
    stuck.length && `<li><b>${n(stuck.length)}</b> مُسندة فات موعد متابعتها. <a href="#/list/assigned">تابعها</a></li>`,
  ].filter(Boolean);

  return `${vh('المراجعة الأسبوعية', `من ${fmtDayMonth(ws)} إلى ${fmtDayMonth(addDays(we, -1))}${isCur ? '، هذا الأسبوع' : ''}`,
    `<div class="seg"><button class="ib" data-act="week" data-d="-1" aria-label="الأسبوع السابق">${I.back}</button><button class="ib flip" data-act="week" data-d="1" ${isCur ? 'disabled' : ''} aria-label="الأسبوع التالي">${I.back}</button></div>`)}
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
      <div class="bars">${areas().map((a) => { const c = done.filter((t) => t.areaId === a.id).length; return `<div class="bl" style="--c:${esc(a.color)}"><span>${esc(a.name)}</span><div class="bar"><i style="width:${(c / amax) * 100}%"></i></div><b>${n(c)}</b></div>`; }).join('') || '<p class="note">لا مجالات.</p>'}</div></section>
  </div>
  ${isCur && todo.length ? `<section class="blk"><p class="lbl">رتّب قبل أن تبدأ أسبوعك</p><ul class="todo">${todo.join('')}</ul></section>` : ''}
  ${slipped.length ? `<section class="blk"><p class="lbl">تتكرر في الترحيل <span class="cnt">قرّر: صغّرها، أسندها، أو احذفها</span></p>${rows(slipped)}</section>` : ''}
  <form class="panel reflect" data-form="review" data-week="${wk}">
    <label><span>ما الذي أنجزته وأفخر به؟</span><textarea name="wins" data-draft="rv-${wk}-wins" rows="2">${val('wins')}</textarea></label>
    <label><span>ما الذي عطّلني أو شتّتني؟</span><textarea name="blockers" data-draft="rv-${wk}-blockers" rows="2">${val('blockers')}</textarea></label>
    <label><span>أهم ثلاثة أشياء للأسبوع القادم</span><textarea name="next" data-draft="rv-${wk}-next" rows="3">${val('next')}</textarea></label>
    <div class="row"><button class="btn primary" type="submit">حفظ المراجعة</button>${rev.updatedAt ? `<span class="sub">حُفظت ${fmtDate(rev.updatedAt.slice(0, 10))}</span>` : ''}</div>
  </form>
  ${past.length ? `<details class="donebox"><summary>مراجعات سابقة <span class="cnt">${n(past.length)}</span></summary>${past.map((r) => `
    <div class="past"><b>أسبوع ${fmtDate(r.id)}</b>${r.wins ? `<p><span>الإنجاز</span>${esc(r.wins)}</p>` : ''}${r.blockers ? `<p><span>المعطّلات</span>${esc(r.blockers)}</p>` : ''}${r.next ? `<p><span>التالي</span>${esc(r.next)}</p>` : ''}</div>`).join('')}</details>` : ''}`;
}

/* ═════════════ القوائم (للجوال) والبحث ═════════════ */
export function navItems() {
  const c = counts();
  const item = (href, icon, label, cnt, cls = '') =>
    `<a href="${href}" class="ni ${cls}" data-nav="${href}">${icon}<span>${label}</span>${cnt ? `<em>${n(cnt)}</em>` : ''}</a>`;
  return {
    smart: [
      item('#/today', I.target, 'اليوم', c.today, 'k-today'),
      ...Object.entries(SMART).map(([k, s]) => item(`#/list/${k}`, I[s.icon], s.name, c[k], `k-${k}`)),
    ].join(''),
    views: [
      item('#/matrix', I.grid, 'المصفوفة', 0), item('#/goals', I.flag, 'الأهداف', S().goals.filter((g) => g.status === 'active').length), item('#/review', I.chart, 'المراجعة', 0),
    ].join(''),
    lists: areas().map((a) => `<a href="#/area/${a.id}" class="ni" data-nav="#/area/${a.id}">${areaDot(a)}<span>${esc(a.name)}</span>${c[a.id] ? `<em>${n(c[a.id])}</em>` : ''}</a>`).join(''),
  };
}

function vLists() {
  const nv = navItems();
  return `${vh('القوائم')}
    <label class="search big">${I.search}<input type="search" id="q2" data-act="search" placeholder="ابحث في كل المهام" value="${esc(ui.q)}" /></label>
    <nav class="hub">${nv.smart}<hr />${nv.lists}<a href="#/settings" class="ni addlist">${I.plus}<span>مجال جديد</span></a><hr /><a href="#/settings" class="ni">${I.gear}<span>الإعدادات</span></a></nav>`;
}

function vSearch() {
  const q = ui.q.trim();
  const hit = (t) => [t.title, t.notes, t.assignee, areaById(t.areaId)?.name, goalById(t.goalId)?.title, ...(t.steps || []).map((s) => s.title)]
    .some((x) => x && x.includes(q));
  const res = q ? S().tasks.filter(hit) : [];
  const open = res.filter(isOpen).sort(byPriority);
  return `${vh(q ? `نتائج «${esc(q)}»` : 'بحث', q ? `${n(open.length)} مفتوحة` : 'ابحث في العنوان والملاحظات والخطوات والأشخاص.')}
    <label class="search big only-m">${I.search}<input type="search" id="q2" data-act="search" placeholder="ابحث" value="${esc(ui.q)}" /></label>
    ${rows(open) || (q ? '<div class="empty">لا نتائج مفتوحة.</div>' : '')}
    ${doneBox(res.filter((t) => !isOpen(t)))}`;
}

/* ═════════════ الإعدادات ═════════════ */
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
  const areaRows = areas().map((a) => `
    <form class="arow" data-form="area" data-id="${a.id}">
      <input type="color" name="color" value="${esc(a.color)}" aria-label="لون ${esc(a.name)}" />
      <input class="in" name="name" value="${esc(a.name)}" required maxlength="40" aria-label="اسم المجال" />
      <button class="btn sm" type="submit">حفظ</button>
      <button class="btn sm danger" type="button" data-act="del-area" data-id="${a.id}">حذف</button>
    </form>`).join('');

  return `${vh('الإعدادات')}
  <div class="settings">
    <section class="panel"><h2>اسمك</h2>
      <form class="arow" data-form="name"><input class="in" name="name" value="${esc(localName())}" maxlength="30" placeholder="يظهر في التحية" /><button class="btn sm" type="submit">حفظ</button></form>
      <p class="note">يُحفظ على هذا الجهاز فقط.</p></section>
    <section class="panel"><h2>المزامنة</h2>${sync}</section>
    <section class="panel" id="areas"><h2>المجالات</h2>${areaRows}
      <form class="arow" data-form="new-area">
        <input type="color" name="color" value="${AREA_COLORS[areas().length % AREA_COLORS.length]}" aria-label="لون المجال" />
        <input class="in" name="name" placeholder="مجال جديد" required maxlength="40" />
        <button class="btn sm primary" type="submit">إضافة</button>
      </form></section>
    <section class="panel"><h2>الكتابة السريعة</h2>
      <ul class="steps">
        <li><b>!</b> مهم، و <b>!!</b> مهم وعاجل. مثال: <code>تقرير الرواتب !!</code></li>
        <li><b>@الاسم</b> يُسند المهمة لشخص ويحدد متابعة بعد يومين. للاسم المركّب: <code>@محمد_علي</code></li>
        <li><b>#المجال</b> يكفي أول حروفه. مثال: <code>#أسس</code></li>
        <li>اختصارات لوحة المفاتيح: <kbd>N</kbd> مهمة جديدة، <kbd>/</kbd> بحث، <kbd>Esc</kbd> إغلاق.</li>
      </ul></section>
    <section class="panel"><h2>التثبيت والـWidget</h2>
      ${env.installPrompt ? '<div class="row" style="margin-bottom:10px"><button class="btn primary" data-act="install">تثبيت التطبيق على هذا الجهاز</button></div>' : ''}
      <ul class="steps">
        <li><b>ويندوز:</b> افتح الرابط في Edge أو Chrome، ثم قائمة المتصفح، ثم «تثبيت مركز القيادة».</li>
        <li><b>آيفون:</b> افتح الرابط في Safari، ثم زر المشاركة، ثم «إضافة إلى الشاشة الرئيسية».</li>
        <li><b>الـWidget:</b> نافذة صغيرة تعرض أولويات اليوم فقط، ضعها في زاوية الشاشة.</li>
      </ul>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="open-widget">فتح نافذة الـWidget</button></div></section>
    <section class="panel"><h2>نسخة احتياطية</h2>
      <p class="note">التصدير يحفظ كل بياناتك في ملف. استيراد النسخة الاحتياطية يستبدل البيانات الحالية. أما ملف الإعداد القديم (<code>command-center-setup.json</code>) فيُدمج دون حذف شيء.</p>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-act="export">تصدير</button>
        <label class="btn">استيراد<input type="file" accept="application/json,.json" data-act="import" hidden /></label>
      </div></section>
  </div>`;
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
  today: vToday, list: vList, area: vList, matrix: vMatrix, goals: vGoals, review: vReview,
  lists: vLists, search: vSearch, settings: vSettings, widget: vWidget,
};

/* ═════════════ لوحة التفاصيل (مثل To Do) ═════════════ */
export function pane(t) {
  if (!t) return '';
  const done = !isOpen(t);
  const q = quadrant(t);
  const steps = t.steps || [];
  const inFocus = isFocus(t);
  const full = focusToday().length >= MAX_FOCUS;
  const ppl = people().map((p) => `<option value="${esc(p.name)}">`).join('');
  const t0 = todayKey();
  const chips = [['اليوم', t0], ['غدًا', keyAdd(t0, 1)], ['بعد أسبوع', keyAdd(t0, 7)]]
    .map(([l, k]) => `<button type="button" class="chip-b${t.due === k ? ' on' : ''}" data-act="set-due" data-v="${k}">${l}</button>`).join('');

  return `<div class="pane-in q-${q}${done ? ' done' : ''}" data-id="${t.id}">
    <div class="pane-top">
      <button class="ib only-m" data-act="close-pane" aria-label="رجوع">${I.back}</button>
      <span class="quadtag">${QUADRANTS[q].label}</span>
      <span class="spacer"></span>
      <button class="ib only-d" data-act="close-pane" aria-label="إغلاق التفاصيل">${I.x}</button>
    </div>
    ${t.slips >= 3 && !done ? `<div class="decide"><b>رُحّلت ${n(t.slips)} مرات.</b> المهمة التي تتكرر في الترحيل غالبًا كبيرة أو غير واضحة أو ليست لك. اختر:
      <div class="row"><button class="btn sm" data-act="focus-steps">قسّمها إلى خطوات</button><button class="btn sm" data-act="focus-assign">أسندها</button><button class="btn sm" data-act="reset-slips">سأنجزها، صفّر العدّاد</button></div></div>` : ''}
    <div class="ph">
      <button class="ck big" data-act="toggle" data-id="${t.id}" aria-label="${done ? 'إلغاء الإنجاز' : 'إنجاز'}">${I.check}</button>
      <textarea class="ptitle" id="p-title" data-f="title" rows="1" maxlength="200" aria-label="عنوان المهمة">${esc(t.title)}</textarea>
      <button class="star${t.important ? ' on' : ''}" data-act="star" data-id="${t.id}" aria-pressed="${!!t.important}" aria-label="مهم">${I.star}</button>
    </div>

    <div class="psteps" id="steps">
      ${steps.map((s, i) => `<div class="step${s.done ? ' done' : ''}">
        <button class="ck sm" data-act="step-toggle" data-i="${i}" aria-label="إنجاز الخطوة">${I.check}</button>
        <input class="sin" id="st-${s.id}" data-step="${i}" value="${esc(s.title)}" maxlength="160" aria-label="خطوة" />
        <button class="ib xs" data-act="step-del" data-i="${i}" aria-label="حذف الخطوة">${I.x}</button></div>`).join('')}
      <form class="step add" data-form="step"><span class="ck sm ghost">${I.plus}</span><input class="sin" id="p-newstep" name="title" placeholder="${steps.length ? 'خطوة تالية' : 'أضف خطوة: أصغر شيء يمكن البدء به'}" maxlength="160" /></form>
    </div>

    <div class="pblk">
      <button class="prow${inFocus ? ' on' : ''}" data-act="${inFocus ? 'unfocus' : 'focus'}" data-id="${t.id}" ${!inFocus && full && !done ? 'disabled' : ''}>${I.target}<span>${inFocus ? 'ضمن أولويات اليوم' : full ? 'أولويات اليوم ممتلئة (٣)' : 'أضف إلى أولويات اليوم'}</span>${inFocus ? `<em>${I.x}</em>` : ''}</button>
      ${inFocus && !done ? `<button class="prow" data-act="start-focus" data-id="${t.id}">${I.play}<span>ابدأ وضع التركيز</span></button>` : ''}
    </div>

    <div class="pblk">
      <div class="prow static">${I.grid}<span>التصنيف</span>
        <label class="chip-t"><input type="checkbox" data-f="important" ${t.important ? 'checked' : ''} /> مهم</label>
        <label class="chip-t"><input type="checkbox" data-f="urgent" ${t.urgent ? 'checked' : ''} /> عاجل</label></div>
      <div class="prow static">${I.cal}<span>الموعد</span><input type="date" class="in sm" data-f="due" value="${esc(t.due || '')}" aria-label="الموعد" /></div>
      <div class="chips">${chips}${t.due ? '<button type="button" class="chip-b" data-act="set-due" data-v="">بلا موعد</button>' : ''}</div>
      <div class="prow static">${I.repeat}<span>التكرار</span><select class="in sm" data-f="repeat" aria-label="التكرار"><option value="">لا يتكرر</option>${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}"${t.repeat === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>

    <div class="pblk" id="assign">
      <div class="prow static">${I.user}<span>مُسندة إلى</span><input class="in sm" id="p-assignee" data-f="assignee" list="ppl" value="${esc(t.assignee || '')}" placeholder="لا أحد، أنا المسؤول" maxlength="40" /><datalist id="ppl">${ppl}</datalist></div>
      ${t.assignee ? `<div class="prow static">${I.bell}<span>المتابعة القادمة</span><input type="date" class="in sm" data-f="followUp" value="${esc(t.followUp || '')}" aria-label="موعد المتابعة" /></div>
        <p class="hint">أُسندت ${t.assignedAt ? `قبل ${daysWord(Math.max(0, daysBetween(t.assignedAt, todayKey())))}` : ''}. ${followDue(t) ? '<b>حان موعد المتابعة.</b>' : ''} <button class="link" data-act="followed" data-id="${t.id}">تابعت اليوم</button></p>` : ''}
    </div>

    <div class="pblk">
      <div class="prow static">${I.list}<span>المجال</span><select class="in sm" data-f="areaId" aria-label="المجال">${areaOptions(t.areaId)}</select></div>
      <div class="prow static">${I.flag}<span>الهدف</span><select class="in sm" data-f="goalId" aria-label="الهدف">${goalOptions(t.goalId)}</select></div>
    </div>

    <textarea class="pnotes" id="p-notes" data-f="notes" maxlength="4000" placeholder="ملاحظات، روابط، تفاصيل…" aria-label="ملاحظات">${esc(t.notes || '')}</textarea>

    <footer class="pfoot"><span>${done ? `أُنجزت ${fmtDate((t.completedAt || '').slice(0, 10))}` : t.createdAt ? `أُنشئت ${fmtDate(t.createdAt.slice(0, 10))}` : ''}</span>
      <button class="ib" data-act="del-task" data-id="${t.id}" aria-label="حذف المهمة" title="حذف">${I.trash}</button></footer>
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
  return `<div class="fx-in">
    <button class="ib fx-close" data-act="end-focus" aria-label="إنهاء التركيز">${I.x}</button>
    <p class="fx-lbl">ركّز على شيء واحد</p>
    <h2 class="fx-title">${esc(t.title)}</h2>
    <div class="fx-clock"><svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="92" class="trk"/><circle cx="100" cy="100" r="92" class="arc" id="fx-arc" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}"/></svg>
      <b id="fx-time">${fmtClock(T.left)}</b></div>
    <div class="fx-ctl">
      ${[15, 25, 50].map((m) => `<button class="chip-b${T.total === m * 60 ? ' on' : ''}" data-act="fx-len" data-m="${m}">${n(m)} د</button>`).join('')}
      <button class="btn primary fx-go" data-act="fx-toggle">${T.running ? `${I.pause}إيقاف مؤقت` : `${I.play}${T.left < T.total ? 'استئناف' : 'ابدأ'}`}</button>
    </div>
    ${steps.length ? `<ul class="fx-steps">${steps.map((s, i) => `<li class="${s.done ? 'done' : ''}"><button class="ck sm" data-act="step-toggle" data-i="${i}" data-id="${t.id}">${I.check}</button><span>${esc(s.title)}</span></li>`).join('')}</ul>` : ''}
    <button class="btn fx-done" data-act="toggle" data-id="${t.id}" data-end="1">${I.check}أنجزتها</button>
  </div>`;
}
