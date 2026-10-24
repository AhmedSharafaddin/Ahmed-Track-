// مكوّنات الاختيار: التاريخ والوقت والتذكير، واختيار الرمز (إيموجي).
// كل مكوّن يفتح في حوار خاص (نافذة منبثقة على الكمبيوتر، ولوحة سفلية على الجوال)،
// ويعيد النتيجة عبر onSave/onPick. لا يعتمد على بقية الواجهة إلا في الأيقونات.
//
// openDatePicker({
//   value: { date:'YYYY-MM-DD'|null, time:'HH:MM'|null, remind:null|0|15|60|'morning', intent:'' },
//   mode: 'datetime' | 'date',      // 'date' = تاريخ فقط (للأهداف والمتابعة)
//   title: 'الموعد',
//   loads: Map<date,{count,minutes}>, capacity: دقائق اليوم المتاحة,
//   onSave(value), allowClear: true
// })
// openEmojiPicker({ value, onPick(emoji|null) })

import { todayKey, keyAdd, dateKey, parseKey, addDays, esc, fmtTime, REMINDS, EMOJIS, relDay } from './utils.js';

const ic = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const MONTHS = new Intl.DateTimeFormat('ar-u-nu-latn', { month: 'long', year: 'numeric' });
const LONG = new Intl.DateTimeFormat('ar-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
const WEEKDAY = new Intl.DateTimeFormat('ar', { weekday: 'long' });
const WD = ['سبت', 'أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة']; // الأسبوع يبدأ السبت
const TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00', '20:00'];

let dlg;
function host() {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'dlg pkd';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  return dlg;
}

/* ═════════════ التاريخ والوقت ═════════════ */
export function openDatePicker(opts) {
  const o = { mode: 'datetime', title: 'الموعد', loads: new Map(), capacity: 360, allowClear: true, ...opts };
  const v = { date: null, time: null, remind: null, intent: '', ...(o.value || {}) };
  const st = {
    v,
    month: parseKey(v.date || todayKey()),
    custom: !!v.time && !TIMES.includes(v.time),
  };
  st.month.setDate(1);
  const d = host();

  const summary = () => {
    if (!st.v.date) return 'بلا موعد';
    const parts = [`${relDay(st.v.date)}${['اليوم', 'غدًا', 'أمس'].includes(relDay(st.v.date)) ? `، ${LONG.format(parseKey(st.v.date))}` : ''}`];
    if (st.v.time) parts.push(fmtTime(st.v.time));
    return parts.join(' — ');
  };

  function grid() {
    const first = new Date(st.month);
    const lead = (first.getDay() + 1) % 7; // كم يومًا قبل الأول حتى السبت
    const start = addDays(first, -lead);
    const t0 = todayKey();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const k = dateKey(day);
      const out = day.getMonth() !== st.month.getMonth();
      const ld = o.loads.get?.(k);
      let load = '';
      if (ld?.count) {
        const over = o.capacity && ld.minutes > o.capacity;
        const lvl = Math.min(3, ld.count >= 6 ? 3 : ld.count >= 3 ? 2 : 1);
        load = `<i class="ld l${lvl}${over ? ' over' : ''}" title="${ld.count} مهمة"></i>`;
      }
      cells.push(`<button type="button" class="pk-d${out ? ' out' : ''}${k === t0 ? ' now' : ''}${k === st.v.date ? ' sel' : ''}${k < t0 ? ' past' : ''}" data-d="${k}" role="gridcell" aria-selected="${k === st.v.date}" aria-label="${LONG.format(day)}${ld?.count ? `، ${ld.count} مهمة` : ''}" tabindex="${k === (st.v.date || t0) ? 0 : -1}"><span>${day.getDate()}</span>${load}</button>`);
    }
    return cells.join('');
  }

  function render(focusSel) {
    const t0 = todayKey();
    const after = keyAdd(t0, 2);
    const sat = (() => { let k = keyAdd(t0, 1); while (parseKey(k).getDay() !== 6) k = keyAdd(k, 1); return k; })();
    const quick = [['اليوم', t0, 'sun'], ['غدًا', keyAdd(t0, 1), 'sun'], [WEEKDAY.format(parseKey(after)), after, 'cal'], ['السبت القادم', sat, 'cal'], ['بعد أسبوع', keyAdd(t0, 7), 'cal']]
      .filter((x, i, a) => a.findIndex((y) => y[1] === x[1]) === i);
    const timeChips = [['', 'بلا وقت'], ...TIMES.map((t) => [t, fmtTime(t)])]
      .map(([t, l]) => `<button type="button" class="chip-b${!st.custom && (st.v.time || '') === t ? ' on' : ''}" data-time="${t}">${l}</button>`).join('');
    const [hh, mm] = (st.v.time || '09:00').split(':').map(Number);
    const pm = hh >= 12;
    const h12 = hh % 12 || 12;

    d.innerHTML = `<form method="dialog" class="pk" novalidate>
      <header class="pk-h">
        <div><p class="pk-t">${esc(o.title)}</p><p class="pk-sum" aria-live="polite">${esc(summary())}</p></div>
        <button type="button" class="ib" data-pk="close" aria-label="إغلاق">${ic('x')}</button>
      </header>
      <div class="pk-quick">${quick.map(([l, k]) => `<button type="button" class="qd${st.v.date === k ? ' on' : ''}" data-d="${k}"><b>${esc(l)}</b><small>${parseKey(k).getDate()} ${new Intl.DateTimeFormat('ar', { month: 'short' }).format(parseKey(k))}</small></button>`).join('')}</div>
      <div class="pk-cal">
        <div class="pk-mh">
          <button type="button" class="ib" data-pk="prev" aria-label="الشهر السابق">${ic('back')}</button>
          <b>${MONTHS.format(st.month)}</b>
          <button type="button" class="ib" data-pk="next" aria-label="الشهر التالي">${ic('fwd')}</button>
        </div>
        <div class="pk-wd" aria-hidden="true">${WD.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="pk-grid" role="grid" aria-label="${MONTHS.format(st.month)}">${grid()}</div>
        <p class="pk-legend"><i class="ld l1"></i>مهام في هذا اليوم <i class="ld l2 over"></i>يتجاوز طاقتك</p>
      </div>
      ${o.mode === 'datetime' ? `
      <section class="pk-sec">
        <p class="pk-l">${ic('clock')}الوقت</p>
        <div class="chips">${timeChips}<button type="button" class="chip-b${st.custom ? ' on' : ''}" data-pk="custom">وقت آخر</button></div>
        ${st.custom ? `<div class="pk-time">
          <div class="pk-hours" role="group" aria-label="الساعة">${[7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6].map((h) => `<button type="button" class="${h === h12 ? 'on' : ''}" data-h="${h}">${h}</button>`).join('')}</div>
          <div class="pk-row">
            <div class="seg" role="group" aria-label="الدقائق">${[0, 15, 30, 45].map((m) => `<button type="button" class="${m === mm ? 'on' : ''}" data-m="${m}">:${String(m).padStart(2, '0')}</button>`).join('')}</div>
            <div class="seg" role="group" aria-label="صباحًا أو مساءً"><button type="button" class="${!pm ? 'on' : ''}" data-ap="am">ص</button><button type="button" class="${pm ? 'on' : ''}" data-ap="pm">م</button></div>
          </div></div>` : ''}
      </section>
      <section class="pk-sec">
        <p class="pk-l">${ic('bell')}ذكّرني</p>
        <div class="chips"><button type="button" class="chip-b${st.v.remind == null ? ' on' : ''}" data-rem="">بلا تذكير</button>${Object.entries(REMINDS).map(([k, l]) => `<button type="button" class="chip-b${String(st.v.remind) === k ? ' on' : ''}" data-rem="${k}">${l}</button>`).join('')}</div>
        ${st.v.remind != null ? `<label class="pk-intent"><span>${ic('hand')}متى وأين ستبدأ بالضبط؟ <em>تقرؤها في التنبيه</em></span>
          <input id="pk-intent" maxlength="140" value="${esc(st.v.intent || '')}" placeholder="مثال: بعد اجتماع الصباح، على مكتبي، أفتح ملف الرواتب" /></label>` : ''}
      </section>` : ''}
      <footer class="pk-f">
        ${o.allowClear && st.v.date ? `<button type="button" class="btn ghost" data-pk="clear">${ic('trash')}إزالة الموعد</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-pk="close">إلغاء</button>
        <button type="submit" class="btn primary" data-pk="save">تم</button>
      </footer>
    </form>`;
    if (focusSel) (d.querySelector(focusSel) || d.querySelector('.pk-d[tabindex="0"]'))?.focus();
  }

  const setDate = (k) => {
    st.v.date = k;
    const m = parseKey(k);
    if (m.getMonth() !== st.month.getMonth() || m.getFullYear() !== st.month.getFullYear()) { st.month = m; st.month.setDate(1); }
  };
  const setTime = (h24, m) => { st.v.time = `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`; if (!st.v.date) setDate(todayKey()); };

  d.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || !d.contains(b)) return;
    const ds = b.dataset;
    const cur = st.v.time ? st.v.time.split(':').map(Number) : [9, 0];
    if (ds.pk === 'close') { d.close(); return; }
    if (ds.pk === 'save') { e.preventDefault(); save(); return; }
    if (ds.pk === 'clear') { d.close(); o.onSave?.({ date: null, time: null, remind: null, intent: st.v.intent || '' }); return; }
    if (ds.pk === 'prev' || ds.pk === 'next') { st.month.setMonth(st.month.getMonth() + (ds.pk === 'next' ? 1 : -1)); render(`[data-pk="${ds.pk}"]`); return; }
    if (ds.pk === 'custom') { st.custom = true; if (!st.v.time) setTime(9, 0); render('.pk-hours .on'); return; }
    if (ds.d) { setDate(ds.d); render(`.pk-grid [data-d="${ds.d}"]`); return; }
    if ('time' in ds) { st.custom = false; st.v.time = ds.time || null; if (st.v.time && !st.v.date) setDate(todayKey()); render(`[data-time="${ds.time}"]`); return; }
    if (ds.h) { const pm = cur[0] >= 12; let h = Number(ds.h) % 12; if (pm) h += 12; setTime(h, cur[1]); render(`[data-h="${ds.h}"]`); return; }
    if (ds.m) { setTime(cur[0], Number(ds.m)); render(`[data-m="${ds.m}"]`); return; }
    if (ds.ap) { let h = cur[0] % 12; if (ds.ap === 'pm') h += 12; setTime(h, cur[1]); render(`[data-ap="${ds.ap}"]`); return; }
    if ('rem' in ds) {
      st.v.intent = d.querySelector('#pk-intent')?.value ?? st.v.intent;
      st.v.remind = ds.rem === '' ? null : ds.rem === 'morning' ? 'morning' : Number(ds.rem);
      if (st.v.remind != null && !st.v.date) setDate(todayKey());
      render(st.v.remind != null ? '#pk-intent' : `[data-rem=""]`);
    }
  };

  // لوحة المفاتيح داخل الشبكة: الأسهم بحسب اتجاه القراءة (يمين = اليوم السابق)
  d.onkeydown = (e) => {
    const cell = e.target.closest?.('.pk-d');
    if (!cell) return;
    const step = { ArrowLeft: 1, ArrowRight: -1, ArrowDown: 7, ArrowUp: -7 }[e.key];
    if (step) { e.preventDefault(); const k = keyAdd(cell.dataset.d, step); setDate(k); render(`.pk-grid [data-d="${k}"]`); }
    if (e.key === 'Enter') { e.preventDefault(); setDate(cell.dataset.d); save(); }
  };
  d.onsubmit = (e) => { e.preventDefault(); save(); };

  function save() {
    st.v.intent = (d.querySelector('#pk-intent')?.value ?? st.v.intent ?? '').trim();
    d.close();
    o.onSave?.({ ...st.v, remind: st.v.date ? st.v.remind : null });
  }

  render();
  d.showModal();
  (d.querySelector('.pk-d.sel') || d.querySelector('.pk-quick .qd'))?.focus();
}

/* ═════════════ الرمز (إيموجي) ═════════════ */
export function openEmojiPicker({ value = '', title = 'اختر رمزًا', onPick }) {
  const d = host();
  d.innerHTML = `<form method="dialog" class="pk emopick">
    <header class="pk-h"><div><p class="pk-t">${esc(title)}</p><p class="pk-sum">الرمز يجعل المجال يُعرف بنظرة</p></div>
      <button type="button" class="ib" data-e="close" aria-label="إغلاق">${ic('x')}</button></header>
    <div class="emo-grid" role="listbox" aria-label="الرموز">${EMOJIS.map((e) => `<button type="button" role="option" aria-selected="${e === value}" class="${e === value ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>
    <label class="pk-intent"><span>أو الصق أي رمز من لوحة المفاتيح</span><input id="emo-in" maxlength="8" value="${esc(value && !EMOJIS.includes(value) ? value : '')}" placeholder="😀" /></label>
    <footer class="pk-f"><button type="button" class="btn ghost" data-e="none">بلا رمز</button><span class="spacer"></span><button type="submit" class="btn primary">تم</button></footer>
  </form>`;
  d.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.e === 'close') d.close();
    if (b.dataset.e === 'none') { d.close(); onPick?.(null); }
    if (b.dataset.emoji) { d.close(); onPick?.(b.dataset.emoji); }
  };
  d.onkeydown = null;
  d.onsubmit = (e) => {
    e.preventDefault();
    const v = d.querySelector('#emo-in').value.trim();
    d.close();
    if (v) onPick?.(typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(v)][0].segment : Array.from(v)[0]);
  };
  d.showModal();
  d.querySelector('.emo-grid .on, .emo-grid button')?.focus();
}
