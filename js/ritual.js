// حلقة اليوم والمكتبة — مستنبطة من سكربت «اتزان V14» (نظام ٥ • ٣ • ١):
//   بداية اليوم: تفريغ الرأس ← حتى ٣ أولويات ← أول خطوة ← متى ← إذا/فإن
//   ختم اليوم: المزاج ← ما سار جيدًا ← ما استنزفك ← تحسين واحد للغد ← قرار لكل مهمة لم تُنجز
//   نتائج الأسبوع الثلاث، ومكتبة المهام المقترحة لمجالات الحياة الخمسة.
// التخزين في مستند المراجعة الأسبوعية: days { 'YYYY-MM-DD': {...} } و results [{id,t,done}].

import { uid, todayKey, keyAdd, weekKey, dateKey, addDays, weekStart, n, esc, fmtMin } from './utils.js';
import { S, areas, isOpen, isWaiting, isLocked, focusToday, alsoToday, suggestions, doneToday, MAX_FOCUS } from './model.js';
import { weekDoc, saveWeek } from './balance.js';

const wkOf = (k) => weekKey(new Date(`${k}T12:00:00`));

/* ───────── سجل اليوم ───────── */
export function dayRec(k = todayKey()) {
  const d = weekDoc(wkOf(k)).days;
  const r = d && typeof d === 'object' ? d[k] : null;
  return r && typeof r === 'object' ? r : {};
}
export function saveDay(patch, k = todayKey()) {
  const wk = wkOf(k);
  const cur = weekDoc(wk).days;
  const days = { ...(cur && typeof cur === 'object' ? cur : {}) };
  days[k] = { ...(days[k] || {}), ...patch };
  return saveWeek({ days }, wk);
}
/** تحسين اليوم: ما اخترته في آخر ختم (خلال ٤ أيام)، يظهر أعلى اليوم حتى تنجزه. */
export function todayImprove() {
  const t0 = todayKey();
  const mine = dayRec(t0);
  for (let i = 1; i <= 4; i++) {
    const k = keyAdd(t0, -i);
    const r = dayRec(k);
    if (r.endAt) return r.improve ? { text: String(r.improve).slice(0, 200), done: mine.improveDone === k, from: k } : null;
  }
  return null;
}

/* ───────── نتائج الأسبوع الثلاث ───────── */
export const MAX_RESULTS = 3;
export function weekResults(wk = weekKey()) {
  const r = weekDoc(wk).results;
  return (Array.isArray(r) ? r : []).filter((x) => x && x.id && typeof x.t === 'string' && x.t.trim()).slice(0, MAX_RESULTS);
}
/** اقتراح من «أهم ثلاثة للأسبوع القادم» في مراجعة الأسبوع الماضي، إن لم تُحدَّد نتائج بعد. */
export function suggestedResults() {
  if (weekResults().length) return [];
  const prev = weekDoc(dateKey(addDays(weekStart(), -7))).next;
  return typeof prev === 'string' ? prev.split(/\n+/).map((s) => s.replace(/^[\s\d٠-٩.\-–•)]+/, '').trim()).filter(Boolean).slice(0, MAX_RESULTS) : [];
}
export function saveResults(texts) {
  const old = weekResults();
  const list = texts.map((t) => String(t || '').trim().slice(0, 160)).filter(Boolean).slice(0, MAX_RESULTS)
    .map((t) => { const o = old.find((x) => x.t === t); return o || { id: uid(), t, done: false }; });
  return saveWeek({ results: list });
}
export function toggleResult(id) {
  return saveWeek({ results: weekResults().map((r) => (r.id === id ? { ...r, done: !r.done } : r)) });
}

/* ───────── العوائق: نية تنفيذ «إذا… فإنني…» ───────── */
export const OBSTACLES = {
  phone: { label: 'الهاتف والتنبيهات', cue: 'أمسكتُ هاتفي', fix: 'أقلبه وأضعه بعيدًا وأكمل دقيقتين' },
  idea: { label: 'فكرة أهم تطرأ فجأة', cue: 'طرأت فكرة أو مهمة أخرى', fix: 'أكتبها في الوارد وأكمل دون تبديل' },
  people: { label: 'مقاطعات من الناس', cue: 'قاطعني أحد', fix: 'أخبره أنني أعود إليه بعد الجلسة' },
  tired: { label: 'تعب أو مزاج سيئ', cue: 'شعرت بتعب أو ملل', fix: 'أكمل خمس دقائق فقط ثم أقرر' },
  unclear: { label: 'لا أعرف ماذا بعد الخطوة الأولى', cue: 'لم أعرف ماذا أفعل', fix: 'أكتب أسوأ مسودة ممكنة وأحسّنها لاحقًا' },
};
export const intentOf = (k) => (OBSTACLES[k] ? `إذا ${OBSTACLES[k].cue} فإنني ${OBSTACLES[k].fix}` : '');

export const MOODS = [[5, '😄', 'ممتاز'], [4, '🙂', 'جيد'], [3, '😐', 'عادي'], [2, '😔', 'متعب'], [1, '😣', 'صعب']];

/** أي طقس يُعرض الآن في بطاقة اليوم؟ الصباح حتى ٣ عصرًا، والختم من ٤ عصرًا. */
export function ritualDue() {
  const h = new Date().getHours();
  const r = dayRec();
  if (!r.startAt && h >= 4 && h < 15) return 'start';
  if (!r.endAt && (h >= 16 || h < 3)) return 'end';
  return null;
}

/* ───────── بداية اليوم ───────── */
export function startSheet(I) {
  const focus = focusToday().filter(isOpen);
  const seen = new Set(focus.map((t) => t.id));
  const cands = [...focus];
  for (const t of [...alsoToday(), ...suggestions(8)]) if (!seen.has(t.id) && isOpen(t) && !isWaiting(t)) { seen.add(t.id); cands.push(t); }
  const list = cands.slice(0, 12);
  return `<form class="rit" data-form="rit-start">
    <div class="cap-h"><h2>${I('sun', 'd')}بداية اليوم</h2><button class="ib" type="button" data-act="close" aria-label="إغلاق">${I('x')}</button></div>
    <p class="sub">دقيقتان تمنعان يومًا مشتتًا: فرّغ رأسك، اختر الأهم، وحدّد أول خطوة.</p>
    <fieldset><legend><b>١</b> فرّغ رأسك</legend>
      <textarea class="in" name="dump" rows="3" maxlength="1500" placeholder="كل ما يشغل بالك أو تخشى نسيانه، كل فكرة في سطر. تذهب للوارد ولا تُنفَّذ الآن."></textarea></fieldset>
    <fieldset><legend><b>٢</b> أولويات اليوم <small>حتى ${n(MAX_FOCUS)}، والأولى هي الأهم</small></legend>
      ${list.length ? `<div class="rit-list">${list.map((t) => `<label class="rit-pick"><input type="checkbox" name="pick" value="${t.id}"${focus.includes(t) ? ' checked' : ''} /><span>${esc(t.title)}${t.est ? `<small>${fmtMin(t.est)}</small>` : ''}</span></label>`).join('')}</div>` : ''}
      <input class="in" name="newtask" maxlength="200" placeholder="${list.length ? 'أو اكتب مهمة جديدة لتكون أولوية' : 'ما المهمة التي لو أُنجزت اليوم صار كل ما بعدها أسهل؟'}" autocomplete="off" /></fieldset>
    <fieldset><legend><b>٣</b> أول خطوة للأولى</legend>
      <input class="in" name="step" maxlength="200" placeholder="أصغر فعل تبدأ به خلال دقيقتين. مثال: أفتح الملف وأكتب العنوان" autocomplete="off" /></fieldset>
    <fieldset><legend><b>٤</b> متى تبدأ؟</legend>
      <div class="rit-chips">${[['now', 'الآن مباشرة'], ['coffee', 'بعد القهوة أو الفطور'], ['later', 'لاحقًا اليوم']].map(([v, l], i) => `<label><input type="radio" name="when" value="${v}"${i === 0 ? ' checked' : ''} /><span>${l}</span></label>`).join('')}</div></fieldset>
    <fieldset><legend><b>٥</b> ما أكثر ما قد يشتتك؟ <small>نقرر الرد الآن، قبل أن تحتاجه</small></legend>
      <div class="rit-chips">${Object.entries(OBSTACLES).map(([k, o]) => `<label><input type="radio" name="obstacle" value="${k}" /><span>${o.label}</span></label>`).join('')}</div></fieldset>
    <button class="btn primary big" type="submit">${I('check')}اعتمد خطة اليوم</button>
  </form>`;
}

/* ───────── ختم اليوم ───────── */
/** ما لم يُنجز اليوم ويحتاج قرارًا (المسندة من المدير موعدها مقفول فلا تدخل). */
export function leftovers() {
  const seen = new Set();
  return [...focusToday(), ...alsoToday()].filter((t) => isOpen(t) && !isWaiting(t) && !isLocked(t) && !t.assignee && !t.repeat && !seen.has(t.id) && seen.add(t.id));
}
export function endSheet(I) {
  const focus = focusToday();
  const won = focus.filter((t) => !isOpen(t)).length;
  const doneN = doneToday().length;
  const left = leftovers();
  const r = dayRec();
  const v = (k) => esc(r[k] || '');
  return `<form class="rit" data-form="rit-end">
    <div class="cap-h"><h2>${I('moon', 'd')}ختم اليوم</h2><button class="ib" type="button" data-act="close" aria-label="إغلاق">${I('x')}</button></div>
    <p class="sub">أنجزت ${n(won)} من ${n(focus.length || MAX_FOCUS)} أولويات${doneN ? `، و${n(doneN)} مهمة إجمالًا` : ''}. دقيقتان تغلقان اليوم فلا يلاحقك غدًا.</p>
    <fieldset><legend>كيف كان يومك؟</legend>
      <div class="rit-chips mood">${MOODS.map(([val, e, l]) => `<label><input type="radio" name="mood" value="${val}"${Number(r.mood) === val ? ' checked' : ''} /><span><i aria-hidden="true">${e}</i>${l}</span></label>`).join('')}</div></fieldset>
    <label class="rit-f"><span>ما الذي سار جيدًا؟</span><input class="in" name="good" maxlength="300" value="${v('good')}" placeholder="لحظة أو إنجاز، مهما كان صغيرًا" autocomplete="off" /></label>
    <label class="rit-f"><span>ما الذي استنزفك؟</span><input class="in" name="drain" maxlength="300" value="${v('drain')}" placeholder="حدّده لتتعامل معه، لا لتلوم نفسك" autocomplete="off" /></label>
    <label class="rit-f"><span>تحسين واحد للغد</span><input class="in" name="improve" maxlength="200" value="${v('improve')}" placeholder="شيء واحد صغير وواضح. يظهر أعلى يومك غدًا" autocomplete="off" /></label>
    ${left.length ? `<fieldset><legend>لم تُنجز اليوم <small>قرار واعٍ أفضل من ترحيل تلقائي</small></legend>
      <div class="rit-left">${left.slice(0, 10).map((t) => `<div class="rit-row"><span>${esc(t.title)}${(t.slips || 0) + (t.snoozes || 0) >= 2 ? `<small class="late">أُجّلت ${n((t.slips || 0) + (t.snoozes || 0))} مرات</small>` : ''}</span>
        <select class="in sm" name="t-${t.id}" aria-label="قرار: ${esc(t.title)}"><option value="tomorrow">غدًا</option><option value="keep">بلا موعد</option><option value="del">احذفها</option></select></div>`).join('')}</div></fieldset>` : ''}
    <button class="btn primary big" type="submit">${I('check')}اختم اليوم</button>
  </form>`;
}

/* ───────── المكتبة: مهام مقترحة لمجالات الحياة الخمسة ───────── */
export const LIFE_AREAS = [
  { key: 'deen', name: 'ديني', emoji: '🕌', color: '#2f9474', hint: 'صلتك بالله', match: /دين|إيمان|عباد/ },
  { key: 'mental', name: 'نفسي', emoji: '🧠', color: '#b6675a', hint: 'سكينتك الداخلية', match: /نفس|ذات|شخصي/ },
  { key: 'work', name: 'عملي', emoji: '💼', color: '#2b8bb3', hint: 'أثرك وإنجازك', match: /عمل|شغل|وظيف|مهن/ },
  { key: 'health', name: 'صحي', emoji: '🏋️', color: '#a2782d', hint: 'طاقة جسدك', match: /صح|رياض|جسد/ },
  { key: 'relationships', name: 'علاقات', emoji: '🤝', color: '#986cab', hint: 'الناس في حياتك', match: /علاق|أسر|عائل|أهل/ },
];
export const LIBRARY = {
  deen: ['الصلاة في أوقاتها', 'صلاة الفجر في وقتها', 'صلاة الجماعة', 'السنن الرواتب', 'قيام الليل ولو ركعتين', 'ورد القرآن', 'تدبر آيات من القرآن', 'أذكار الصباح', 'أذكار المساء', 'الاستغفار', 'الصلاة على النبي ﷺ', 'الدعاء', 'صدقة', 'صيام تطوع', 'صلة رحم', 'بر الوالدين', 'مساعدة شخص', 'عمل صالح خفي', 'ترك ذنب أو عادة سيئة', 'محاسبة النفس', 'شكر الله على النعم', 'قراءة حديث نبوي', 'الاستماع إلى درس نافع', 'الدعاء لمن أحب', 'الدعاء للمسلمين', 'مراجعة نية اليوم', 'تجنب الغيبة والنميمة', 'العفو عن شخص', 'الإحسان إلى شخص'],
  mental: ['10 دقائق هدوء بدون هاتف', 'تنفس عميق واسترخاء', 'المشي بهدوء', 'كتابة ما يشغلني', 'كتابة مشاعري اليوم', 'كتابة 3 أشياء أنا ممتن لها', 'ترتيب أفكاري', 'التوقف عن التفكير فيما لا أستطيع التحكم به', 'استراحة حقيقية من العمل', 'الابتعاد عن الأخبار والسوشيال ميديا', 'قراءة 10 صفحات من كتاب', 'ممارسة هواية أحبها', 'مشاهدة شيء ممتع', 'وقت خاص مع نفسي', 'التواصل مع شخص أشعر معه بالراحة', 'مراجعة احتياجي النفسي اليوم', 'وضع حدود مع شيء يستنزفني', 'مراجعة أكثر شيء أزعجني اليوم', 'كتابة شيء إيجابي حدث اليوم', 'كتابة شيء تعلمته اليوم', 'الخروج إلى مكان هادئ', 'جلسة تأمل', 'الاستماع إلى شيء هادئ', 'إغلاق الهاتف لفترة', 'التخفيف من المقارنات', 'التعبير عن مشاعري بطريقة صحية', 'مكافأة نفسي بشيء بسيط', 'التوقف عن جلد الذات', 'تقبل شيء لا أستطيع تغييره', 'تحديد أكثر شيء يسبب لي الضغط', 'القيام بنشاط يرفع مزاجي'],
  work: ['إنجاز أهم مهمة اليوم', 'جلسة تركيز 50 دقيقة بلا مقاطعات', 'إنهاء مهمة مؤجلة', 'ترتيب أولويات اليوم', 'التخطيط للغد', 'تنظيف وترتيب مساحة العمل', 'معالجة مشكلة معلقة', 'متابعة مهمة مع الفريق', 'تفويض مهمة', 'مراجعة النتائج والأرقام', 'مراجعة المبيعات', 'مراجعة المصروفات', 'مراجعة المخزون', 'تحسين إجراء أو نظام', 'تعلم مهارة جديدة', 'قراءة محتوى مهني', 'العمل على مشروع طويل المدى', 'مراجعة أهدافي المهنية', 'إغلاق الملفات المفتوحة', 'مراجعة ما تم إنجازه اليوم', 'ترتيب البريد والرسائل المهمة', 'متابعة العملاء', 'متابعة الموظفين', 'مراجعة المهام المفوضة', 'إنهاء قرار مؤجل', 'حل مشكلة تشغيلية', 'مراجعة التقارير', 'تحسين عملية واحدة', 'تعلم شيء جديد في الإدارة', 'تخصيص وقت للتخطيط الاستراتيجي', 'إنجاز مهمة تحتاج تركيزًا عميقًا'],
  health: ['تمرين حديد', 'المشي', 'المشي 30 دقيقة', 'السباحة', 'تمارين إطالة', 'تمارين مرونة', 'شرب ماء كافٍ', 'وجبة صحية ومتوازنة', 'تناول كمية كافية من البروتين', 'تناول الخضار والفواكه', 'تقليل السكر', 'تقليل الأكل العشوائي', 'الابتعاد عن الوجبات السريعة', 'النوم مبكرًا', 'الحصول على نوم كافٍ', 'قيلولة قصيرة عند الحاجة', 'التعرض لضوء الشمس صباحًا', 'جلسة استشفاء', 'ساونا', 'جاكوزي', 'مراجعة عادتي الصحية اليوم', 'المشي بعد الوجبة', 'تقليل المشروبات السكرية', 'الابتعاد عن الأكل قبل النوم', 'تجهيز وجبات صحية', 'مراجعة كمية الماء', 'يوم بدون أكل عشوائي', 'تمارين تنفس', 'راحة واستشفاء العضلات', 'تجهيز ملابس التمرين', 'تحديد تمرين الغد', 'الالتزام بموعد النوم'],
  relationships: ['الاتصال بأحد أفراد الأسرة', 'الجلوس مع العائلة', 'زيارة قريب', 'السؤال عن شخص غائب', 'إرسال رسالة لشخص أحبه', 'قضاء وقت نوعي مع شخص مهم', 'الاستماع لشخص بدون مقاطعة', 'التعبير عن التقدير', 'شكر شخص', 'الاعتذار عند الخطأ', 'حل خلاف', 'مساعدة أحد', 'تقديم هدية بسيطة', 'صلة رحم', 'مشاركة شخص في نشاط', 'التعرف على شخص جديد', 'وقت بدون هاتف مع من أحب', 'مبادرة طيبة لشخص', 'السؤال عن الوالدين', 'قضاء وقت مع الزوج/الزوجة', 'قضاء وقت مع الأبناء', 'التواصل مع صديق قديم', 'دعوة شخص إلى لقاء', 'مساندة شخص يمر بظرف', 'مدح شخص بصدق', 'التعبير عن الحب والامتنان', 'الاستماع لمشكلة شخص', 'حل سوء فهم', 'صلة قريب لم أتواصل معه منذ فترة', 'مشاركة لحظة جميلة مع العائلة'],
};
/** المجال الموجود الذي يقابل مجال الحياة (بالاسم)، إن وُجد. */
export const areaFor = (key) => { const L = LIFE_AREAS.find((x) => x.key === key); return L ? areas().find((a) => L.match.test(a.name)) || null : null; };
export const missingLife = () => LIFE_AREAS.filter((L) => !areaFor(L.key));

export function librarySheet(I, openKey = 'deen') {
  const have = new Set(S().tasks.filter(isOpen).map((t) => t.title));
  return `<form class="rit lib" data-form="library">
    <div class="cap-h"><h2>${I('sparkle', 'd')}مكتبة المهام</h2><button class="ib" type="button" data-act="close" aria-label="إغلاق">${I('x')}</button></div>
    <p class="sub">${n(Object.values(LIBRARY).reduce((s, l) => s + l.length, 0))} مهمة صغيرة مجرَّبة لمجالات الحياة الخمسة. اختر القليل: مهمتان أو ثلاث لكل مجال تكفي.</p>
    ${LIFE_AREAS.map((L) => { const a = areaFor(L.key); return `<details class="lib-cat"${L.key === openKey ? ' open' : ''}><summary><i aria-hidden="true">${L.emoji}</i><b>${L.name}</b><small>${L.hint}${a ? ` · تُضاف إلى «${esc(a.name)}»` : ' · يُنشأ المجال عند الإضافة'}</small></summary>
      <div class="rit-list">${LIBRARY[L.key].map((s) => (have.has(s)
    ? `<label class="rit-pick off"><input type="checkbox" disabled /><span>${s}<small>موجودة</small></span></label>`
    : `<label class="rit-pick"><input type="checkbox" name="pick" value="${L.key}|${esc(s)}" /><span>${s}</span></label>`)).join('')}</div></details>`; }).join('')}
    <fieldset><legend>كيف تُضاف؟</legend>
      <div class="rit-chips">${[['today', 'لليوم فقط'], ['daily', 'كل يوم (روتين)'], ['none', 'بلا موعد']].map(([v, l], i) => `<label><input type="radio" name="mode" value="${v}"${i === 0 ? ' checked' : ''} /><span>${l}</span></label>`).join('')}</div></fieldset>
    <button class="btn primary big" type="submit">${I('plus')}أضف المختار</button>
  </form>`;
}

/* ───────── قطع شاشة اليوم ───────── */
export function todayExtras(I) {
  const imp = todayImprove();
  const res = weekResults();
  const impHtml = imp ? `<button class="rit-imp${imp.done ? ' done' : ''}" data-act="improve-toggle" data-k="${imp.from}" aria-pressed="${imp.done}"><span class="ck sm">${I('check')}</span><span><small>تحسين اليوم</small>${esc(imp.text)}</span></button>` : '';
  const resHtml = res.length ? `<section class="rit-res" aria-label="نتائج الأسبوع"><p class="lbl">${I('flag', 'd')}نتائج الأسبوع <span class="cnt">${n(res.filter((r) => r.done).length)} من ${n(res.length)}</span><a class="cnt" href="#/review">تعديل</a></p>
      ${res.map((r, i) => `<button class="rit-imp${r.done ? ' done' : ''}" data-act="result-toggle" data-id="${r.id}" aria-pressed="${!!r.done}"><span class="ck sm">${I('check')}</span><span><small>النتيجة ${n(i + 1)}</small>${esc(r.t)}</span></button>`).join('')}</section>` : '';
  const rd = ritualDue();
  const call = rd ? `<button class="rit-imp rit-call" data-act="rit-${rd}">${I(rd === 'start' ? 'sun' : 'moon', 'd')}<span><small>${rd === 'start' ? 'دقيقتان قبل أي شيء' : 'دقيقتان قبل أن تغلق'}</small>${rd === 'start' ? 'ابدأ يومك: فرّغ رأسك، اختر الأهم، وحدّد أول خطوة' : 'اختم يومك: قرار لما بقي، وتحسين واحد للغد'}</span></button>` : '';
  return call + impHtml + resHtml;
}
/** لوحة «نتائج الأسبوع» داخل المراجعة الأسبوعية (للأسبوع الحالي فقط). */
export function resultsPanel(I) {
  const res = weekResults();
  const sug = suggestedResults();
  return `<form class="panel reflect rit-results" data-form="results"><p class="lbl">${I('flag', 'd')}نتائج هذا الأسبوع الثلاث <span class="cnt">تظهر أعلى يومك</span></p>
    ${[0, 1, 2].map((i) => `<label><span>النتيجة ${n(i + 1)}${i === 0 ? ': ما الذي لو تحقق صار أسبوعك ناجحًا؟' : ''}</span><input class="in" name="r${i}" maxlength="160" value="${esc(res[i]?.t || sug[i] || '')}" placeholder="نتيجة قابلة للقياس، مثال: إرسال عرض العميل" autocomplete="off" /></label>`).join('')}
    ${sug.length ? '<p class="note">مقترحة من «أهم ثلاثة» في مراجعة الأسبوع الماضي. عدّلها ثم احفظ.</p>' : ''}
    <div class="row"><button class="btn primary" type="submit">حفظ النتائج</button></div></form>`;
}
