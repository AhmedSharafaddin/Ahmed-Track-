// الاتزان: هل يذهب جهدك إلى ما يهمك فعلًا؟
// كل رقم هنا محسوب من مهامك وجلسات تركيزك وتقييمك أنت. لا بيانات مختلقة ولا تخمين.
//
// التخزين: داخل مستند المراجعة الأسبوعية نفسه (reviews/<بداية الأسبوع>) حتى لا نضيف مجموعة جديدة:
//   wheel  { areaId: 1..10 }   رضاك عن كل مجال هذا الأسبوع
//   energy { 'YYYY-MM-DD': 1|2|3 }  طاقتك في اليوم (منخفضة/عادية/عالية)
//   min    ['YYYY-MM-DD']      أيام «الحد الأدنى»
//   stuck  [{ d, f, a, h }]    مرات «عالق؟»: اليوم، الشعور، المجال، الساعة

import { store } from './store.js';
import { dateKey, addDays, keyAdd, todayKey, weekStart, weekKey, n, esc, fmtMin } from './utils.js';
import { S, areas, areaById, isOpen, openTasks, isOverdue, isReviewDoc } from './model.js';

const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const dayOf = (iso) => (iso ? iso.slice(0, 10) : '');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const WINDOW = 14;

/* ───────── مستند الأسبوع ───────── */
export const weekDoc = (wk = weekKey()) => S().reviews.find((r) => r.id === wk) || { id: wk };
export function saveWeek(patch, wk = weekKey()) {
  return store.put('reviews', { ...weekDoc(wk), ...patch, id: wk });
}
const cleanWheel = (w) => {
  const o = {};
  if (w && typeof w === 'object') for (const [k, v] of Object.entries(w)) { const x = Math.round(Number(v)); if (x >= 1 && x <= 10 && areaById(k)) o[k] = x; }
  return o;
};
export const wheelOf = (wk = weekKey()) => cleanWheel(weekDoc(wk).wheel);
export const isMinDay = (k = todayKey()) => { const m = weekDoc(weekKey(new Date(`${k}T12:00:00`))).min; return Array.isArray(m) && m.includes(k); };
export const energyOf = (k = todayKey()) => { const e = weekDoc(weekKey(new Date(`${k}T12:00:00`))).energy; const v = e && typeof e === 'object' ? Number(e[k]) : 0; return v >= 1 && v <= 3 ? v : 0; };

export function rate(areaId, v) {
  if (!areaById(areaId)) return;
  const w = { ...wheelOf() };
  const x = clamp(Math.round(Number(v)) || 0, 1, 10);
  if (w[areaId] === x) delete w[areaId]; else w[areaId] = x; // ضغطة ثانية على الرقم نفسه تمسحه
  return saveWeek({ wheel: w });
}
export function setEnergy(v) {
  const cur = weekDoc().energy;
  const e = { ...(cur && typeof cur === 'object' ? cur : {}) };
  const x = clamp(Math.round(Number(v)) || 0, 1, 3);
  if (e[todayKey()] === x) delete e[todayKey()]; else e[todayKey()] = x;
  return saveWeek({ energy: e });
}
export function toggleMinDay() {
  const k = todayKey();
  const cur = Array.isArray(weekDoc().min) ? weekDoc().min : [];
  const on = !cur.includes(k);
  saveWeek({ min: on ? [...cur, k] : cur.filter((x) => x !== k) });
  return on;
}
export function logStuck(feeling, areaId) {
  const cur = Array.isArray(weekDoc().stuck) ? weekDoc().stuck : [];
  saveWeek({ stuck: [...cur, { d: todayKey(), f: feeling, a: areaId || null, h: new Date().getHours() }].slice(-60) });
}

/* ───────── «عالق؟»: علاج مختلف لكل شعور ───────── */
export const STUCK = {
  unclear: { label: 'لا أعرف من أين أبدأ', icon: 'brain', min: 10, ask: 'ما أول ما ستفعله بيديك خلال ثلاث دقائق؟ (افتح، اكتب، اتصل…)', ph: 'مثال: أفتح الملف وأكتب العنوان',
    text: 'المهمة تبدو مشروعًا لا خطوة. حوّل الغموض إلى فعل واحد صغير، ثم اعمل عليه عشر دقائق فقط.', tip: 'اكتب «أول خطوة» للمهمة الكبيرة عند إضافتها، قبل أن تحتاجها.' },
  fear: { label: 'أخاف ألا تكون النتيجة جيدة', icon: 'hand', min: 10, step: 'مسودة سيئة عمدًا، ثم أحسّنها لاحقًا',
    text: 'الرغبة في الكمال تمنع البدء. الهدف الآن أن يوجد شيء، لا أن يكون جيدًا: عشر دقائق لمسودة سيئة عمدًا، والتحسين لاحقًا.', tip: 'المسودة الأولى تُكتب لتُعدَّل، لا لتكون جيدة.' },
  bored: { label: 'المهمة مملة أو ثقيلة', icon: 'hourglass', min: 15,
    text: 'خمس عشرة دقيقة فقط ثم مكافأة تختارها أنت: قهوة، مشي قصير، أو أي شيء تحبه. بعدها قرّر إن كنت تكمل.', tip: 'اربط المهام الثقيلة بجلسة قصيرة ومكافأة صغيرة.' },
  scatter: { label: 'أتشتت وأقفز بين المهام', icon: 'bolt', min: 15,
    text: 'اعمل على هذه المهمة وحدها خمس عشرة دقيقة. أي فكرة تطرأ اكتبها في حقل «فكرة طارئة» داخل شاشة التركيز فتذهب للوارد، وعد لمهمتك.', tip: 'احصر أولويات اليوم في ثلاث، واكتب الأفكار الطارئة بدل تنفيذها.' },
  tired: { label: 'طاقتي منخفضة', icon: 'moon', min: 5,
    text: 'الإرهاق معلومة وليس ضعفًا. إما خمس دقائق فقط ثم تقرّر، أو اجعل اليوم «حدًّا أدنى»: أولوية واحدة تكفي.', tip: 'ضع المهمة الثقيلة في الوقت الذي تنجز فيه أكثر، وخفّف الحمل في الأيام المتعبة.' },
};

export function stuckSheet(t, I, feeling) {
  const head = `<div class="cap-h"><p class="pk-t">${I('hand', 'i')}عالق؟</p><button class="ib" data-act="close" aria-label="إغلاق">${I('x')}</button></div>`;
  if (!feeling || !STUCK[feeling]) {
    return `<div class="commit stuck">${head}<h2>${esc(t.title)}</h2>
      <p class="sub">ما الشعور الأقرب الآن؟ لا جواب خاطئ، ولكل شعور علاج مختلف.</p>
      <div class="stuck-list">${Object.entries(STUCK).map(([k, f]) => `<button class="prow" data-act="stuck-pick" data-id="${t.id}" data-f="${k}">${I(f.icon, 'i')}<span>${f.label}</span></button>`).join('')}</div></div>`;
  }
  const f = STUCK[feeling];
  return `<form class="commit stuck" data-form="stuck" data-id="${t.id}" data-f="${feeling}">${head}<h2>${esc(t.title)}</h2>
    <p class="stuck-text">${f.text}</p>
    ${f.ask ? `<label class="wk-f"><span>${f.ask}</span><input class="in" name="step" maxlength="200" placeholder="${f.ph}" autocomplete="off" /></label>` : ''}
    <button class="btn primary big" type="submit">${I('play', 'f')}ابدأ ${n(f.min)} دقائق الآن</button>
    ${feeling === 'tired' ? `<button class="btn" type="button" data-act="min-day" data-on="1">${I('moon', 'd')}اجعل اليوم «حدًّا أدنى»</button>` : ''}
    <button class="link" type="button" data-act="stuck" data-id="${t.id}">شعور آخر</button>
  </form>`;
}

/* ───────── الحساب ───────── */
/**
 * الجهد لكل مجال في آخر ١٤ يومًا = المهام المنجزة + جلسات التركيز (كل ٢٥ دقيقة = وحدة).
 * `eff` نسبة المجال إلى أعلى مجال (٠–١٠٠)، و`share` حصته من مجموع الجهد.
 */
export function balanceData() {
  const t0 = todayKey();
  const from = keyAdd(t0, -(WINDOW - 1));
  const list = areas();
  const by = new Map(list.map((a) => [a.id, { a, done: 0, focus: 0, open: 0, late: 0, slips: 0, units: 0, eff: 0, share: 0 }]));
  let noArea = 0;
  for (const t of S().tasks) {
    const r = by.get(t.areaId);
    if (!r) { if (isOpen(t) && !t.parked) noArea++; continue; }
    if (!isOpen(t)) { if (dayOf(t.completedAt) >= from) r.done++; } else if (!t.parked) {
      r.open++;
      if (isOverdue(t)) r.late++;
      r.slips += (t.slips || 0) + (t.snoozes || 0);
    }
    for (const x of (Array.isArray(t.focusLog) ? t.focusLog : [])) if (Array.isArray(x) && x[0] >= from) r.focus += Number(x[1]) || 0;
  }
  const rows = [...by.values()];
  for (const r of rows) r.units = r.done + r.focus / 25;
  const total = rows.reduce((s, r) => s + r.units, 0);
  const max = Math.max(0, ...rows.map((r) => r.units));
  for (const r of rows) { r.eff = max ? Math.round((r.units / max) * 100) : 0; r.share = total ? Math.round((r.units / total) * 100) : 0; }

  const wheel = wheelOf();
  const prevWk = dateKey(addDays(weekStart(), -7));
  const prev = wheelOf(prevWk);
  for (const r of rows) { r.sat = wheel[r.a.id] || 0; r.prev = prev[r.a.id] || 0; }
  const rated = rows.filter((r) => r.sat);
  const complete = rows.length > 0 && rated.length === rows.length;

  // مؤشر الاتزان: متوسط رضاك (من ١٠٠) ناقص ٣ نقاط عن كل درجة فجوة بين أعلى مجال وأدناه.
  let score = null;
  if (rated.length >= 2 && complete) {
    const sats = rated.map((r) => r.sat);
    const mean = sats.reduce((s, x) => s + x, 0) / sats.length;
    score = clamp(Math.round(mean * 10 - (Math.max(...sats) - Math.min(...sats)) * 3), 0, 100);
  }
  const top = rows.slice().sort((x, y) => y.units - x.units)[0] || null;
  const idle = rows.filter((r) => r.units === 0);
  const low = rated.slice().sort((x, y) => x.sat - y.sat || x.eff - y.eff)[0] || null;
  return { rows, total, top, idle, wheel, rated, complete, score, low, noArea, from };
}

/** تنبيه واحد لشاشة اليوم: مجال يطغى ومجال بلا أي جهد. يظهر فقط حين تكفي البيانات. */
export function balanceAlert() {
  const d = balanceData();
  if (d.rows.length < 2 || d.total < 6 || !d.top || d.top.share < 55 || !d.idle.length) return null;
  const gap = d.idle.slice(0, 2).map((r) => r.a.name).join(' و');
  return { title: `«${d.top.a.name}» يأخذ ${n(d.top.share)}% من جهدك`, sub: `${gap} بلا أي إنجاز منذ أسبوعين.`, areaId: d.idle[0].a.id };
}

/** هل حان وقت تقييم العجلة؟ آخر يومين من الأسبوع ولم يكتمل التقييم. */
export function wheelDue() {
  const d = Math.round((new Date(`${todayKey()}T12:00:00`) - weekStart()) / 864e5);
  return areas().length >= 2 && d >= 5 && Object.keys(wheelOf()).length < areas().length;
}

function rhythm() {
  const t0 = todayKey();
  const from = keyAdd(t0, -27);
  const done = S().tasks.filter((t) => !isOpen(t) && t.completedAt && dayOf(t.completedAt) >= from);
  const out = { n: done.length, best: null, worst: null, peak: null };
  if (done.length >= 10) {
    const wd = Array.from({ length: 7 }, () => 0);
    const hr = Array.from({ length: 8 }, () => 0); // فترات من ٣ ساعات
    for (const t of done) { const d = new Date(t.completedAt); if (Number.isNaN(+d)) continue; wd[d.getDay()]++; hr[Math.floor(d.getHours() / 3)]++; }
    const act = wd.map((c, i) => ({ i, c })).filter((x) => x.c);
    if (act.length >= 3) { act.sort((a, b) => b.c - a.c); out.best = act[0]; out.worst = act[act.length - 1]; }
    const pi = hr.indexOf(Math.max(...hr));
    if (hr[pi] >= 4) out.peak = { from: pi * 3, to: pi * 3 + 3, c: hr[pi] };
  }
  // «عالق؟» والطاقة: آخر أربعة أسابيع
  const stuck = []; const en = [];
  for (const r of S().reviews) {
    if (!isReviewDoc(r) || r.id < keyAdd(t0, -34)) continue;
    if (Array.isArray(r.stuck)) for (const s of r.stuck) if (s && STUCK[s.f] && s.d >= from) stuck.push(s);
    if (r.energy && typeof r.energy === 'object') for (const [k, v] of Object.entries(r.energy)) if (k >= from && v >= 1 && v <= 3) en.push([k, Number(v)]);
  }
  out.stuck = stuck;
  const perDay = new Map();
  for (const t of done) perDay.set(dayOf(t.completedAt), (perDay.get(dayOf(t.completedAt)) || 0) + 1);
  const hi = en.filter(([, v]) => v === 3).map(([k]) => perDay.get(k) || 0);
  const lo = en.filter(([, v]) => v === 1).map(([k]) => perDay.get(k) || 0);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  out.energy = hi.length >= 2 && lo.length >= 2 ? { hi: avg(hi), lo: avg(lo) } : null;
  return out;
}
const hour = (h) => { const x = ((h % 24) + 24) % 24; return `${n(x % 12 === 0 ? 12 : x % 12)} ${x < 12 ? 'ص' : 'م'}`; };

/** رؤى مبنية على بياناتك فقط. كل رؤية: نص + إجراء اختياري. */
export function insights(d = balanceData()) {
  const out = [];
  const add = (icon, text, areaId, cls = '') => out.push({ icon, text, areaId, cls });
  if (d.total >= 6 && d.top && d.top.share >= 55) {
    add('scales', `<b>${esc(d.top.a.name)}</b> يأخذ ${n(d.top.share)}% من جهدك في آخر أسبوعين${d.idle.length ? `، و<b>${d.idle.slice(0, 2).map((r) => esc(r.a.name)).join(' و')}</b> بلا أي إنجاز` : ''}. التوازن لا يعني التساوي، لكن مجالًا مهملًا طويلًا يدفع الثمن لاحقًا.`, d.idle[0]?.a.id, 'warn');
  }
  for (const r of d.rated) {
    const nm = `<b>${esc(r.a.name)}</b>`;
    if (r.sat <= 5 && r.eff >= 60) add('brain', `${nm}: جهدك مرتفع ورضاك ${n(r.sat)} من ١٠. غالبًا المهام لا تمس ما يهمك فعلًا؛ غيّر نوع المهام لا عددها.`, null, 'warn');
    else if (r.sat <= 5 && r.eff < 40) add('sparkle', `${nm}: رضاك ${n(r.sat)} من ١٠ وجهدك فيه قليل. ابدأ بخطوة تقل عن خمس دقائق هذا الأسبوع.`, r.a.id, 'warn');
    else if (r.sat >= 8 && r.eff < 30) add('check', `${nm}: راضٍ عنه رغم قلة المهام. لا تثقله بمهام لا يحتاجها.`);
    if (r.prev && r.sat - r.prev <= -2) add('fire', `${nm}: هبط رضاك ${n(r.prev - r.sat)} درجات عن الأسبوع الماضي. ما الذي تغيّر؟`, r.a.id, 'warn');
  }
  const slip = d.rows.filter((r) => r.slips >= 3).sort((a, b) => b.slips - a.slips)[0];
  if (slip) add('hourglass', `أكثر ما تؤجله في <b>${esc(slip.a.name)}</b> (${n(slip.slips)} ترحيلًا وتأجيلًا على مهامه المفتوحة). صغّر مهامه أو أسند بعضها.`);
  const late = d.rows.filter((r) => r.late >= 2).sort((a, b) => b.late - a.late)[0];
  if (late && late !== slip) add('cal', `<b>${esc(late.a.name)}</b> فيه ${n(late.late)} متأخرة. قرار واحد لكل منها يريحك: اليوم، موعد واقعي، إسناد، أو حذف.`);
  const rh = rhythm();
  if (rh.best && rh.worst && rh.best.i !== rh.worst.i) add('chart', `أكثر أيامك إنجازًا <b>${DAYS[rh.best.i]}</b> (${n(rh.best.c)} مهمة في أربعة أسابيع)، وأقلها <b>${DAYS[rh.worst.i]}</b> (${n(rh.worst.c)}). خفّف يومك الأضعف بدل تحميله.`);
  if (rh.peak) add('bolt', `أكثر وقت تُغلق فيه مهامك بين <b>${hour(rh.peak.from)} و${hour(rh.peak.to)}</b> (${n(rh.peak.c)} من ${n(rh.n)}). ضع فيه أصعب مهمة. (محسوب من وقت تعليمها منجزة.)`);
  if (rh.energy) add('sun', `في أيام طاقتك العالية تنجز ${n(Math.round(rh.energy.hi * 10) / 10)} مهمة في المتوسط، مقابل ${n(Math.round(rh.energy.lo * 10) / 10)} في الأيام المنخفضة. خطّط يومك على طاقتك لا على أمنياتك.`);
  if (rh.stuck.length >= 3) {
    const c = {};
    for (const s of rh.stuck) c[s.f] = (c[s.f] || 0) + 1;
    const k = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
    add('hand', `أكثر ما يعلّقك: <b>${STUCK[k].label}</b> (${n(c[k])} من ${n(rh.stuck.length)}). ${STUCK[k].tip}`);
  }
  if (d.noArea >= 5) add('inbox', `${n(d.noArea)} مهمة مفتوحة بلا مجال، فلا تدخل في حساب الاتزان. <a href="#/list/inbox">صنّفها</a>`);
  return out.slice(0, 7);
}

/* ───────── الرسم: عجلة الاتزان ───────── */
function wheelSvg(rows) {
  const N = rows.length;
  const C = 150; const R = 104;
  const ang = (i) => -Math.PI / 2 + (2 * Math.PI * i) / N;
  const pt = (i, v) => `${(C + R * (v / 10) * Math.cos(ang(i))).toFixed(1)},${(C + R * (v / 10) * Math.sin(ang(i))).toFixed(1)}`;
  const poly = (f) => rows.map((r, i) => pt(i, f(r))).join(' ');
  const grid = [2.5, 5, 7.5, 10].map((v) => `<polygon class="wg" points="${rows.map((_, i) => pt(i, v)).join(' ')}"/>`).join('');
  const axes = rows.map((_, i) => `<line class="wg" x1="${C}" y1="${C}" x2="${pt(i, 10).split(',')[0]}" y2="${pt(i, 10).split(',')[1]}"/>`).join('');
  const labels = rows.map((r, i) => {
    const [x, y] = pt(i, 12.1).split(',').map(Number);
    const anchor = Math.abs(x - C) < 12 ? 'middle' : x > C ? 'start' : 'end';
    const name = r.a.name.length > 12 ? `${r.a.name.slice(0, 11)}…` : r.a.name;
    return `<text x="${x}" y="${y + 4}" text-anchor="${anchor}" class="wl">${r.a.emoji ? `${esc(r.a.emoji)} ` : ''}${esc(name)}</text>`;
  }).join('');
  const hasPrev = rows.some((r) => r.prev);
  const hasSat = rows.some((r) => r.sat);
  const dots = rows.map((r, i) => (r.sat ? `<circle class="wd" style="--c:${esc(r.a.color)}" r="4.5" cx="${pt(i, r.sat).split(',')[0]}" cy="${pt(i, r.sat).split(',')[1]}"/>` : '')).join('');
  const desc = rows.map((r) => `${r.a.name}: ${r.sat ? `رضا ${r.sat} من 10` : 'بلا تقييم'}، جهد ${r.eff}%`).join('؛ ');
  return `<svg class="wheel" viewBox="-70 -6 440 312" role="img" aria-label="عجلة الاتزان. ${esc(desc)}">
    ${grid}${axes}
    <polygon class="we" points="${poly((r) => r.eff / 10)}"/>
    ${hasPrev ? `<polygon class="wp" points="${poly((r) => r.prev || 0)}"/>` : ''}
    ${hasSat ? `<polygon class="ws" points="${poly((r) => r.sat || 0)}"/>` : ''}
    ${dots}${labels}</svg>`;
}

/* ───────── الصفحة ───────── */
/** @param {{I:Function, areaMark:Function, vh:Function}} h */
export function vBalance(h) {
  const { I, areaMark, vh } = h;
  const d = balanceData();
  if (!d.rows.length) {
    return `${vh('الاتزان', 'هل يذهب جهدك إلى ما يهمك فعلًا؟')}<div class="empty">${I('scales', 'd', 'big')}<p>أضف مجالات حياتك وعملك أولًا، ثم عُد لتقيس الاتزان بينها.</p><a class="btn primary" href="#/settings#areas">أضف مجالًا</a></div>`;
  }
  const ins = insights(d);
  const en = energyOf();
  const min = isMinDay();
  const ratedN = d.rated.length;
  const verdict = d.score == null ? '' : d.score >= 75 ? 'متزن. حافظ على الإيقاع.' : d.score >= 55 ? 'مقبول، ومجال واحد يحتاج عناية.' : 'مختل. ابدأ بأضعف مجال، بخطوة واحدة صغيرة.';
  const hero = d.score != null
    ? `<div class="db-big"><b>${n(d.score)}</b><div><span>مؤشر الاتزان هذا الأسبوع</span><em>${verdict}</em></div></div>
       <p class="db-lede">متوسط رضاك عن مجالاتك من ١٠٠، ناقص ٣ نقاط عن كل درجة فجوة بين أعلى مجال وأدناه.</p>`
    : `<div class="db-big"><b>${n(ratedN)}<small>/${n(d.rows.length)}</small></b><div><span>مجالات قيّمتها هذا الأسبوع</span><em>دقيقة واحدة: قيّم رضاك عن كل مجال من ١ إلى ١٠.</em></div></div>
       <p class="db-lede">ليس كم أنجزت، بل مدى رضاك. ١٠ راضٍ جدًا، و١ مهمل تمامًا. ثم نقارنه بجهدك الفعلي.</p>`;

  const rateRow = (r) => {
    const tr = r.sat && r.prev ? r.sat - r.prev : 0;
    return `<div class="bal-row" style="--c:${esc(r.a.color)}">
      <div class="bal-name">${areaMark(r.a, 'sm')}<span>${esc(r.a.name)}</span>${tr ? `<em class="${tr > 0 ? 'up' : 'down'}">${tr > 0 ? '+' : '−'}${n(Math.abs(tr))}</em>` : ''}</div>
      <div class="bal-rate" role="group" aria-label="رضاك عن ${esc(r.a.name)} من ١ إلى ١٠">${Array.from({ length: 10 }, (_, i) => `<button type="button" class="${r.sat === i + 1 ? 'on' : r.sat > i ? 'in' : ''}" aria-pressed="${r.sat === i + 1}" data-act="bal-rate" data-id="${r.a.id}" data-v="${i + 1}">${n(i + 1)}</button>`).join('')}</div>
      <div class="bal-eff" title="الجهد منسوبًا لأعلى مجال"><div class="bar"><i style="width:${r.eff}%"></i></div><small>جهد ${n(r.eff)}%</small></div>
    </div>`;
  };

  const low = d.low && d.low.sat <= 7 ? d.low : null;
  const stepForm = low ? `<form class="panel bal-step" data-form="bal-step" data-area="${low.a.id}">
      <p class="lbl">${I('sparkle', 'd')}خطوة واحدة لأضعف مجال</p>
      <label><span>ما أصغر شيء تفعله هذا الأسبوع ليرتفع رضاك عن «${esc(low.a.name)}» درجة واحدة؟ (${n(low.sat)} من ١٠ الآن)</span>
        <input class="in" name="title" maxlength="200" placeholder="خطوة صغيرة تبدأ بفعل" autocomplete="off" data-draft="bal-step" value="${esc(h.ui?.drafts?.['bal-step'] || '')}" /></label>
      <div class="row"><button class="btn primary" type="submit" name="when" value="today">أضفها لليوم</button><button class="btn" type="submit" name="when" value="tomorrow">لغدٍ</button></div>
    </form>` : '';

  return `${vh('الاتزان', 'هل يذهب جهدك إلى ما يهمك فعلًا؟ رضاك مقابل جهدك في كل مجال.', '', `<span class="vh-i">${I('scales', 'd')}</span>`)}
  <section class="db-hero bal-hero" aria-label="مؤشر الاتزان">${hero}</section>
  <div class="bal-grid">
    <section class="panel bal-wheel"><p class="lbl">عجلة الاتزان <span class="cnt">هذا الأسبوع</span></p>
      ${d.rows.length >= 3 ? wheelSvg(d.rows) : '<p class="note">العجلة تُرسم من ثلاثة مجالات فأكثر. المقارنة بالأشرطة في الأسفل.</p>'}
      <p class="bal-legend"><span class="k-s">رضاك</span><span class="k-e">جهدك الفعلي</span>${d.rows.some((r) => r.prev) ? '<span class="k-p">رضا الأسبوع الماضي</span>' : ''}</p>
    </section>
    <section class="panel"><p class="lbl">قيّم رضاك <span class="cnt">${n(ratedN)} من ${n(d.rows.length)}</span></p>
      <div class="bal-rows">${d.rows.map(rateRow).join('')}</div>
      ${h.missing?.length && d.rows.length < 6 ? `<p class="note">الاتزان يُقاس بين مجالات حياتك كلها. <button class="link" data-act="life-areas">أضف الناقص: ${h.missing.map((L) => L.name).join('، ')}</button></p>` : ''}
      <p class="note">الجهد = المهام المنجزة + جلسات التركيز (كل ٢٥ دقيقة وحدة) في آخر ${n(WINDOW)} يومًا، منسوبًا لأعلى مجال.</p>
    </section>
  </div>
  ${stepForm}
  <section class="blk"><p class="lbl">${I('bolt', 'i', 'gold')}ما تقوله بياناتك</p>
    ${ins.length ? `<ul class="bal-ins">${ins.map((x) => `<li class="${x.cls}">${I(x.icon, 'i')}<p>${x.text}</p>${x.areaId ? `<button class="chip-b" data-act="bal-add" data-id="${x.areaId}">${I('plus')}خطوة صغيرة</button>` : ''}</li>`).join('')}</ul>`
    : `<div class="db-clear">${I('sparkle', 'd')}<span>لا ملاحظات بعد. تظهر الرؤى حين تُنجز مهامًا في مجالاتك وتقيّم رضاك.</span></div>`}
  </section>
  <div class="bal-grid">
    <section class="panel"><p class="lbl">أين يذهب جهدك <span class="cnt">آخر ${n(WINDOW)} يومًا</span></p>
      <table class="db-team bal-table"><thead><tr><th>المجال</th><th>الحصة</th><th>منجزة</th><th>تركيز</th><th>مفتوحة</th><th>متأخرة</th></tr></thead><tbody>
      ${d.rows.slice().sort((a, b) => b.units - a.units).map((r) => `<tr><td><a href="#/area/${r.a.id}">${areaMark(r.a, 'xs')}${esc(r.a.name)}</a></td><td>${d.total ? `${n(r.share)}%` : '—'}</td><td>${n(r.done)}</td><td>${r.focus ? fmtMin(r.focus) : '—'}</td><td>${n(r.open)}</td><td class="${r.late ? 'tbad' : ''}">${n(r.late)}</td></tr>`).join('')}
      </tbody></table>
      ${d.noArea ? `<p class="note">${n(d.noArea)} مهمة مفتوحة بلا مجال خارج الحساب. <a href="#/list/inbox">صنّفها</a></p>` : ''}
    </section>
    <section class="panel"><p class="lbl">${I('sun', 'd')}إيقاع يومك</p>
      <div class="prow static"><span>طاقتك اليوم<small>تسجيلها يكشف كم تنجز فعلًا في كل حالة</small></span>
        <div class="seg sm" role="group" aria-label="طاقتك اليوم">${[[1, 'منخفضة'], [2, 'عادية'], [3, 'عالية']].map(([v, l]) => `<button class="${en === v ? 'on' : ''}" aria-pressed="${en === v}" data-act="bal-energy" data-v="${v}">${l}</button>`).join('')}</div></div>
      <button class="prow" data-act="min-day">${I('hand', 'i')}<span>${min ? 'اليوم «حدّ أدنى»: مفعّل' : 'يوم صعب؟ اجعله «حدًّا أدنى»'}<small>${min ? 'أولوية واحدة تكفي اليوم وتحفظ سلسلتك. اضغط للعودة ليوم عادي.' : 'أولوية واحدة فقط تكفي وتحفظ سلسلتك. الأيام الصعبة تُدار ولا تُلغى.'}</small></span></button>
      <button class="prow" data-act="rit-start">${I('sun', 'i')}<span>بداية اليوم<small>تفريغ الرأس، حتى ثلاث أولويات، أول خطوة، وإذا/فإن</small></span></button>
      <button class="prow" data-act="rit-end">${I('moon', 'i')}<span>ختم اليوم<small>المزاج، تحسين واحد للغد، وقرار لكل ما لم يُنجز</small></span></button>
      <button class="prow" data-act="library">${I('sparkle', 'i')}<span>مكتبة المهام<small>مهام صغيرة مجرَّبة لمجالات الحياة الخمسة</small></span></button>
      <a class="prow" href="#/review">${I('note', 'i')}<span>المراجعة الأسبوعية<small>ما أنجزته، ما عطّلك، وأهم ثلاثة للأسبوع القادم</small></span></a>
    </section>
  </div>`;
}
