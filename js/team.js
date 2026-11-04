// قسم «الفريق»: تقارير يومية للموظفين مربوطة بتوصيفهم الوظيفي، ومتابعة من المدير المباشر.
//
// منفصل تمامًا عن البيانات الشخصية (users/{uid}/…) حتى لا يرى أحد مهامك الخاصة.
// البيانات في Firestore:
//   org/main                    { ownerUid, ownerEmail, name }             المسؤول (أنت) — يُنشأ مرة واحدة
//   members/{email}             { email, name, title, role, managerEmail, managerName, jd:[{id,title,detail}], active }
//   reports/{email}__{date}     { email, date, managerEmail, items:[{id,text,jdId,mins}], note, status, submittedAt, review }
// الصلاحيات الفعلية في firestore.rules: الموظف يرى تقاريره فقط، المدير يرى فريقه، المسؤول يرى الجميع.
// الكتابة تمر عبر ذاكرة Firestore المحلية ⇒ تظهر فورًا وتُرسل حين يتوفر الاتصال.

import { store } from './store.js';
import { uid, todayKey, keyAdd, n, esc, fmtDate, relDay, isDateKey, fmtMin, now, initials, personColor, dateKey } from './utils.js';

const MINS = [15, 30, 60, 90, 120, 180, 240];
const ROLES = { employee: 'موظف', manager: 'مدير مباشر' };
const STATUS = { none: 'لم يُرفع', draft: 'مسودة', submitted: 'مرفوع', returned: 'مُعاد للتعديل' };
const MAX_ITEMS = 60;
const MAX_JD = 30;

export const team = {
  email: null, // بريد المستخدم الحالي (صغير الأحرف)
  org: undefined, // undefined = لم يصل بعد، null = غير مُعدّ
  me: undefined, // ملف الموظف الخاص بي، null إن لم أُضف
  members: new Map(),
  reports: new Map(),
  errors: {},
  edit: null, // بريد الموظف قيد التعديل في صفحة الموظفين
  onChange: () => {},
};

const low = (e) => (e || '').toString().trim().toLowerCase();
const rid = (email, date) => `${email}__${date}`;
const days = (end, count) => Array.from({ length: count }, (_, i) => keyAdd(end, -i));
const clean = (o) => JSON.parse(JSON.stringify(o));

export const isOwner = () => !!(team.org && store.user && team.org.ownerUid === store.user.uid);
/** موظف أو مدير (ليس المسؤول): يرى قسم الفريق فقط. */
export const restricted = () => !!team.me && !isOwner();
const directReports = () => [...team.members.values()].filter((m) => m.email !== team.email && m.managerEmail === team.email && m.active !== false);
const staffList = () => (isOwner() ? [...team.members.values()].filter((m) => m.email !== team.email && m.active !== false) : directReports())
  .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'ar'));
const canReview = (m) => !!m && m.email !== team.email && (isOwner() || m.managerEmail === team.email);
const memberOf = (email) => (email === team.email ? team.me : team.members.get(email));

/* ═════════════ المزامنة ═════════════ */
const subs = new Map(); // مفتاح ← دالة إلغاء
let wanted = new Set();

function listen(key, target, onSnap, fallback) {
  if (subs.has(key)) return;
  const { fs } = store.cloud;
  subs.set(key, fs.onSnapshot(target, (s) => { delete team.errors[key]; onSnap(s); team.onChange(); }, (e) => {
    console.warn('team', key, e.code || e);
    // استعلام يحتاج فهرسًا مركّبًا غير منشأ ⇒ نرجع لاستعلام أبسط ونرشّح التواريخ هنا
    if (fallback && e.code === 'failed-precondition') { subs.set(key, fs.onSnapshot(fallback, (s) => { onSnap(s); team.onChange(); }, () => {})); return; }
    team.errors[key] = e.code || 'error';
    team.onChange();
  }));
}
function drop(key) { const u = subs.get(key); if (u) { u(); subs.delete(key); } }
function dropAll() { for (const k of [...subs.keys()]) drop(k); }

const fsRefs = () => {
  const { fs, db } = store.cloud;
  return { fs, db, reports: fs.collection(db, 'reports'), members: fs.collection(db, 'members') };
};

/** يُستدعى مع كل تغيّر في حالة الدخول: يبدأ/يوقف الاستماع حسب الحساب الحالي. */
export function teamSync() {
  const email = store.mode === 'cloud' && store.cloud && store.user?.email ? low(store.user.email) : null;
  if (email === team.email) return;
  dropAll();
  Object.assign(team, { email, org: undefined, me: undefined, members: new Map(), reports: new Map(), errors: {}, edit: null });
  wanted = new Set();
  if (!email) { team.onChange(); return; }
  const { fs, db } = fsRefs();
  listen('org', fs.doc(db, 'org', 'main'), (s) => { team.org = s.exists() ? s.data() : null; membersScope(); });
  listen('me', fs.doc(db, 'members', email), (s) => { team.me = s.exists() ? s.data() : null; membersScope(); });
}

/** المسؤول يستمع لكل الموظفين، وغيره لمن يتبعونه مباشرة. */
function membersScope() {
  if (team.org === undefined || team.me === undefined) return;
  const { fs, members } = fsRefs();
  const scope = isOwner() ? 'mem:all' : 'mem:mine';
  drop(scope === 'mem:all' ? 'mem:mine' : 'mem:all');
  const q = isOwner() ? members : fs.query(members, fs.where('managerEmail', '==', team.email));
  listen(scope, q, (s) => {
    const m = new Map();
    s.docs.forEach((d) => m.set(d.id, d.data()));
    team.members = m;
  });
}

function onReports(s) {
  if (s.docChanges) {
    for (const ch of s.docChanges()) {
      if (ch.type === 'removed') team.reports.delete(ch.doc.id);
      else team.reports.set(ch.doc.id, ch.doc.data());
    }
  }
}
function onReportDoc(id) {
  return (s) => { if (s.exists()) team.reports.set(id, s.data()); else team.reports.delete(id); };
}

/**
 * الشاشات تعلن ما تحتاجه من تقارير (مفاتيح)، فنستمع لها ونلغي ما لم يعد مطلوبًا.
 * الاستعلامات مقيّدة بنفس شروط القواعد (البريد أو المدير) حتى يقبلها Firestore.
 */
function want(keys) {
  wanted = new Set(keys);
  queueMicrotask(() => {
    if (!store.cloud || !team.email) return;
    const { fs, db, reports } = fsRefs();
    for (const k of [...subs.keys()]) if (k.startsWith('r:') && !wanted.has(k)) drop(k);
    for (const k of wanted) {
      if (subs.has(k)) continue;
      const [, kind, a, b] = k.split('|');
      if (kind === 'doc') listen(k, fs.doc(db, 'reports', a), onReportDoc(a));
      else if (kind === 'hist') {
        // سجل موظف لآخر ١٤ يومًا
        const f = [fs.where('email', '==', a)];
        if (a !== team.email && !isOwner()) f.push(fs.where('managerEmail', '==', team.email));
        listen(k, fs.query(reports, ...f, fs.where('date', 'in', days(b, 14))), onReports, fs.query(reports, ...f));
      } else if (kind === 'day') {
        const f = [fs.where('date', '==', a)];
        if (!isOwner()) f.push(fs.where('managerEmail', '==', team.email));
        listen(k, fs.query(reports, ...f), onReports);
      }
    }
  });
}

/* ═════════════ الكتابة ═════════════ */
function write(path, data) {
  const { fs, db } = store.cloud;
  return fs.setDoc(fs.doc(db, ...path), clean({ ...data, updatedAt: now() }), { merge: true })
    .catch((e) => { console.error('team write', e); team.errors.write = e.code || 'error'; team.onChange(); });
}

function myReport(date) {
  const r = team.reports.get(rid(team.email, date));
  return r || { email: team.email, date, items: [], note: '', status: 'draft' };
}
const editable = (r) => !r.status || r.status === 'draft' || r.status === 'returned';

function saveMine(date, patch) {
  const r = myReport(date);
  if (!editable(r)) return false;
  const next = { ...r, ...patch, email: team.email, date, managerEmail: team.me?.managerEmail || '' };
  team.reports.set(rid(team.email, date), next); // عرض فوري
  write(['reports', rid(team.email, date)], { email: next.email, date, managerEmail: next.managerEmail, items: next.items || [], note: next.note || '', status: next.status || 'draft', ...(patch.submittedAt ? { submittedAt: patch.submittedAt } : {}) });
  return true;
}

/* ═════════════ العرض ═════════════ */
let H; // { I, vh }
const ic = (name, k = 'i') => H.I(name, k);
const stChip = (st) => `<span class="tm-st st-${st}">${STATUS[st]}</span>`;
const avatar = (m) => `<span class="tm-av" style="--c:${personColor(m.name || m.email)}" aria-hidden="true">${esc(initials(m.name || m.email))}</span>`;
const minsLabel = (items) => { const t = items.reduce((s, x) => s + (x.mins || 0), 0); return t ? ` · ${fmtMin(t)}` : ''; };
const encE = (e) => encodeURIComponent(e);

function dayNav(base, d) {
  const t = todayKey();
  const next = keyAdd(d, 1);
  return `<div class="tm-day" role="group" aria-label="اختيار اليوم">
    <a class="ib" href="${base}/${keyAdd(d, -1)}" aria-label="اليوم السابق">${ic('back')}</a>
    <b>${relDay(d)}<small>${fmtDate(d)}</small></b>
    ${next <= t ? `<a class="ib" href="${base}/${next}" aria-label="اليوم التالي">${ic('fwd')}</a>` : '<span class="ib off" aria-hidden="true"></span>'}
  </div>`;
}

function strip(email, base, sel) {
  return `<ol class="tm-strip" aria-label="آخر ١٤ يومًا">${days(todayKey(), 14).map((k) => {
    const r = team.reports.get(rid(email, k));
    const st = r?.status || 'none';
    return `<li><a href="${base}/${k}" class="s-${st}"${k === sel ? ' aria-current="date"' : ''} title="${fmtDate(k)}: ${STATUS[st]}"><span>${n(Number(k.slice(8)))}</span></a></li>`;
  }).join('')}</ol>`;
}

/** كم مرة عُمل على كل بند من التوصيف خلال الفترة — يكشف ما أُهمل. */
function coverage(email, jd, span) {
  const from = keyAdd(todayKey(), -(span - 1));
  const cnt = {};
  for (const r of team.reports.values()) {
    if (r.email !== email || r.date < from || r.status === 'draft' && email !== team.email) continue;
    for (const it of r.items || []) cnt[it.jdId || ''] = (cnt[it.jdId || ''] || 0) + 1;
  }
  return cnt;
}

function jdPanel(m, span, editableJd) {
  const jd = m.jd || [];
  const cnt = coverage(m.email, jd, span);
  const title = m.email === team.email ? 'توصيفي الوظيفي' : 'التوصيف الوظيفي';
  const list = jd.length
    ? `<ul class="tm-jd">${jd.map((j) => `<li class="${cnt[j.id] ? '' : 'cold'}"><div><b>${esc(j.title)}</b>${j.detail ? `<p>${esc(j.detail)}</p>` : ''}</div><span class="tm-cnt" title="بنود آخر ${n(span)} أيام">${cnt[j.id] ? n(cnt[j.id]) : 'لم يُعمل عليه'}</span></li>`).join('')}
      ${cnt[''] ? `<li class="out"><div><b>خارج التوصيف</b></div><span class="tm-cnt">${n(cnt[''])}</span></li>` : ''}</ul>`
    : `<p class="note">لم يُوثَّق التوصيف الوظيفي بعد.${editableJd ? '' : ' يضيفه مديرك أو المسؤول.'}</p>`;
  const editor = editableJd ? `<details class="tm-jd-edit"${!jd.length ? ' open' : ''}><summary>${ic('note')}تعديل التوصيف</summary>${jdForm(m)}</details>` : '';
  return `<section class="panel tm-panel"><h2>${ic('doc')}${title}</h2><p class="note">الرقم = عدد البنود المنجزة في آخر ${n(span)} أيام.</p>${list}${editor}</section>`;
}

function jdRow(j = {}) {
  return `<div class="jd-row"><input type="hidden" name="jid" value="${esc(j.id || uid())}" />
    <input class="in" name="jt" value="${esc(j.title || '')}" maxlength="120" placeholder="عنوان المسؤولية" aria-label="عنوان المسؤولية" />
    <textarea class="in" name="jdt" rows="2" maxlength="600" placeholder="التفاصيل (اختياري)" aria-label="تفاصيل المسؤولية">${esc(j.detail || '')}</textarea>
    <button type="button" class="ib" data-act="jd-del" aria-label="حذف هذه المسؤولية">${ic('trash')}</button></div>`;
}
function jdForm(m) {
  return `<form class="tm-jdform" data-form="jd" data-email="${esc(m.email)}"><div class="jd-rows">${(m.jd || []).map(jdRow).join('') || jdRow()}</div>
    <div class="tm-actions"><button type="button" class="btn sm" data-act="jd-add">${ic('plus')}مسؤولية</button><button class="btn primary sm" type="submit">حفظ التوصيف</button></div></form>`;
}

function itemsList(r, jd, canEdit) {
  const items = r.items || [];
  if (!items.length) return `<div class="empty"><p>${canEdit ? 'لا بنود بعد. أضف ما أنجزته اليوم، بندًا بندًا.' : 'لا بنود في هذا اليوم.'}</p></div>`;
  const jdName = (id) => jd.find((j) => j.id === id)?.title;
  return `<ol class="tm-items">${items.map((it, i) => `<li><div class="tx">${esc(it.text)}</div><div class="meta">${it.jdId && jdName(it.jdId) ? `<span class="tm-tag">${esc(jdName(it.jdId))}</span>` : '<span class="tm-tag out">خارج التوصيف</span>'}${it.mins ? `<span>${ic('clock')}${fmtMin(it.mins)}</span>` : ''}</div>${canEdit ? `<button class="ib" data-act="tr-del" data-i="${i}" data-date="${esc(r.date)}" aria-label="حذف البند">${ic('trash')}</button>` : ''}</li>`).join('')}</ol>`;
}

function reviewNote(r, own) {
  if (!r.review?.comment && r.status !== 'returned') return '';
  const who = own ? 'ملاحظة مديرك' : 'ملاحظتك';
  return `<div class="tm-review ${r.status === 'returned' ? 'warn' : ''}"><b>${r.status === 'returned' ? (own ? 'أعاده مديرك للتعديل' : 'أُعيد للتعديل') : who}</b>${r.review?.comment ? `<p>${esc(r.review.comment)}</p>` : ''}</div>`;
}

/* ───── تقريري ───── */
function vMine(d) {
  const me = team.me;
  const r = myReport(d);
  const st = team.reports.has(rid(team.email, d)) ? r.status : 'none';
  const canEdit = editable(r) && d <= todayKey();
  const jd = me.jd || [];
  want([`r:|doc|${rid(team.email, d)}`, `r:|hist|${team.email}|${todayKey()}`]);
  const mgr = me.managerName || (me.managerEmail ? me.managerEmail : '');
  const items = r.items || [];
  const form = canEdit ? `<form class="tm-add" data-form="tr-add" data-date="${d}">
      <label class="sr-only" for="tr-text">ماذا أنجزت؟</label>
      <textarea id="tr-text" class="in sin" name="text" rows="1" maxlength="500" required placeholder="ماذا أنجزت؟ بند واحد في كل مرة"></textarea>
      <div class="tm-add-row">
        <select class="in" name="jd" aria-label="بند التوصيف"><option value="">خارج التوصيف</option>${jd.map((j) => `<option value="${esc(j.id)}">${esc(j.title)}</option>`).join('')}</select>
        <select class="in" name="mins" aria-label="المدة"><option value="">المدة</option>${MINS.map((m) => `<option value="${m}">${fmtMin(m)}</option>`).join('')}</select>
        <button class="btn primary sm" type="submit">${ic('plus')}أضف</button>
      </div></form>` : '';
  const note = canEdit
    ? `<label class="fld"><span>ملاحظة لمديرك (اختياري)</span><textarea class="in" data-tr-note data-date="${d}" rows="2" maxlength="1000" placeholder="عوائق، طلبات، أو ما يحتاج قرارًا">${esc(r.note || '')}</textarea></label>`
    : r.note ? `<div class="tm-note"><b>ملاحظتك</b><p>${esc(r.note)}</p></div>` : '';
  const sendLbl = mgr ? `رفع التقرير إلى ${esc(mgr)}` : 'رفع التقرير';
  const send = canEdit
    ? `<button class="btn primary tm-send" data-act="tr-submit" data-date="${d}"${items.length ? '' : ' disabled'}>${ic('check')}${sendLbl}</button>`
    : st === 'submitted' ? `<p class="note">${ic('check')}رُفع${r.submittedAt ? ` ${relDay(dateKey(new Date(r.submittedAt)))}` : ''}. لا يُعدَّل إلا إذا أعاده مديرك.</p>` : '';
  return `${H.vh('تقريري اليومي', `${n(items.length)} ${items.length === 1 ? 'بند' : 'بنود'}${minsLabel(items)}`, stChip(st))}
    ${dayNav('#/team/day', d)}
    ${strip(team.email, '#/team/day', d)}
    <div class="tm-grid">
      <section class="panel tm-panel tm-report">
        ${reviewNote(r, true)}
        ${itemsList(r, jd, canEdit)}
        ${form}
        ${note}
        ${send}
      </section>
      ${jdPanel(me, 7, false)}
    </div>`;
}

/* ───── فريقي ───── */
function vStaff(d) {
  const list = staffList();
  want([`r:|day|${d}`]);
  const rep = (m) => team.reports.get(rid(m.email, d));
  const sent = list.filter((m) => ['submitted', 'returned'].includes(rep(m)?.status)).length;
  const rows = list.map((m) => {
    const r = rep(m);
    const st = r ? (r.status === 'draft' ? 'draft' : r.status) : 'none';
    const items = r && r.status !== 'draft' ? r.items || [] : [];
    return `<a class="tm-row" href="#/team/m/${encE(m.email)}/${d}">${avatar(m)}<div class="who"><b>${esc(m.name || m.email)}</b><small>${esc(m.title || ROLES[m.role] || '')}${isOwner() && m.managerName ? ` · يتبع ${esc(m.managerName)}` : ''}</small></div>
      <span class="num">${items.length ? `${n(items.length)} ${items.length === 1 ? 'بند' : 'بنود'}${minsLabel(items)}` : ''}</span>${stChip(st)}</a>`;
  }).join('');
  const empty = isOwner()
    ? `<div class="empty"><p>لم تُضف موظفين بعد.</p><a class="btn primary sm" href="#/team/people">${ic('plus')}إضافة موظف</a></div>`
    : '<div class="empty"><p>لا أحد يتبعك مباشرة.</p></div>';
  return `${H.vh('فريقي', list.length ? `${n(sent)} من ${n(list.length)} رفعوا تقرير ${relDay(d)}` : '')}
    ${dayNav('#/team/staff', d)}
    <section class="panel tm-panel">${list.length ? `<div class="tm-rows">${rows}</div>` : empty}</section>
    <p class="note">المسودات لا تظهر لك حتى يرفعها الموظف.</p>`;
}

/* ───── صفحة موظف ───── */
function vMember(email, d) {
  const m = memberOf(email);
  if (!m) return `${H.vh('موظف')}<div class="empty"><p>لا تملك صلاحية عرض هذا الموظف، أو أنه غير موجود.</p></div>`;
  want([`r:|doc|${rid(email, d)}`, `r:|hist|${email}|${todayKey()}`]);
  const raw = team.reports.get(rid(email, d));
  const r = raw && raw.status !== 'draft' ? raw : null;
  const st = raw ? (raw.status === 'draft' ? 'draft' : raw.status) : 'none';
  const base = `#/team/m/${encE(email)}`;
  const reviewer = canReview(m);
  const review = r && reviewer ? `<form class="tm-revform" data-form="tr-review" data-id="${esc(rid(email, d))}">
      <label class="fld"><span>ملاحظتك للموظف</span><textarea class="in" name="comment" rows="2" maxlength="1000" placeholder="اعتماد، توجيه، أو ما يحتاج تعديلًا">${esc(r.review?.comment || '')}</textarea></label>
      <div class="tm-actions"><button class="btn primary sm" name="act" value="ok" type="submit">${ic('check')}حفظ الملاحظة</button>${r.status === 'submitted' ? `<button class="btn sm" name="act" value="return" type="submit">${ic('back')}إعادة للتعديل</button>` : ''}</div></form>` : '';
  const body = r
    ? `${reviewNote(r, false)}${itemsList(r, m.jd || [], false)}${r.note ? `<div class="tm-note"><b>ملاحظة الموظف</b><p>${esc(r.note)}</p></div>` : ''}${review}`
    : `<div class="empty"><p>${st === 'draft' ? 'يعمل على التقرير ولم يرفعه بعد.' : 'لم يُرفع تقرير لهذا اليوم.'}</p></div>`;
  const sub = [m.title, ROLES[m.role], m.managerName ? `يتبع ${m.managerName}` : ''].filter(Boolean).map(esc).join(' · ');
  return `${H.vh(esc(m.name || m.email), sub, stChip(st))}
    <a class="link tm-backl" href="#/team/staff/${d}">${ic('fwd')}فريقي</a>
    ${dayNav(base, d)}
    ${strip(email, base, d)}
    <div class="tm-grid">
      <section class="panel tm-panel tm-report">${body}</section>
      ${jdPanel(m, 14, reviewer)}
    </div>`;
}

/* ───── الموظفون (للمسؤول) ───── */
function vPeople() {
  if (team.org === null) {
    return `${H.vh('إعداد قسم الفريق')}
      <section class="panel tm-panel"><p>قسم الفريق غير مُعدّ بعد. من يفعّله يصبح <b>المسؤول</b>: يضيف الموظفين ويوثّق توصيفهم ويرى كل التقارير.</p>
      <form class="arow" data-form="org-claim"><input class="in" name="name" maxlength="80" required placeholder="اسم الجهة أو الإدارة" aria-label="اسم الجهة أو الإدارة" /><button class="btn primary sm" type="submit">تفعيل، وأنا المسؤول</button></form></section>`;
  }
  if (!isOwner()) return `${H.vh('الموظفون')}<div class="empty"><p>هذه الصفحة للمسؤول فقط.</p></div>`;
  const all = [...team.members.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'ar'));
  const e = team.edit ? team.members.get(team.edit) : null;
  const managers = all.filter((m) => m.role === 'manager' && m.active !== false && m.email !== e?.email);
  const ownerEmail = low(store.user.email);
  const mOpt = (v, l, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`;
  const sel = e ? e.managerEmail : ownerEmail;
  const form = `<form class="tm-mform" data-form="member">
      <h2>${e ? `${ic('user')}تعديل: ${esc(e.name || e.email)}` : `${ic('plus')}إضافة موظف`}</h2>
      <div class="tm-fields">
        <label class="fld"><span>البريد (نفس بريد دخوله)</span><input class="in" type="email" name="email" required maxlength="120" dir="ltr" value="${esc(e?.email || '')}"${e ? ' readonly' : ''} /></label>
        <label class="fld"><span>الاسم</span><input class="in" name="name" required maxlength="60" value="${esc(e?.name || '')}" /></label>
        <label class="fld"><span>المسمّى الوظيفي</span><input class="in" name="title" maxlength="80" value="${esc(e?.title || '')}" /></label>
        <label class="fld"><span>الدور</span><select class="in" name="role">${Object.entries(ROLES).map(([k, l]) => mOpt(k, l, e?.role || 'employee')).join('')}</select></label>
        <label class="fld"><span>المدير المباشر</span><select class="in" name="manager">${mOpt(ownerEmail, 'أنت (المسؤول)', sel)}${managers.map((m) => mOpt(m.email, m.name || m.email, sel)).join('')}</select></label>
        ${e ? `<label class="chk"><input type="checkbox" name="active"${e.active !== false ? ' checked' : ''} /><span>نشط (غير النشط لا يظهر في المتابعة)</span></label>` : ''}
      </div>
      <div class="tm-actions"><button class="btn primary sm" type="submit">${e ? 'حفظ' : 'إضافة'}</button>${e ? '<button type="button" class="btn sm" data-act="tm-cancel">إلغاء</button>' : ''}</div>
    </form>`;
  const rows = all.map((m) => `<div class="tm-row${m.active === false ? ' off' : ''}">${avatar(m)}<div class="who"><b>${esc(m.name || m.email)}</b><small dir="auto">${esc([m.title, ROLES[m.role], m.managerName ? `يتبع ${m.managerName}` : ''].filter(Boolean).join(' · '))}</small></div>
      <span class="num">${n((m.jd || []).length)} مسؤوليات${m.active === false ? ' · غير نشط' : ''}</span>
      <a class="btn sm" href="#/team/m/${encE(m.email)}">التوصيف والتقارير</a><button class="btn sm" data-act="tm-edit" data-email="${esc(m.email)}">تعديل</button></div>`).join('');
  return `${H.vh('الموظفون والتوصيف', team.org.name ? esc(team.org.name) : '')}
    <div class="tm-grid">
      <section class="panel tm-panel">${all.length ? `<div class="tm-rows">${rows}</div>` : '<div class="empty"><p>لا موظفين بعد. أضف أول موظف من النموذج.</p></div>'}</section>
      <section class="panel tm-panel">${form}
        <details class="tm-help"><summary>كيف يدخل الموظف؟</summary><ol>
          <li>في Firebase Console ← Authentication ← Users ← <b>Add user</b>: بريده وكلمة مرور مؤقتة.</li>
          <li>أضفه هنا بنفس البريد، وحدّد مديره المباشر.</li>
          <li>يفتح التطبيق ← الإعدادات ← دخول، ثم «نسيت كلمة المرور» ليضع كلمته الخاصة.</li>
          <li>يرى قسم الفريق فقط، لا مهامك الشخصية.</li></ol></details>
      </section>
    </div>`;
}

function vNeedAccount() {
  if (!store.syncConfigured || store.mode !== 'cloud') {
    return `${H.vh('الفريق')}<div class="empty"><p>قسم الفريق يحتاج تسجيل الدخول بحسابك.</p><a class="btn primary sm" href="#/settings">الإعدادات ← دخول</a></div>`;
  }
  return null;
}

export function vTeam({ I, vh, ui }) {
  H = { I, vh };
  const gate = vNeedAccount();
  if (gate) return tabs('') + gate;
  if (team.org === undefined || team.me === undefined) return `${tabs('')}${vh('الفريق')}<div class="skel"><i class="s1"></i><i class="s3"></i><i class="s3"></i></div>`;
  const [sect, a, b] = (ui.param || '').split('/');
  const date = (k) => (isDateKey(k) && k <= todayKey() ? k : todayKey());
  let html;
  let cur = sect || 'day';
  if (sect === 'people') html = vPeople();
  else if (sect === 'staff') html = vStaff(date(a));
  else if (sect === 'm' && a) { html = vMember(low(decodeURIComponent(a)), date(b)); cur = 'staff'; }
  else if (team.me) html = vMine(date(a));
  else if (team.org === null || isOwner()) { html = team.org === null ? vPeople() : vStaff(todayKey()); cur = team.org === null ? 'people' : 'staff'; }
  else html = `${vh('الفريق')}<div class="empty"><p>حسابك (<span dir="ltr">${esc(team.email)}</span>) غير مضاف إلى الفريق بعد.</p><p class="note">اطلب من المسؤول إضافة بريدك.</p></div>`;
  const err = team.errors.write ? '<p class="warn" role="alert">تعذّر الحفظ: تحقق من الصلاحيات أو الاتصال.</p>' : '';
  return tabs(cur) + err + html;
}

/** شريط أقسام الفريق داخل الشاشة (على الجوال بديل الشريط السفلي). */
function tabs(cur) {
  const it = teamLinks();
  if (!it.length) return '';
  return `<nav class="tm-tabs" aria-label="أقسام الفريق">${it.map(([k, href, label]) => `<a href="${href}"${k === cur ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

function teamLinks() {
  const out = [];
  if (!restricted()) out.push(['me', '#/today', 'شخصي']);
  if (team.me) out.push(['day', '#/team', 'تقريري']);
  if (isOwner() || directReports().length) out.push(['staff', '#/team/staff', 'فريقي']);
  if (isOwner() || team.org === null) out.push(['people', '#/team/people', 'الموظفون']);
  return out;
}

/** عناصر الشريط الجانبي عند الوجود في قسم الفريق. */
export function teamNav(icon) {
  const d = todayKey();
  const out = [];
  if (team.me) {
    const r = team.reports.get(rid(team.email, d));
    out.push(`<a href="#/team" class="ni" data-nav="#/team">${icon('note', 'd')}<span>تقريري اليومي</span>${r?.status === 'submitted' ? '<em>✓</em>' : ''}</a>`);
  }
  if (isOwner() || directReports().length) out.push(`<a href="#/team/staff" class="ni" data-nav="#/team/staff">${icon('people', 'd')}<span>فريقي</span></a>`);
  if (isOwner() || team.org === null) out.push(`<a href="#/team/people" class="ni" data-nav="#/team/people">${icon('gear', 'd')}<span>الموظفون والتوصيف</span></a>`);
  return out.join('');
}

/** مبدّل القسمين أعلى الشريط الجانبي. */
export function spaceSwitch(inTeam) {
  if (!store.syncConfigured) return '';
  if (restricted()) return '<div class="space-sw one"><span aria-current="page">الفريق</span></div>';
  return `<div class="space-sw" role="group" aria-label="القسم"><a href="#/today"${inTeam ? '' : ' aria-current="page"'}>شخصي</a><a href="#/team"${inTeam ? ' aria-current="page"' : ''}>الفريق</a></div>`;
}

/* ═════════════ الأحداث ═════════════ */
export function teamClick(act, el, { toast, render }) {
  switch (act) {
    case 'tr-del': {
      const r = myReport(el.dataset.date);
      saveMine(el.dataset.date, { items: (r.items || []).filter((_, i) => i !== +el.dataset.i) });
      return true;
    }
    case 'tr-submit': {
      const d = el.dataset.date;
      const r = myReport(d);
      if (!(r.items || []).length) return true;
      if (saveMine(d, { status: 'submitted', submittedAt: now() })) toast(team.me?.managerName ? `رُفع التقرير إلى ${team.me.managerName}.` : 'رُفع التقرير.');
      return true;
    }
    case 'jd-add': {
      const f = el.closest('form');
      if (f.querySelectorAll('.jd-row').length < MAX_JD) { f.querySelector('.jd-rows').insertAdjacentHTML('beforeend', jdRow()); f.querySelector('.jd-row:last-child [name=jt]').focus(); }
      return true;
    }
    case 'jd-del': el.closest('.jd-row').remove(); return true;
    case 'tm-edit': team.edit = el.dataset.email; render(true); window.scrollTo({ top: 0 }); return true;
    case 'tm-cancel': team.edit = null; render(true); return true;
    default: return false;
  }
}

export function teamSubmit(kind, form, fd, submitter, { toast, render }) {
  const get = (k) => (fd.get(k) || '').toString().trim();
  switch (kind) {
    case 'tr-add': {
      const d = form.dataset.date;
      const text = get('text');
      const r = myReport(d);
      if (!text) return true;
      if ((r.items || []).length >= MAX_ITEMS) { toast(`الحد ${n(MAX_ITEMS)} بندًا لليوم.`); return true; }
      const mins = Number(get('mins')) || null;
      saveMine(d, { items: [...(r.items || []), { id: uid(), text: text.slice(0, 500), jdId: get('jd') || null, mins }] });
      form.reset();
      setTimeout(() => document.getElementById('tr-text')?.focus(), 30);
      return true;
    }
    case 'tr-review': {
      const id = form.dataset.id;
      const r = team.reports.get(id);
      if (!r) return true;
      const ret = submitter?.value === 'return';
      const review = { by: team.email, comment: get('comment').slice(0, 1000), at: now() };
      team.reports.set(id, { ...r, review, status: ret ? 'returned' : r.status });
      write(['reports', id], { review, status: ret ? 'returned' : r.status });
      toast(ret ? 'أُعيد التقرير للموظف للتعديل.' : 'حُفظت ملاحظتك.');
      render(true);
      return true;
    }
    case 'jd': {
      const email = form.dataset.email;
      const ids = fd.getAll('jid'); const ts = fd.getAll('jt'); const ds = fd.getAll('jdt');
      const jd = ids.map((id, i) => ({ id: String(id).slice(0, 40), title: String(ts[i] || '').trim().slice(0, 120), detail: String(ds[i] || '').trim().slice(0, 600) })).filter((j) => j.title).slice(0, MAX_JD);
      const m = memberOf(email);
      if (m) team.members.set(email, { ...m, jd });
      write(['members', email], { jd });
      toast('حُفظ التوصيف.');
      render(true);
      return true;
    }
    case 'member': {
      const email = low(get('email'));
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('البريد غير صحيح.'); return true; }
      const prev = team.members.get(email);
      if (!team.edit && prev) { toast('هذا البريد مضاف مسبقًا. استخدم «تعديل».'); return true; }
      const managerEmail = low(get('manager'));
      const ownerEmail = low(store.user.email);
      const mgr = team.members.get(managerEmail);
      const data = {
        email, name: get('name').slice(0, 60), title: get('title').slice(0, 80),
        role: ROLES[get('role')] ? get('role') : 'employee',
        managerEmail: managerEmail === email ? ownerEmail : managerEmail,
        managerName: managerEmail === ownerEmail || managerEmail === email ? 'المسؤول' : (mgr?.name || managerEmail),
        active: team.edit ? fd.get('active') === 'on' : true,
        ...(prev ? {} : { jd: [], createdAt: now() }),
      };
      team.members.set(email, { ...(prev || {}), ...data });
      write(['members', email], data);
      team.edit = null;
      toast(prev ? 'حُفظ.' : 'أُضيف. وثّق توصيفه من «التوصيف والتقارير».');
      render(true);
      return true;
    }
    case 'org-claim': {
      const name = get('name').slice(0, 80);
      const { fs, db } = store.cloud;
      fs.setDoc(fs.doc(db, 'org', 'main'), { ownerUid: store.user.uid, ownerEmail: low(store.user.email), name, createdAt: now() })
        .then(() => toast('فُعّل قسم الفريق. أضف موظفيك الآن.'))
        .catch(() => toast('تعذّر التفعيل: قد يكون مُفعّلًا من حساب آخر.'));
      return true;
    }
    default: return false;
  }
}

/** حفظ الملاحظة عند مغادرة الحقل. */
export function teamChange(el) {
  if (el.matches('[data-tr-note]')) { saveMine(el.dataset.date, { note: el.value.slice(0, 1000) }); return true; }
  return false;
}
