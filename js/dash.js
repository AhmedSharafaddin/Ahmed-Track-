// لوحة القيادة: كل أرقامها محسوبة من مهامك الفعلية، بلا بيانات مختلقة.
// الترتيب مقصود لمنع التشتت: رقم واحد كبير ← ما يحتاج قرارًا الآن ← الاتجاه ← التفاصيل.

import { addDays, dateKey, keyAdd, todayKey, weekStart, n, esc, quadrant, fmtDate } from './utils.js';
import { S, areas, areaById, isOpen, openTasks, isOverdue, followDue, byPriority, goalProgress, streak, isWaiting } from './model.js';

const DAYS = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
const dayOf = (iso) => (iso ? iso.slice(0, 10) : '');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function delta(cur, prev) {
  if (!prev && !cur) return { txt: 'لا إنجاز بعد في الأسبوعين', cls: '' };
  const d = cur - prev;
  if (d === 0) return { txt: 'مثل الأسبوع الماضي', cls: '' };
  return { txt: `${d > 0 ? 'أكثر' : 'أقل'} بـ${n(Math.abs(d))} من الأسبوع الماضي`, cls: d > 0 ? 'up' : 'down' };
}

/** @param {{I:Function, areaMark:Function, row:Function, vh:Function}} h مساعدات من views.js */
export function vDash(h) {
  const { I, areaMark, row, vh } = h;
  const t0 = todayKey();
  const ws = weekStart();
  const wsK = dateKey(ws);
  const pwK = dateKey(addDays(ws, -7));
  const doneAll = S().tasks.filter((t) => !isOpen(t) && t.completedAt);
  const inRange = (t, a, b) => { const d = dayOf(t.completedAt); return d >= a && d < b; };
  const wk = doneAll.filter((t) => inRange(t, wsK, keyAdd(wsK, 7)));
  const pw = doneAll.filter((t) => inRange(t, pwK, wsK));
  const dl = delta(wk.length, pw.length);

  // الالتزام بالمواعيد: آخر ٢٨ يومًا، للمهام التي لها موعد
  const dued = doneAll.filter((t) => t.due && dayOf(t.completedAt) >= keyAdd(t0, -28));
  const onTime = dued.filter((t) => dayOf(t.completedAt) <= t.due).length;
  const onTimePct = dued.length >= 3 ? pct(onTime, dued.length) : null;

  const open = openTasks();
  const late = open.filter(isOverdue);
  const follow = open.filter(followDue);
  const q2 = wk.filter((t) => quadrant(t) === 'q2').length;

  // ما يحتاج قرارك: الأسوأ أولًا، بحد أقصى ثلاثة حتى لا تتحول اللوحة إلى قائمة أخرى
  const heat = (t) => (isOverdue(t) ? Math.min(30, (new Date(t0) - new Date(t.due)) / 864e5) : 0) + (t.slips || 0) * 2 + (t.snoozes || 0) + (followDue(t) ? 4 : 0);
  const attention = open.filter((t) => heat(t) > 0).sort((a, b) => heat(b) - heat(a) || byPriority(a, b)).slice(0, 3);

  // اتجاه ١٤ يومًا
  const days = Array.from({ length: 14 }, (_, i) => {
    const k = keyAdd(t0, i - 13);
    const c = doneAll.filter((t) => dayOf(t.completedAt) === k).length;
    return { k, c, lbl: DAYS[new Date(`${k}T12:00:00`).getDay()] };
  });
  const dmax = Math.max(1, ...days.map((d) => d.c));
  const total14 = days.reduce((s, d) => s + d.c, 0);

  // توازن المجالات: المنجز في ١٤ يومًا مقابل المفتوح
  const from14 = keyAdd(t0, -13);
  const bal = areas().map((a) => ({
    a,
    done: doneAll.filter((t) => t.areaId === a.id && dayOf(t.completedAt) >= from14).length,
    open: open.filter((t) => t.areaId === a.id).length,
  })).filter((r) => r.done || r.open).sort((x, y) => y.done - x.done || y.open - x.open);
  const bmax = Math.max(1, ...bal.map((r) => r.done));
  const inbox = open.filter((t) => !t.areaId || !areaById(t.areaId)).length;

  // الإسناد
  const ppl = new Map();
  for (const t of open) if (t.assignee) {
    const p = ppl.get(t.assignee) || { name: t.assignee, open: 0, late: 0, follow: 0 };
    p.open++; if (isOverdue(t)) p.late++; if (followDue(t)) p.follow++;
    ppl.set(t.assignee, p);
  }
  const team = [...ppl.values()].sort((a, b) => b.late - a.late || b.follow - a.follow || b.open - a.open);

  const goals = S().goals.filter((g) => g.status === 'active' || !g.status).map((g) => ({ g, p: goalProgress(g) }));

  const tile = (v, label, cls = '', href = '') => {
    const inner = `<b>${v}</b><span>${label}</span>`;
    return href ? `<a class="db-tile ${cls}" href="${href}">${inner}</a>` : `<div class="db-tile ${cls}">${inner}</div>`;
  };

  const lede = !S().tasks.length
    ? 'أضف مهامك لتظهر هنا حالتك الحقيقية.'
    : late.length || follow.length
      ? `${late.length ? `${n(late.length)} متأخرة` : ''}${late.length && follow.length ? '، و' : ''}${follow.length ? `${n(follow.length)} مُسندة تنتظر متابعتك` : ''}. ابدأ بها.`
      : 'لا متأخرات ولا متابعات معلّقة. حافظ على الإيقاع.';

  return `${vh('لوحة القيادة', 'أرقام حقيقية من مهامك، ومرتبة لتعرف ماذا تفعل بعدها.', `<a class="btn" href="#/review">${I('chart', 'd')}المراجعة الأسبوعية</a>`)}
  <section class="db-hero" aria-label="ملخص الأسبوع">
    <div class="db-big"><b>${n(wk.length)}</b><div><span>مهمة منجزة هذا الأسبوع</span><em class="${dl.cls}">${dl.txt}</em></div></div>
    <p class="db-lede">${lede}${open.some(isWaiting) ? ` <a href="#/all/waiting">${n(open.filter(isWaiting).length)} بانتظار الاعتماد</a>.` : ''}</p>
  </section>
  <div class="db-tiles">
    ${tile(n(late.length), 'متأخرة', late.length ? 'bad' : 'ok', '#/list/planned')}
    ${tile(n(follow.length), 'متابعة مستحقة', follow.length ? 'warn' : 'ok', '#/list/assigned')}
    ${tile(onTimePct == null ? '—' : `${n(onTimePct)}%`, onTimePct == null ? 'الالتزام بالمواعيد (يحتاج ٣ مهام بموعد)' : 'إنجاز في موعده، آخر ٢٨ يومًا')}
    ${tile(wk.length ? `${n(pct(q2, wk.length))}%` : '—', 'عمل استراتيجي من المنجز', '', '#/matrix')}
  </div>
  <section class="blk db-decide"><p class="lbl">${I('bolt', 'i', 'gold')}يحتاج قرارك الآن${attention.length ? ` <span class="cnt">${n(attention.length)}</span>` : ''}</p>
    ${attention.length
    ? `<ul class="tl">${attention.map((t) => row(t, { follow: true })).join('')}</ul><p class="note">قرّر لكل واحدة: أنجزها اليوم، أعد جدولتها بموعد واقعي، أسندها، أو احذفها.</p>`
    : `<div class="db-clear">${I('sparkle', 'd')}<span>لا شيء معلّق. كل ما عندك في موعده.</span></div>`}
  </section>
  <div class="db-grid">
    <section class="panel db-trend"><p class="lbl">الإنجاز آخر ١٤ يومًا <span class="cnt">${n(total14)} مهمة</span></p>
      <div class="db-cols" role="img" aria-label="أعمدة الإنجاز اليومي لآخر أربعة عشر يومًا، المجموع ${n(total14)}">
        ${days.map((d) => `<div class="db-col${d.k === t0 ? ' now' : ''}" tabindex="0" data-tip="${d.lbl} ${fmtDate(d.k)}: ${d.c ? n(d.c) : 'لا شيء'}"><i style="height:${Math.round((d.c / dmax) * 100)}%"></i><span>${d.k === t0 ? 'اليوم' : n(Number(d.k.slice(8)))}</span></div>`).join('')}
      </div>
      <details class="db-table"><summary>عرض كجدول</summary><table><thead><tr><th>اليوم</th><th>المنجز</th></tr></thead><tbody>${days.map((d) => `<tr><td>${d.lbl} ${fmtDate(d.k)}</td><td>${n(d.c)}</td></tr>`).join('')}</tbody></table></details>
    </section>
    <section class="panel"><p class="lbl">توازن المجالات <span class="cnt">منجز ١٤ يومًا، ثم المفتوح</span></p>
      ${bal.length ? `<div class="bars">${bal.map((r) => `<div class="bl" style="--c:${esc(r.a.color)}" title="${esc(r.a.name)}: ${n(r.done)} منجزة، ${n(r.open)} مفتوحة"><span>${areaMark(r.a, 'xs')}${esc(r.a.name)}</span><div class="bar"><i style="width:${(r.done / bmax) * 100}%"></i></div><b>${n(r.done)}<small>/${n(r.open)}</small></b></div>`).join('')}</div>`
    : '<p class="note">لا نشاط في المجالات بعد.</p>'}
      ${inbox ? `<p class="note">${n(inbox)} في الوارد بلا مجال. <a href="#/list/inbox">صنّفها</a></p>` : ''}
    </section>
    <section class="panel"><p class="lbl">${I('people', 'd')}الإسناد والمتابعة</p>
      ${team.length ? `<table class="db-team"><thead><tr><th>الشخص</th><th>مفتوحة</th><th>متأخرة</th><th>متابعة</th></tr></thead><tbody>${team.map((p) => `<tr><td>${esc(p.name)}</td><td>${n(p.open)}</td><td class="${p.late ? 'tbad' : ''}">${n(p.late)}</td><td class="${p.follow ? 'twarn' : ''}">${n(p.follow)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="note">لم تُسند مهمة بعد. اكتب <b>@الاسم</b> في أي مهمة لتتبّعها من هنا.</p>'}
    </section>
    <section class="panel"><p class="lbl">${I('flag', 'd')}الأهداف النشطة${streak() ? ` <span class="cnt">سلسلة ${n(streak())} يوم</span>` : ''}</p>
      ${goals.length ? goals.map(({ g, p }) => `<a class="db-goal" href="#/goals"><span>${g.emoji ? `${esc(g.emoji)} ` : ''}${esc(g.title)}</span><div class="db-meter" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p.pct}%"></i></div><b>${p.total ? `${n(p.pct)}%` : '—'}</b></a>`).join('')
    : '<p class="note">لا أهداف نشطة. هدف واحد واضح لكل مجال يكفي.</p>'}
    </section>
  </div>`;
}
