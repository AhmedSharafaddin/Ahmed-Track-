// هرم فرانكلين: من القيم (الأساس) إلى مهمة اليوم (القمة).
// مبدأ الشاشة: ترى المسيرة كاملة بنظرة، لكن لكل هدف قريب «خطوة تالية» واحدة فقط ظاهرة.
// الباقي عدد، لا قائمة ⇒ لا زحمة مهما كثرت المهام.

import { n, esc, fmtDate, todayKey, keyAdd } from './utils.js';
import {
  S, areaById, isOpen, focusToday, values, goalLevel, isActiveGoal, goalOpen, goalParked, childGoals, goalProgress,
  treeProgress, MAX_LONG, MAX_GOAL_OPEN, MAX_VALUES,
} from './model.js';

const dayOf = (iso) => (iso ? iso.slice(0, 10) : '');

/** @param {{I:Function, vh:Function, ui:object}} h */
export function vPyramid(h) {
  const { I, vh, ui } = h;
  const vals = values();
  const goals = S().goals.filter(isActiveGoal);
  const longs = goals.filter((g) => goalLevel(g) === 'long');
  const mids = goals.filter((g) => goalLevel(g) === 'mid');
  const focus = focusToday();
  const t0 = todayKey();

  // كم من إنجازك آخر ١٤ يومًا يخدم هدفًا؟ (جوهر فرانكلين: المهام اليومية تخدم الأهداف)
  const done14 = S().tasks.filter((t) => !isOpen(t) && dayOf(t.completedAt) >= keyAdd(t0, -13));
  const aligned = done14.filter((t) => t.goalId).length;
  const alignPct = done14.length >= 3 ? Math.round((aligned / done14.length) * 100) : null;

  const band = (lvl, label, val, hint) => `<div class="pyr-b pyr-${lvl}"><b>${val}</b><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</div>`;
  const pyramid = `<div class="pyr" role="img" aria-label="هرم الأهداف: ${n(focus.length)} لليوم، ${n(mids.length)} أهداف قريبة، ${n(longs.length)} أهداف بعيدة، ${n(vals.length)} قيم">
    ${band('t', 'اليوم', `${n(focus.filter(isOpen).length)}/${n(3)}`, '')}
    ${band('m', 'أهداف قريبة', n(mids.length), 'أشهر')}
    ${band('l', 'أهداف بعيدة', `${n(longs.length)}/${n(MAX_LONG)}`, 'سنوات')}
    ${band('v', 'قيمك', `${n(vals.length)}/${n(MAX_VALUES)}`, 'الأساس')}
  </div>`;

  /* ───── خطوة تالية واحدة لكل هدف قريب ───── */
  const nextStep = (g) => {
    const open = goalOpen(g);
    const parked = goalParked(g).length;
    const p = goalProgress(g);
    const full = open.length >= MAX_GOAL_OPEN;
    const t = open[0];
    const late = g.targetDate && g.targetDate < t0;
    return `<li class="pm">
      <div class="pm-h">
        <span class="pm-t">${g.emoji ? `<span class="em">${esc(g.emoji)}</span>` : ''}${esc(g.title)}</span>
        <span class="pm-pct" title="${n(p.done)} من ${n(p.total)}">${n(p.pct)}%</span>
        <button class="ib xs" data-act="edit-goal" data-id="${g.id}" aria-label="تعديل الهدف ${esc(g.title)}">${I('more')}</button>
      </div>
      <div class="pm-bar" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="تقدّم ${esc(g.title)}"><i style="width:${p.pct}%"></i></div>
      ${t ? `<div class="pm-next"><button class="ck sm" data-act="toggle" data-id="${t.id}" aria-label="إنجاز: ${esc(t.title)}">${I('check')}</button>
          <button class="pm-tt" data-act="open" data-id="${t.id}"><small>الخطوة التالية</small>${esc(t.title)}</button>
          <button class="ib xs" data-act="pomo-start" data-id="${t.id}" title="ابدأ جلسة تركيز ٢٥ دقيقة" aria-label="ابدأ تركيز على ${esc(t.title)}">${I('play', 'f')}</button></div>`
    : `<p class="pm-empty">${p.total ? 'لا خطوة مفتوحة.' : 'لم تُحدد أول خطوة.'}</p>`}
      <div class="pm-f">
        ${open.length > 1 ? `<span>+${n(open.length - 1)} مفتوحة</span>` : ''}
        ${parked ? `<span class="pk" title="تظهر تلقائيًا حين تُنجز خطوة">${I('hourglass')}${n(parked)} تنتظر دورها</span>` : ''}
        ${g.targetDate ? `<span class="${late ? 'late' : ''}">${I('cal')}${fmtDate(g.targetDate)}</span>` : ''}
        <button class="link" data-act="new-for-goal" data-id="${g.id}">${full ? `${I('hourglass')}أضف للانتظار` : `${I('plus')}خطوة`}</button>
      </div>
    </li>`;
  };

  const longCard = (L) => {
    const kids = childGoals(L).filter(isActiveGoal);
    const p = treeProgress(L);
    const a = L.areaId ? areaById(L.areaId) : null;
    const own = goalOpen(L).length || goalParked(L).length;
    return `<article class="pl" style="--c:${esc(a?.color || 'var(--accent)')}">
      <header class="pl-h"><span class="pl-k">هدف بعيد</span>
        <h3>${L.emoji ? `<span class="em">${esc(L.emoji)}</span>` : ''}${esc(L.title)}</h3>
        <span class="pl-pct">${n(p.pct)}%</span>
        <button class="ib xs" data-act="edit-goal" data-id="${L.id}" aria-label="تعديل الهدف ${esc(L.title)}">${I('more')}</button></header>
      ${L.why ? `<p class="why">${esc(L.why)}</p>` : ''}
      ${kids.length || own ? `<ul class="pms">${own ? nextStep(L) : ''}${kids.map(nextStep).join('')}</ul>` : ''}
      ${kids.length >= 3 ? '' : `<button class="addstep" data-act="new-goal" data-parent="${L.id}">${I('plus')}${kids.length ? 'هدف قريب آخر' : 'قسّمه إلى هدف قريب (٣–٦ أشهر)'}</button>`}
    </article>`;
  };

  const valueBlock = (v) => {
    const ls = longs.filter((g) => g.valueId === v.id);
    return `<section class="pv">
      <h2 class="pv-h"><span class="pv-e">${esc(v.emoji || '◆')}</span>${esc(v.text)}<span class="cnt">${ls.length ? `${n(ls.length)} هدف` : ''}</span></h2>
      ${ls.length ? ls.map(longCard).join('') : `<button class="addstep" data-act="new-goal" data-level="long" data-value="${v.id}">${I('plus')}ما الهدف البعيد الذي يجسّد هذه القيمة؟</button>`}
    </section>`;
  };

  const valIds = new Set(vals.map((v) => v.id));
  const looseLongs = longs.filter((g) => !valIds.has(g.valueId));
  const longIds = new Set(longs.map((g) => g.id));
  const looseMids = mids.filter((g) => !longIds.has(g.parentId));

  const intro = !vals.length
    ? `<section class="panel pv-start"><h2>${I('sparkle', 'd')}ابدأ من الأساس: قيمك</h2>
        <p class="note">في هرم فرانكلين تأتي القيم أولًا: ما الذي يهمك فعلًا؟ (مثلًا: الأسرة، الإتقان، الاستقلال المالي). اكتب من ٣ إلى ٥ فقط. كل هدف تضعه بعدها يجب أن يخدم إحداها، وما لا يخدم شيئًا يُحذف.</p>
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="edit-values">${I('plus')}اكتب قيمك</button></div></section>`
    : '';

  const warns = [];
  if (longs.length > MAX_LONG) warns.push(`عندك ${n(longs.length)} أهداف بعيدة نشطة. ثلاثة تكفي لسنة؛ أجّل الباقي بوعي ليتقدّم ما بقي.`);
  const overloaded = mids.filter((g) => goalParked(g).length >= 3);
  if (overloaded.length) warns.push(`«${esc(overloaded[0].title)}» فيه خطوات كثيرة تنتظر. أنجز الموجود قبل أن تضيف، أو احذف ما لم يعد مهمًا.`);

  const paused = S().goals.filter((g) => g.status === 'paused');
  const doneG = S().goals.filter((g) => g.status === 'done');

  return `${vh('هرم الأهداف', 'من قيمك إلى مهمة اليوم. ترى المسيرة كلها، وخطوة واحدة لكل هدف.', `<button class="btn" data-act="edit-values">${I('sparkle', 'i')}القيم</button><button class="btn primary" data-act="new-goal">${I('plus')}هدف</button>`)}
    <div class="pyr-wrap">${pyramid}
      <div class="pyr-side">
        ${alignPct != null ? `<p class="pyr-stat"><b>${n(alignPct)}%</b> من إنجازك آخر ١٤ يومًا يخدم هدفًا${alignPct < 40 ? '. الباقي ردود أفعال؛ اربط مهامك بأهدافك أو ارفض بعضها.' : '.'}</p>` : '<p class="note">حين تنجز مهامًا مربوطة بأهداف، سترى هنا كم من يومك يخدم مسيرتك.</p>'}
        <p class="note">${I('hourglass')}لكل هدف ${n(MAX_GOAL_OPEN)} خطوات مفتوحة كحد أقصى. ما يزيد ينتظر دوره ويظهر تلقائيًا حين تُنجز واحدة.</p>
      </div></div>
    ${warns.map((w) => `<p class="warn">${I('scales', 'd')}${w}</p>`).join('')}
    ${intro}
    ${vals.map(valueBlock).join('')}
    ${looseLongs.length ? `<section class="pv loose"><h2 class="pv-h"><span class="pv-e">○</span>أهداف بعيدة بلا قيمة<span class="cnt">اربطها بقيمة أو أجّلها</span></h2>${looseLongs.map(longCard).join('')}</section>` : ''}
    ${looseMids.length ? `<section class="pv loose"><h2 class="pv-h"><span class="pv-e">○</span>أهداف قريبة غير مربوطة<span class="cnt">لأي هدف بعيد تخدم؟</span></h2><ul class="pms">${looseMids.map(nextStep).join('')}</ul></section>` : ''}
    ${!goals.length && vals.length ? `<div class="empty">${I('flag', 'd', 'big')}<p>اختر قيمة واكتب هدفًا بعيدًا واحدًا يجسّدها.</p></div>` : ''}
    ${paused.length ? `<details class="donebox"><summary>مؤجلة بوعي <span class="cnt">${n(paused.length)}</span></summary><ul class="pms">${paused.map(nextStep).join('')}</ul></details>` : ''}
    ${doneG.length ? `<details class="donebox"><summary>تحققت <span class="cnt">${n(doneG.length)}</span></summary><ul class="pms">${doneG.map(nextStep).join('')}</ul></details>` : ''}`;
}
