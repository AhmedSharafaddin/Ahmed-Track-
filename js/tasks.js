// شاشة «كل المهام»: جدول على اللابتوب وقائمة على الجوال، مع فلاتر ثابتة.
// مصدر واحد للمهام: تغيير الفلتر يغيّر العرض فقط ولا ينسخ شيئًا.

import { n, esc, todayKey, quadrant, fmtDate, fmtTime, daysBetween } from './utils.js';
import { S, areas, areaById, isOpen, isOverdue, isWaiting, byPriority, hasArea } from './model.js';

export const STATUS_FILTERS = {
  open: 'كل المفتوحة', late: 'المتأخرة', waiting: 'بانتظار الاعتماد', done: 'المنجزة', all: 'الكل',
};
const PRI = { q1: 'عالية', q2: 'مهمة', q3: 'متوسطة', q4: 'عادية' };
const LIMIT = 300;

function statusCell(t) {
  if (!isOpen(t)) return '<span class="st done">منجزة</span>';
  if (isWaiting(t)) return '<span class="st wait">بانتظار الاعتماد</span>';
  if (isOverdue(t)) {
    const k = Math.max(1, daysBetween(t.due, todayKey()));
    return `<span class="st late">متأخرة ${k === 1 ? 'يومًا' : k === 2 ? 'يومين' : `${n(k)} ${k <= 10 ? 'أيام' : 'يومًا'}`}</span>`;
  }
  return '<span class="st">مفتوحة</span>';
}

/** @param {{I:Function, row:Function, vh:Function, ui:object}} h */
export function vAll(h) {
  const { I, row, vh, ui } = h;
  const tf = ui.tf || (ui.tf = { q: '', area: '', pri: '' });
  const st = STATUS_FILTERS[ui.param] ? ui.param : 'open';
  const q = tf.q.trim().toLowerCase();

  let list = S().tasks.filter((t) => {
    if (st === 'open' && !isOpen(t)) return false;
    if (st === 'late' && !isOverdue(t)) return false;
    if (st === 'waiting' && !(isOpen(t) && isWaiting(t))) return false;
    if (st === 'done' && isOpen(t)) return false;
    if (tf.area === '_none' ? hasArea(t) : tf.area && t.areaId !== tf.area) return false;
    if (tf.pri && quadrant(t) !== tf.pri) return false;
    if (q && !`${t.title} ${t.notes || ''} ${t.assignee || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  list = st === 'done'
    ? list.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
    : list.sort((a, b) => (isOpen(b) - isOpen(a)) || byPriority(a, b));
  const total = list.length;
  list = list.slice(0, LIMIT);

  const sel = (key, val, opts) => `<select class="in sm" data-tf="${key}" aria-label="${opts.label}">${opts.items.map(([v, l]) => `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const filters = `<div class="tfilters" role="search">
    <label class="tf-q">${I('search')}<input type="search" id="tf-q" data-tf="q" value="${esc(tf.q)}" placeholder="بحث في المهام…" aria-label="بحث في المهام" /></label>
    ${sel('area', tf.area, { label: 'المجال', items: [['', 'كل المجالات'], ...areas().map((a) => [a.id, a.name]), ['_none', 'بلا مجال (الوارد)']] })}
    ${sel('status', st, { label: 'الحالة', items: Object.entries(STATUS_FILTERS) })}
    ${sel('pri', tf.pri, { label: 'الأولوية', items: [['', 'كل الأولويات'], ...Object.entries(PRI)] })}
  </div>`;

  const body = list.map((t) => {
    const a = hasArea(t) ? areaById(t.areaId) : null;
    const q4 = quadrant(t);
    return `<tr class="${isOpen(t) ? '' : 'done'}${ui.sel === t.id ? ' sel' : ''}" data-id="${t.id}">
      <td class="c-ck"><button class="ck" data-act="toggle" data-id="${t.id}" aria-label="${isOpen(t) ? 'إنجاز' : 'إلغاء الإنجاز'}: ${esc(t.title)}">${I('check')}</button></td>
      <th scope="row" class="c-t"><button class="tm" data-act="open" data-id="${t.id}"><span class="tt">${esc(t.title)}</span></button></th>
      <td>${a ? `<span class="m">${a.emoji ? `<span class="em">${esc(a.emoji)}</span>` : `<i class="dot" style="--c:${esc(a.color)}"></i>`}${esc(a.name)}</span>` : '<span class="faint">—</span>'}</td>
      <td><span class="pri p-${q4}">${PRI[q4]}</span></td>
      <td>${statusCell(t)}</td>
      <td class="num">${t.due ? `${fmtDate(t.due)}${t.time ? ` ${fmtTime(t.time)}` : ''}` : '<span class="faint">—</span>'}</td>
      <td>${t.assignee ? esc(t.assignee) : '<span class="faint">أنا</span>'}</td>
      <td class="c-a"><button class="btn sm" data-act="open" data-id="${t.id}">فتح</button></td>
    </tr>`;
  }).join('');

  const table = `<div class="only-d tcard"><table class="ttable">
    <thead><tr><th class="c-ck"><span class="sr">إنجاز</span></th><th>المهمة</th><th>المجال</th><th>الأولوية</th><th>الحالة</th><th>الاستحقاق</th><th>المسؤول</th><th class="c-a"><span class="sr">إجراء</span></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
  const cards = `<ul class="tl only-m">${list.map((t) => row(t, { follow: true })).join('')}</ul>`;
  const empty = `<div class="empty">${I('list', 'd', 'big')}<p>${q || tf.area || tf.pri || st !== 'open' ? 'لا مهام تطابق هذه الفلاتر.' : 'لا مهام مفتوحة.'}</p></div>`;

  return `${vh('كل المهام', `مصدر واحد للمهام. غيّر العرض بالفلاتر دون نسخ. ${n(total)} ${total === 1 ? 'مهمة' : 'مهمة'}${total > LIMIT ? ` (يُعرض أول ${n(LIMIT)})` : ''}`)}
  ${filters}
  ${total ? `${table}${cards}` : empty}`;
}
