// ITrack — الواجهة: الدخول، تقريري اليومي، لوحة الفريق، صفحة الموظف، الهيكل والموظفون، السجل، الإعدادات.
// كل ما يظهر هنا يأتي من الخادم بعد تطبيق الصلاحيات؛ الواجهة لا تقرر من يرى ماذا.
import { initAuth, signIn, signUp, redeemCode, changePassword, signOut, serverInfo, api } from './core.js';

/* ═════════════ أدوات ═════════════ */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I = (n, k = 'i') => `<svg class="ic" aria-hidden="true"><use href="#${k}-${n}"/></svg>`;
const pad = (x) => String(x).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => keyOf(new Date());
const addD = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
const isDay = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '');
const L = 'ar-u-nu-latn';
const fLong = new Intl.DateTimeFormat(L, { weekday: 'long', day: 'numeric', month: 'long' });
const fShort = new Intl.DateTimeFormat(L, { weekday: 'short', day: 'numeric', month: 'short' });
const fWd = new Intl.DateTimeFormat(L, { weekday: 'short' });
const fTime = new Intl.DateTimeFormat(L, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const num = new Intl.NumberFormat(L);
const n = (x) => num.format(x || 0);
const rel = (k) => (k === today() ? 'اليوم' : k === addD(today(), -1) ? 'أمس' : fShort.format(parse(k)));
const mins = (m) => { if (!m) return ''; const h = Math.floor(m / 60); const r = m % 60; return h ? `${n(h)} س${r ? ` ${n(r)} د` : ''}` : `${n(r)} د`; };
const initials = (s = '') => s.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
const COLORS = ['#2f7d6d', '#7a4f9a', '#9a6a1f', '#1f6f99', '#a24d3f', '#4f5fa8', '#5d7a2c', '#a03f74'];
const color = (s = '') => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const avatar = (name) => `<span class="av" style="background:${color(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
const MINS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];
const STATUS = { none: 'لم يُرفع', draft: 'مسودة', submitted: 'مرفوع', approved: 'معتمد', returned: 'مُعاد للتعديل' };
const STATE = { done: 'أُنجز', progress: 'جارٍ', blocked: 'متعثّر' };
const ROLE = { admin: 'مسؤول الجهة', manager: 'مدير', employee: 'موظف' };
const ACTION = {
  'org.create': 'أنشأ الجهة', 'member.invite': 'دعا عضوًا', 'member.join': 'انضم إلى الجهة', 'member.update': 'عدّل بيانات عضو',
  'department.create': 'أضاف إدارة', 'department.update': 'عدّل إدارة', 'position.create': 'أضاف وظيفة', 'position.update': 'عدّل توصيف وظيفة',
  'report.create': 'بدأ التقرير', 'report.submit': 'رفع التقرير', 'report.resubmit': 'أعاد رفع التقرير بعد التعديل',
  'report.approve': 'اعتمد التقرير', 'report.return': 'أعاد التقرير للتعديل', 'report.comment': 'أضاف ملاحظة',
};
const chip = (st) => `<span class="st st-${st}">${STATUS[st] || st}</span>`;
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };

/* ═════════════ الحالة ═════════════ */
const S = {
  user: undefined, me: null, org: store.get('it:org'), boot: null, err: null,
  cache: new Map(), loading: new Set(),
  draft: {}, dirty: {}, saveState: {}, // تقريري قيد التحرير لكل يوم
  f: { dep: '', st: '' }, edit: { member: null, pos: null, dep: null }, authTab: 'in',
  codes: {}, // رموز الدعوة/إعادة التعيين الصادرة في هذه الجلسة (تُعرض مرة واحدة)
  info: {}, // قدرات الخادم
};
// رابط الدعوة ‎#/code/XXXX-XXXX-XXXX‎: يفتح «عندي رمز» معبّأً
const codeFromHash = () => { const m = location.hash.match(/^#\/code\/([A-Za-z0-9-]{12,16})/); return m ? m[1].toUpperCase() : ''; };
if (codeFromHash()) { S.authTab = 'code'; S.prefCode = codeFromHash(); }
serverInfo().then((i) => { S.info = i || {}; render(); });
const view = $('#view');

/** تحميل بيانات مرة واحدة ثم إعادة الرسم. الشاشات تطلب ما تحتاجه فقط. */
function need(key, loader) {
  if (S.cache.has(key)) return S.cache.get(key);
  if (!S.loading.has(key)) {
    S.loading.add(key);
    loader().then((d) => S.cache.set(key, d), (e) => S.cache.set(key, { error: e.message, code: e.code }))
      .finally(() => { S.loading.delete(key); render(); });
  }
  return undefined;
}
const drop = (...prefixes) => { for (const k of [...S.cache.keys()]) if (prefixes.some((p) => k.startsWith(p))) S.cache.delete(k); };
const call = (m, p, b) => api(m, p, b, S.org);
/** ما ينتظرني: تقارير لأراجعها، وتقاريري المُعادة للتعديل. يُحدَّث عند كل تنقّل. */
const inbox = () => (S.boot ? need('inbox', () => call('GET', `/api/inbox?today=${today()}`)) : undefined);
const reviewCount = () => { const x = S.cache.get('inbox'); return x && !x.error ? x.review.length : 0; };

const members = () => S.boot?.members || [];
const memberById = (id) => members().find((m) => m.id === id);
const posById = (id) => S.boot?.positions.find((p) => p.id === id);
const depById = (id) => S.boot?.departments.find((d) => d.id === id);
const myRole = () => S.boot?.me.role;
const isAdmin = () => myRole() === 'admin';
const hasTeam = () => isAdmin() || (S.boot?.me.subs || []).length > 0;
const teamList = () => members().filter((m) => m.id !== S.boot.me.id && m.email !== undefined && m.status !== 'disabled' && (isAdmin() || S.boot.me.subs.includes(m.id)));

/* ═════════════ التنقل ═════════════ */
function route() {
  const [name = '', a = '', b = ''] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { name, a, b };
}
function home() { return hasTeam() ? '#/team' : '#/day'; }
// الصندوق يُحدَّث عند العودة للتبويب أو بعد ٣٠ ثانية، لا عند كل تنقّل (يوفّر ٦ استعلامات لكل شاشة)
let inboxAt = 0;
const freshInbox = () => { if (Date.now() - inboxAt > 30000) { drop('inbox'); inboxAt = Date.now(); } };
// الهيكل يُعاد تحميله عند فتحه (من انضم أو تغيّرت حالته منذ آخر تحميل)
let bootAt = Date.now();
const freshBoot = () => { if (S.boot && route().name === 'org' && Date.now() - bootAt > 5000) { bootAt = Date.now(); loadBoot(true); } };
window.addEventListener('hashchange', () => { freshInbox(); freshBoot(); render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.boot) { drop('inbox', 'day|'); inboxAt = Date.now(); render(); } });

/* ═════════════ الرسم ═════════════ */
let painting = false;
function render() {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => { painting = false; paint(); });
}
function paint() {
  const html = screen();
  const shell = document.body.dataset.mode;
  // حفظ موضع الكتابة قبل الاستبدال
  const a = document.activeElement;
  const key = a?.dataset?.k;
  let sel = null;
  try { if (key && a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch {}
  if (view.dataset.html !== html) { view.innerHTML = html; view.dataset.html = html; }
  if (key) { const el = view.querySelector(`[data-k="${CSS.escape(key)}"]`); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch {} } }
  view.querySelectorAll('textarea.auto').forEach(autosize);
  paintNav(shell);
}
function autosize(el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; }

function paintNav() {
  const inApp = !!S.boot;
  document.body.dataset.mode = inApp ? 'app' : 'gate';
  $('.side').hidden = !inApp; $('.tabbar').hidden = !inApp;
  if (!inApp) return;
  const r = route().name || 'day';
  const items = [
    ['day', '#/day', 'today', 'يومي'],
    ['my', 'my/', 'note', 'مهامي'], // مساحتي الشخصية (واجهة مركز القيادة داخل ITrack)
    hasTeam() && ['team', '#/team', 'people', 'الفريق'],
    isAdmin() && ['org', '#/org', 'doc', 'الهيكل'],
    isAdmin() && ['audit', '#/audit', 'list', 'السجل'],
    ['settings', '#/settings', 'gear', 'الإعدادات'],
  ].filter(Boolean);
  const cur = (k) => (k === r || (k === 'team' && r === 'm') ? ' aria-current="page"' : '');
  const rc = hasTeam() ? reviewCount() : 0;
  const badge = (k) => (k === 'team' && rc ? `<em aria-label="${n(rc)} بانتظار مراجعتك">${n(rc)}</em>` : '');
  const nav = items.map(([k, h, ic, l]) => `<a href="${h}"${cur(k)}>${I(ic, ['day', 'team', 'settings'].includes(k) ? 'd' : 'i')}<span>${l}</span>${badge(k)}</a>`).join('');
  const navEl = $('#nav'); if (navEl.innerHTML !== nav) navEl.innerHTML = nav;
  const tb = $('.tabbar'); if (tb.innerHTML !== nav) tb.innerHTML = nav;
  const org = `<b>${esc(S.boot.org.name)}</b><span>${esc(S.boot.me.name)} · ${ROLE[myRole()]}</span>`;
  const oc = $('#org-chip'); if (oc.innerHTML !== org) oc.innerHTML = org;
  const ft = $('#who'); if (ft.textContent !== S.me?.email) ft.textContent = S.me?.email || '';
}

function screen() {
  if (S.user === undefined) return skel();
  if (!S.user) return vAuth();
  if (S.err) return vGateError();
  if (!S.me) return skel();
  const joined = S.me.orgs.filter((o) => !o.invited);
  if (S.prefCode || !S.org || !joined.find((o) => o.id === S.org)) {
    if (!S.prefCode && joined.length === 1 && S.me.orgs.length === 1) { S.org = joined[0].id; store.set('it:org', S.org); loadBoot(); return skel(); }
    return vNoOrg();
  }
  if (!S.boot) return skel();
  const r = route();
  if (!r.name) { location.replace(home()); return skel(); }
  switch (r.name) {
    case 'day': return vDay(isDay(r.a) && r.a <= today() ? r.a : today());
    case 'team': return hasTeam() ? vTeam(isDay(r.a) && r.a <= today() ? r.a : today()) : deny();
    case 'm': return vMember(r.a, isDay(r.b) && r.b <= today() ? r.b : today());
    case 'org': return isAdmin() ? vOrg(r.a || 'members') : deny();
    case 'audit': return isAdmin() ? vAudit() : deny();
    case 'settings': return vSettings();
    default: location.replace(home()); return skel();
  }
}
const skel = () => '<div class="wrap skel" aria-label="جارٍ التحميل"><i></i><i></i><i></i></div>';
const deny = () => `<div class="wrap"><div class="card"><p>هذه الصفحة ليست ضمن صلاحياتك.</p></div></div>`;
const vh = (title, sub = '', side = '') => `<header class="vh"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${side ? `<div class="side-x">${side}</div>` : ''}</header>`;
const loadingCard = () => '<div class="card"><div class="skel"><i></i></div></div>';
const errCard = (d) => `<div class="card"><p class="hint" role="alert">${esc(d.error)}</p><button class="btn sm" data-act="retry">إعادة المحاولة</button></div>`;

/* ═════════════ الدخول والانضمام ═════════════ */
function vAuth() {
  const t = S.authTab;
  const tab = (k, l) => `<button type="button" data-act="auth-tab" data-v="${k}" aria-pressed="${t === k}">${l}</button>`;
  const inviteOnly = S.info.signup === 'invite';
  return `<div class="auth"><div class="card">
    <div class="brand"><img src="icons/icon.svg" alt="" width="40" height="40" /><div><b>ITrack</b><small>العمل اليومي والمهام في مكان واحد</small></div></div>
    <div class="seg" role="group" aria-label="نوع الدخول">${tab('in', 'دخول')}${tab('code', 'عندي رمز')}${inviteOnly ? '' : tab('up', 'تسجيل')}</div>
    ${S.info && S.info.ok && S.info.auth !== 'local' ? '<p class="notice warn" role="alert">خادم ITrack على Cloudflare بنسخة قديمة لا تدعم الدخول الجديد. الصق <b>worker.js</b> الأحدث في محرر الـWorker ثم اضغط Deploy.</p>' : ''}
    ${t === 'code' ? codeForm() : `<form data-form="auth" data-op="${t === 'up' ? 'up' : 'in'}">
      <label class="fld"><span>البريد الإلكتروني</span><input class="in" type="email" name="email" autocomplete="username" required dir="ltr" /></label>
      <label class="fld"><span>كلمة المرور</span><input class="in" type="password" name="pass" autocomplete="${t === 'up' ? 'new-password' : 'current-password'}" required minlength="8" dir="ltr" /></label>
      <button class="btn primary" type="submit">${t === 'up' ? 'إنشاء الحساب' : 'دخول'}</button>
    </form>`}
    ${t === 'up' ? '<p class="hint alt">لإنشاء جهة جديدة لفريقك. إن دعاك مسؤول جهتك فاختر «عندي رمز».</p>'
      : t === 'in' ? '<p class="alt"><button class="link" data-act="reset">نسيت كلمة المرور؟</button></p>' : ''}
  </div></div>`;
}
/** رمز من المسؤول: دعوة للانضمام، أو إعادة تعيين كلمة المرور. */
function codeForm() {
  const email = S.me?.email || '';
  return `<form data-form="code" class="form-grid">
    <p class="hint" style="margin:0">أدخل الرمز الذي أرسله لك مسؤول جهتك (دعوة أو إعادة تعيين كلمة المرور).</p>
    <label class="fld"><span>البريد الذي أضافك به</span><input class="in" type="email" name="email" autocomplete="username" required dir="ltr" value="${esc(email)}"${email ? ' readonly' : ''} /></label>
    <label class="fld"><span>الرمز</span><input class="in" name="code" required dir="ltr" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX" value="${esc(S.prefCode || '')}" style="letter-spacing:.08em" /></label>
    <label class="fld"><span>كلمة المرور</span><input class="in" type="password" name="pass" required minlength="8" dir="ltr" autocomplete="new-password" /></label>
    <p class="hint" style="margin:0">لك حساب سابق؟ اكتب كلمة مروره. غير ذلك: اختر كلمة مرور جديدة (٨ أحرف على الأقل).</p>
    <button class="btn primary" type="submit">متابعة</button>
  </form>`;
}
function vGateError() {
  return `<div class="auth"><div class="card"><h1>تعذّر الاتصال</h1><p role="alert">${esc(S.err)}</p><div class="form-grid"><button class="btn primary" data-act="retry-gate">إعادة المحاولة</button><button class="btn ghost" data-act="signout">خروج</button></div></div></div>`;
}
function vNoOrg() {
  const list = S.me.orgs.filter((o) => !o.invited);
  const inv = S.me.orgs.filter((o) => o.invited);
  if (S.prefCode || inv.length) return `<div class="auth"><div class="card">
    <div class="brand"><img src="icons/icon.svg" alt="" width="40" height="40" /><div><b>ITrack</b><small dir="ltr">${esc(S.me.email)}</small></div></div>
    <h1>${inv.length ? `دعوة إلى «${esc(inv[0].name)}»` : 'رمز من المسؤول'}</h1>${codeForm()}
    ${list.length || inv.length ? `<p class="alt"><button class="link" data-act="skip-code">لاحقًا</button></p>` : ''}
  </div></div>`;
  return `<div class="auth"><div class="card">
    <div class="brand"><img src="icons/icon.svg" alt="" width="40" height="40" /><div><b>ITrack</b><small dir="ltr">${esc(S.me.email)}</small></div></div>
    ${list.length ? `<h1>اختر الجهة</h1><div class="form-grid">${list.map((o) => `<button class="btn" data-act="pick-org" data-id="${esc(o.id)}">${esc(o.name)} · ${ROLE[o.role]}</button>`).join('')}</div><hr style="margin:18px 0;border:0;border-top:1px solid var(--line)" />`
      : `<h1>لست ضمن أي جهة بعد</h1><p class="hint">إن كنت موظفًا فاطلب من مسؤول جهتك إضافتك بهذا البريد: <b dir="ltr">${esc(S.me.email)}</b>، ثم <button class="link" data-act="retry-gate">حدّث</button>.</p><hr style="margin:18px 0;border:0;border-top:1px solid var(--line)" />`}
    <h2 style="font-size:1rem;margin-bottom:10px">أو أنشئ جهة جديدة وكن مسؤولها</h2>
    <form data-form="org" class="form-grid">
      <label class="fld"><span>اسم الجهة أو الإدارة</span><input class="in" name="name" required maxlength="80" /></label>
      <label class="fld"><span>اسمك كما يظهر للفريق</span><input class="in" name="my_name" required maxlength="60" /></label>
      <button class="btn primary" type="submit">إنشاء الجهة</button>
    </form>
    <p class="alt"><button class="link" data-act="signout">خروج</button></p>
  </div></div>`;
}

/* ═════════════ التاريخ ═════════════ */
function dayBar(base, d, hist) {
  const t = today();
  const days = Array.from({ length: 14 }, (_, i) => addD(t, -i));
  const by = new Map((hist?.days || []).map((x) => [x.date, x]));
  return `<div class="daybar">
    <div class="daynav" role="group" aria-label="اختيار اليوم">
      <a class="ib" href="${base}/${addD(d, -1)}" aria-label="اليوم السابق">${I('back')}</a>
      <b>${rel(d)}<small>${fLong.format(parse(d))}</small></b>
      ${d < t ? `<a class="ib" href="${base}/${addD(d, 1)}" aria-label="اليوم التالي">${I('fwd')}</a>` : '<span class="ib off" aria-hidden="true"></span>'}
    </div>
    <ol class="strip" aria-label="آخر ١٤ يومًا">${days.map((k) => {
      const st = by.get(k)?.status || 'none';
      return `<li><a href="${base}/${k}" class="s-${st}"${k === d ? ' aria-current="date"' : ''} aria-label="${fLong.format(parse(k))}: ${STATUS[st]}"><span>${n(parse(k).getDate())}</span><small>${fWd.format(parse(k))}</small></a></li>`;
    }).join('')}</ol>
  </div>`;
}

/* ═════════════ التوصيف والتغطية ═════════════ */
function jdCard(member, hist, span = 14) {
  const pos = posById(member.position_id);
  if (!pos) return `<div class="card"><h2>${I('doc')}التوصيف الوظيفي</h2><p class="hint">لم تُحدَّد وظيفة${isAdmin() ? '. حدّدها من «الهيكل».' : ' بعد. يحدّدها مسؤول الجهة.'}</p></div>`;
  const cov = new Map((hist?.coverage || []).map((c) => [c.rid ?? '', c]));
  const active = pos.responsibilities.filter((r) => r.active);
  const max = Math.max(1, ...active.map((r) => cov.get(r.id)?.n || 0));
  const out = cov.get('');
  return `<div class="card"><h2>${I('doc')}${esc(pos.title)}</h2>
    ${pos.summary ? `<p class="hint" style="margin-bottom:10px">${esc(pos.summary)}</p>` : ''}
    <p class="hint" style="margin-bottom:10px">عدد البنود لكل مسؤولية في آخر ${n(span)} يومًا. المظلَّل لم يُعمل عليه.</p>
    <ul class="jd">${active.map((r) => { const c = cov.get(r.id); return `<li class="${c ? '' : 'cold'}"><div style="flex:1"><b>${esc(r.title)}</b>${r.detail ? `<p>${esc(r.detail)}</p>` : ''}${c ? `<div class="bar" aria-hidden="true"><i style="width:${Math.round((c.n / max) * 100)}%"></i></div>` : ''}</div><span class="cnt">${c ? `${n(c.n)}${c.minutes ? ` · ${mins(c.minutes)}` : ''}` : 'لا شيء'}</span></li>`; }).join('')}
    ${out ? `<li><div><b>خارج التوصيف</b></div><span class="cnt">${n(out.n)}</span></li>` : ''}</ul>
    <p class="hint" style="margin-top:10px">إصدار التوصيف ${n(pos.version)}</p></div>`;
}
const respTitle = (pos, id) => pos?.responsibilities.find((r) => r.id === id)?.title;

function trailCard(trail) {
  if (!trail?.length) return '';
  return `<div class="card"><h2>${I('clock')}سجل التقرير</h2><ol class="trail">${trail.map((t) => `<li class="a-${t.action.split('.')[1]}"><b>${esc(t.actor || '—')}</b> ${ACTION[t.action] || esc(t.action)}<time>${fTime.format(new Date(t.at))}</time>${t.comment ? `<p>${esc(t.comment)}</p>` : ''}</li>`).join('')}</ol></div>`;
}
function reviewNotice(rep, own) {
  if (!rep) return '';
  const by = memberById(rep.reviewed_by)?.name || 'المدير';
  if (rep.status === 'returned') return `<div class="notice warn" role="status"><b>${own ? `أعاده ${esc(by)} للتعديل` : 'مُعاد للتعديل'}</b>${rep.review_comment ? `<p>${esc(rep.review_comment)}</p>` : ''}</div>`;
  if (rep.status === 'approved') return `<div class="notice ok"><b>اعتمده ${esc(by)}</b>${rep.review_comment ? `<p>${esc(rep.review_comment)}</p>` : ''}</div>`;
  if (rep.status === 'submitted') return `<div class="notice"><b>${own ? 'رُفع، بانتظار مراجعة مديرك' : 'مرفوع، بانتظار المراجعة'}</b>${rep.review_comment ? `<p>${esc(rep.review_comment)}</p>` : ''}</div>`;
  return '';
}
function itemView(it, pos) {
  const t = respTitle(pos, it.responsibility_id);
  return `<li class="item st-${it.state}"><div class="body"><div class="tx">${esc(it.text)}</div>
    <div class="meta"><span class="tag ${it.state}">${STATE[it.state]}</span>${t ? `<span class="tag">${esc(t)}</span>` : '<span class="tag out">خارج التوصيف</span>'}${it.minutes ? `<span>${I('clock')} ${mins(it.minutes)}</span>` : ''}</div>
    ${it.state === 'blocked' && it.blocker ? `<div class="blocker"><p><b>السبب:</b> ${esc(it.blocker)}</p></div>` : ''}</div></li>`;
}

/* ═════════════ يومي ═════════════ */
function vDay(d) {
  const me = S.boot.me;
  const rep = need(`rep|${me.id}|${d}`, () => call('GET', `/api/report?date=${d}`));
  const hist = need(`hist|${me.id}`, () => call('GET', `/api/history?from=${addD(today(), -13)}&to=${today()}`));
  const pos = posById(me.position_id);
  let body;
  if (!rep) body = loadingCard();
  else if (rep.error) body = errCard(rep);
  else {
    const r = rep.report;
    const st = r?.status || 'none';
    const tooOld = d < addD(today(), -7) && st !== 'returned';
    const editable = !tooOld && (!r || st === 'draft' || st === 'returned');
    if (editable && !S.draft[d]) S.draft[d] = restoreDraft(d, r, rep.items);
    const dr = S.draft[d];
    const items = editable ? dr.items : rep.items;
    const respOpts = (sel) => `<option value="">خارج التوصيف</option>${(pos?.responsibilities || []).filter((x) => x.active).map((x) => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}`;
    const minOpts = (sel) => `<option value="">المدة</option>${MINS.map((m) => `<option value="${m}"${m === sel ? ' selected' : ''}>${mins(m)}</option>`).join('')}`;
    const list = items.length
      ? `<ol class="items">${items.map((it, i) => (editable ? `<li class="item st-${it.state}"><div class="body">
          <label class="sr-only" for="it-${i}">نص البند ${n(i + 1)}</label>
          <textarea id="it-${i}" class="tx auto" rows="1" maxlength="600" data-k="it-${i}" data-edit="text" data-i="${i}">${esc(it.text)}</textarea>
          <div class="meta">
            <div class="seg" role="group" aria-label="الحالة">${Object.entries(STATE).map(([k, l]) => `<button type="button" data-act="state" data-i="${i}" data-v="${k}" aria-pressed="${it.state === k}">${l}</button>`).join('')}</div>
            <select class="in" data-edit="responsibility_id" data-i="${i}" aria-label="المسؤولية">${respOpts(it.responsibility_id)}</select>
            <select class="in" data-edit="minutes" data-i="${i}" aria-label="المدة">${minOpts(it.minutes)}</select>
          </div>
          ${it.state === 'blocked' ? `<label class="blocker"><span class="sr-only">سبب التعثّر</span><input class="in" data-k="bl-${i}" data-edit="blocker" data-i="${i}" maxlength="400" placeholder="ما الذي يعيقك؟ ومن تحتاج؟" value="${esc(it.blocker || '')}" /></label>` : ''}
        </div><button class="ib bare" data-act="del-item" data-i="${i}" aria-label="حذف البند ${n(i + 1)}">${I('trash')}</button></li>` : itemView(it, pos))).join('')}</ol>`
      : `<div class="empty"><p>${editable ? 'لا بنود بعد. اكتب أول ما أنجزته اليوم.' : 'لا بنود في هذا اليوم.'}</p></div>`;
    const composer = editable ? `<form class="composer" data-form="add-item">
        <label class="sr-only" for="new-item">بند جديد</label>
        <textarea id="new-item" class="in auto" name="text" rows="1" maxlength="600" required data-k="new-item" placeholder="ماذا أنجزت؟ بند واحد في كل مرة، ثم Enter"></textarea>
        <div class="row"><select class="in grow" name="responsibility_id" aria-label="المسؤولية">${respOpts('')}</select><select class="in" name="minutes" aria-label="المدة" style="width:auto">${minOpts(null)}</select><button class="btn accent" type="submit">${I('plus')}أضف</button></div>
      </form>` : '';
    const note = editable
      ? `<label class="fld" style="margin-top:14px"><span>ملاحظة لمديرك (اختياري)</span><textarea class="in auto" rows="2" maxlength="2000" data-k="note" data-edit="note" placeholder="عوائق، طلبات، أو ما يحتاج قرارًا">${esc(dr.note)}</textarea></label>`
      : r?.note ? `<div class="notice" style="margin-top:14px;margin-bottom:0"><b>ملاحظتك</b><p>${esc(r.note)}</p></div>` : '';
    const total = items.reduce((s, x) => s + (x.minutes || 0), 0);
    const ss = S.saveState[d] || (S.dirty[d] ? 'pending' : 'ok');
    const saved = editable ? `<span class="saved" data-s="${ss}" role="status" aria-live="polite">${ss === 'saving' ? 'يحفظ…' : ss === 'error' ? `${I('x')} لم يُحفظ: لا اتصال. سيُعاد تلقائيًا.` : ss === 'pending' ? 'تغييرات غير محفوظة' : r ? `${I('check')} محفوظ كمسودة` : ''}</span>` : '';
    const submit = editable ? `<button class="btn primary" data-act="submit" data-d="${d}"${items.length ? '' : ' disabled'}>${I('check')}${st === 'returned' ? 'إعادة الرفع' : 'رفع التقرير'}</button>` : '';
    body = `${tooOld && !r ? '<div class="notice warn"><b>مضى أكثر من ٧ أيام</b><p>لا يمكن كتابة تقرير لهذا اليوم الآن.</p></div>' : ''}
      ${reviewNotice(r, true)}${list}${composer}${note}
      ${editable || items.length ? `<div class="savebar">${saved}<span class="hint">${n(items.length)} بند${total ? ` · ${mins(total)}` : ''}</span>${submit}</div>` : ''}`;
  }
  const st = rep && !rep.error ? (rep.report?.status || 'none') : 'none';
  const ib = inbox();
  const back = ib && !ib.error ? ib.returned.filter((x) => x.date !== d) : [];
  const backNote = back.length ? `<div class="notice warn" role="status"><b>${back.length === 1 ? 'تقرير مُعاد لك للتعديل' : `${n(back.length)} تقارير مُعادة لك للتعديل`}</b><p>${back.map((x) => `<a class="link" href="#/day/${x.date}">${rel(x.date)}</a>${x.review_comment ? `: ${esc(x.review_comment.slice(0, 80))}` : ''}`).join('<br>')}</p></div>` : '';
  return `<div class="wrap">${vh('يومي', `${esc(S.boot.me.name)}${pos ? ` · ${esc(pos.title)}` : ''}`, chip(st))}
    ${backNote}${dayBar('#/day', d, hist)}
    <div class="grid2"><div class="card"><h2>${I('note')}ما أنجزته ${rel(d) === 'اليوم' ? 'اليوم' : `يوم ${rel(d)}`}</h2>${body}</div>
    <div class="stack">${jdCard(S.boot.me, hist && !hist.error ? hist : null)}${rep && !rep.error ? trailCard(rep.trail) : ''}</div></div></div>`;
}

/* مسودة اليوم: من الخادم، أو من نسخة الجهاز إن كانت أحدث (كتبتها دون اتصال) */
const draftKey = (d) => `it:draft:${S.org}:${S.boot.me.id}:${d}`;
function restoreDraft(d, r, items) {
  const local = store.get(draftKey(d));
  const server = { note: r?.note || '', items: items.map((x) => ({ ...x })), at: r?.updated_at || 0 };
  if (local && local.at > server.at) { S.dirty[d] = true; setTimeout(() => save(d), 50); return local; }
  return server;
}
const saveTimers = {};
function touch(d, now = false) {
  const dr = S.draft[d];
  dr.at = Date.now();
  store.set(draftKey(d), dr);
  S.dirty[d] = true;
  clearTimeout(saveTimers[d]);
  saveTimers[d] = setTimeout(() => save(d), now ? 0 : 900);
}
const inflight = {};
async function save(d) {
  if (inflight[d]) { inflight[d].again = true; return inflight[d].p; }
  const dr = S.draft[d];
  if (!dr) return;
  const sent = JSON.stringify(dr);
  S.saveState[d] = 'saving'; render();
  const job = { again: false };
  inflight[d] = job;
  job.p = (async () => {
    try {
      const res = await call('PUT', `/api/report/${d}`, { today: today(), note: dr.note, items: dr.items.map(({ id, text, responsibility_id, minutes, state, blocker }) => ({ id, text, responsibility_id: responsibility_id || null, minutes: minutes || null, state, blocker })) });
      // ثبّت المعرّفات الجديدة دون مسح ما كتبه أثناء الحفظ
      res.items.forEach((it, i) => { if (dr.items[i] && !dr.items[i].id) dr.items[i].id = it.id; });
      if (JSON.stringify(dr) === sent || !job.again) { S.dirty[d] = false; store.del(draftKey(d)); }
      S.saveState[d] = null;
      const k = `rep|${S.boot.me.id}|${d}`;
      const cur = S.cache.get(k);
      if (cur && !cur.error) S.cache.set(k, { ...cur, report: { ...(cur.report || { date: d }), status: res.status, note: dr.note, updated_at: res.updated_at }, items: res.items });
      else drop(k);
      drop(`hist|${S.boot.me.id}`);
    } catch (e) {
      S.saveState[d] = 'error';
      if (e.code === 'locked') { toast(e.message); delete S.draft[d]; store.del(draftKey(d)); drop(`rep|${S.boot.me.id}|${d}`); }
      else if (e.code !== 'offline') toast(e.message);
      else setTimeout(() => S.dirty[d] && save(d), 15000);
    } finally {
      inflight[d] = null;
      if (job.again && S.dirty[d]) save(d);
      render();
    }
  })();
  return job.p;
}
window.addEventListener('online', () => Object.keys(S.dirty).forEach((d) => S.dirty[d] && save(d)));
window.addEventListener('beforeunload', (e) => { if (Object.values(S.dirty).some(Boolean)) e.preventDefault(); });

/* ═════════════ الفريق ═════════════ */
function vTeam(d) {
  const day = need(`day|${d}`, () => call('GET', `/api/day?date=${d}`));
  const list = teamList();
  const rows = new Map((day?.rows || []).map((r) => [r.member_id, r]));
  const stOf = (m) => rows.get(m.id)?.status || 'none';
  const shown = list.filter((m) => (!S.f.dep || m.department_id === S.f.dep) && (!S.f.st || (S.f.st === 'blocked' ? rows.get(m.id)?.blocked > 0 : S.f.st === 'missing' ? ['none', 'draft'].includes(stOf(m)) : stOf(m) === S.f.st)));
  const sent = list.filter((m) => ['submitted', 'approved', 'returned'].includes(stOf(m))).length;
  const waiting = list.filter((m) => stOf(m) === 'submitted').length;
  const blocked = list.reduce((s, m) => s + (rows.get(m.id)?.blocked || 0), 0);
  const kpis = `<div class="kpis">
    <div class="kpi"><b>${n(sent)}<small style="font-size:.9rem;color:var(--muted)"> / ${n(list.length)}</small></b><span>رفعوا تقرير ${rel(d)}</span></div>
    <div class="kpi"><b>${n(waiting)}</b><span>بانتظار المراجعة</span></div>
    <div class="kpi"><b>${n(list.length - sent)}</b><span>لم يرفعوا</span></div>
    <div class="kpi${blocked ? ' hot' : ''}"><b>${n(blocked)}</b><span>بنود متعثّرة</span></div></div>`;
  const deps = S.boot.departments.filter((x) => x.active);
  const fchip = (v, l) => `<button class="chip" data-act="fst" data-v="${v}" aria-pressed="${S.f.st === v}">${l}</button>`;
  const filters = `<div class="filters">${deps.length > 1 ? `<select class="in" data-act="fdep" aria-label="الإدارة"><option value="">كل الإدارات</option>${deps.map((x) => `<option value="${esc(x.id)}"${x.id === S.f.dep ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
    ${fchip('', 'الكل')}${fchip('missing', 'لم يرفع')}${fchip('submitted', 'بانتظار المراجعة')}${fchip('approved', 'معتمد')}${fchip('returned', 'مُعاد')}${fchip('blocked', 'متعثّر')}</div>`;
  const person = (m) => {
    const r = rows.get(m.id); const st = stOf(m); const pos = posById(m.position_id);
    return `<a class="person" href="#/m/${encodeURIComponent(m.id)}/${d}">${avatar(m.name)}<div class="who"><b>${esc(m.name)}</b><small>${esc(pos?.title || ROLE[m.role])}${memberById(m.manager_id) && isAdmin() ? ` · يتبع ${esc(memberById(m.manager_id).name)}` : ''}</small></div>
      <div class="nums">${r?.items ? `<span>${n(r.items)} بند</span>` : ''}${r?.minutes ? `<span>${mins(r.minutes)}</span>` : ''}${r?.blocked ? `<span class="tag blocked">${n(r.blocked)} متعثّر</span>` : ''}${r?.late ? '<span class="tag late">متأخر</span>' : ''}${m.status === 'invited' ? '<span class="tag out">لم ينضم بعد</span>' : ''}</div>${chip(st)}</a>`;
  };
  // تجميع حسب الإدارة
  const groups = new Map();
  for (const m of shown) { const k = m.department_id || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const body = !list.length
    ? `<div class="empty"><p>${isAdmin() ? 'لا أعضاء بعد.' : 'لا أحد يتبعك.'}</p>${isAdmin() ? '<a class="btn primary sm" href="#/org/members">إضافة أعضاء</a>' : ''}</div>`
    : !day ? '<div class="skel"><i></i><i></i></div>' : day.error ? errCard(day)
    : !shown.length ? '<div class="empty"><p>لا أحد في هذا التصنيف.</p></div>'
    : [...groups.entries()].map(([k, ms]) => `${groups.size > 1 ? `<p class="grp">${esc(depById(k)?.name || 'بلا إدارة')} · ${n(ms.length)}</p>` : ''}<div class="people">${ms.map(person).join('')}</div>`).join('');
  const ib = inbox();
  const queue = ib && !ib.error ? ib.review : [];
  const qCard = queue.length ? `<div class="card queue"><h2>${I('hourglass')}بانتظار مراجعتك · ${n(queue.length)}</h2><div class="people">${queue.slice(0, 12).map((x) => { const m = memberById(x.member_id); return m ? `<a class="person" href="#/m/${encodeURIComponent(m.id)}/${x.date}">${avatar(m.name)}<div class="who"><b>${esc(m.name)}</b><small>تقرير ${rel(x.date)}${x.submitted_at ? ` · رُفع ${fTime.format(new Date(x.submitted_at))}` : ''}</small></div>${x.late ? '<span class="tag late">متأخر</span>' : ''}${x.date < addD(today(), -2) ? '<span class="tag blocked">ينتظر منذ أيام</span>' : ''}</a>` : ''; }).join('')}</div>${queue.length > 12 ? `<p class="hint" style="margin-top:8px">و${n(queue.length - 12)} غيرها. ابدأ بالأقدم.</p>` : ''}</div>` : '';
  return `<div class="wrap">${vh('الفريق', isAdmin() ? 'كل أعضاء الجهة' : 'كل من يتبعك مباشرة أو عبر مدير')}${qCard}
    ${dayBar('#/team', d, null).replace(/<ol class="strip"[\s\S]*<\/ol>/, '')}
    ${list.length ? kpis : ''}<div class="card">${list.length ? filters : ''}${body}<p class="hint" style="margin-top:12px">المسودة تظهر حالتها فقط؛ محتواها يظهر بعد أن يرفعها الموظف.</p></div></div>`;
}

/* ═════════════ صفحة موظف ═════════════ */
function vMember(id, d) {
  const m = memberById(id);
  if (!m || m.email === undefined) return deny();
  if (id === S.boot.me.id) { location.replace(`#/day/${d}`); return skel(); }
  const rep = need(`rep|${id}|${d}`, () => call('GET', `/api/report?member=${encodeURIComponent(id)}&date=${d}`));
  const hist = need(`hist|${id}`, () => call('GET', `/api/history?member=${encodeURIComponent(id)}&from=${addD(today(), -13)}&to=${today()}`));
  const pos = posById(m.position_id);
  const base = `#/m/${encodeURIComponent(id)}`;
  let body;
  if (!rep) body = loadingCard();
  else if (rep.error) body = errCard(rep);
  else {
    const r = rep.report;
    const st = r?.status || 'none';
    const total = rep.items.reduce((s, x) => s + (x.minutes || 0), 0);
    const review = rep.can_review && ['submitted', 'approved', 'returned'].includes(st) ? `<form class="form-grid" data-form="review" data-id="${esc(id)}" data-d="${d}" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">
        <label class="fld"><span>${st === 'submitted' ? 'ملاحظتك (مطلوبة عند الإعادة)' : 'أضف ملاحظة'}</span><textarea class="in auto" name="comment" rows="2" maxlength="1000" data-k="rv" placeholder="توجيه، تقدير، أو ما يحتاج تعديلًا"></textarea></label>
        <div class="row">${st === 'submitted' ? `<button class="btn ok" name="action" value="approve" type="submit">${I('check')}اعتماد</button><button class="btn warn" name="action" value="return" type="submit">${I('back')}إعادة للتعديل</button>` : ''}<button class="btn" name="action" value="comment" type="submit">ملاحظة فقط</button></div></form>` : '';
    body = r && st !== 'draft'
      ? `${reviewNotice(r, false)}${r.late ? '<p class="hint"><span class="tag late">كُتب متأخرًا</span></p>' : ''}<ol class="items">${rep.items.map((it) => itemView(it, pos)).join('')}</ol>
        ${r.note ? `<div class="notice" style="margin-top:14px;margin-bottom:0"><b>ملاحظة الموظف</b><p>${esc(r.note)}</p></div>` : ''}
        <div class="savebar"><span class="hint">${n(rep.items.length)} بند${total ? ` · ${mins(total)}` : ''}${r.submitted_at ? ` · رُفع ${fTime.format(new Date(r.submitted_at))}` : ''}</span></div>${review}`
      : `<div class="empty"><p>${st === 'draft' ? 'يعمل على التقرير ولم يرفعه بعد.' : 'لم يُرفع تقرير لهذا اليوم.'}</p></div>`;
  }
  const st = rep && !rep.error ? (rep.report?.status || 'none') : 'none';
  const mgr = memberById(m.manager_id);
  const sub = [pos?.title, depById(m.department_id)?.name, mgr ? `يتبع ${mgr.name}` : ''].filter(Boolean).map(esc).join(' · ');
  return `<div class="wrap"><p style="margin:0 0 10px"><a class="link" style="color:var(--on-bg)" href="#/team/${d}">← الفريق</a></p>
    ${vh(esc(m.name), sub, chip(st))}
    ${dayBar(base, d, hist && !hist.error ? hist : null)}
    <div class="grid2"><div class="card"><h2>${I('note')}تقرير ${rel(d)}</h2>${body}</div>
    <div class="stack">${jdCard(m, hist && !hist.error ? hist : null)}${rep && !rep.error ? trailCard(rep.trail) : ''}</div></div></div>`;
}

/* ═════════════ الهيكل (المسؤول) ═════════════ */
function vOrg(tab) {
  const tabs = `<nav class="tabs" aria-label="أقسام الهيكل">${[['members', 'الأعضاء'], ['positions', 'الوظائف والتوصيف'], ['departments', 'الإدارات']].map(([k, l]) => `<a href="#/org/${k}"${k === tab ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
  const body = tab === 'positions' ? orgPositions() : tab === 'departments' ? orgDeps() : orgMembers();
  return `<div class="wrap">${vh('الهيكل', esc(S.boot.org.name))}${tabs}${body}</div>`;
}
const opt = (v, l, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`;
function memberForm(m) {
  const deps = S.boot.departments.filter((x) => x.active || x.id === m?.department_id);
  const poss = S.boot.positions.filter((x) => x.active);
  const mgrs = members().filter((x) => x.email !== undefined && x.status !== 'disabled' && x.id !== m?.id && x.role !== 'employee');
  return `<form class="form-grid two" data-form="member" data-id="${esc(m?.id || '')}">
    <label class="fld"><span>البريد (يدخل به)</span><input class="in" type="email" name="email" required maxlength="120" dir="ltr" value="${esc(m?.email || '')}"${m ? ' readonly' : ''} /></label>
    <label class="fld"><span>الاسم</span><input class="in" name="name" required maxlength="60" value="${esc(m?.name || '')}" /></label>
    <label class="fld"><span>الدور</span><select class="in" name="role">${Object.entries(ROLE).map(([k, l]) => opt(k, l, m?.role || 'employee')).join('')}</select></label>
    <label class="fld"><span>المدير المباشر</span><select class="in" name="manager_id"><option value="">— بلا مدير —</option>${mgrs.map((x) => opt(x.id, `${x.name} (${ROLE[x.role]})`, m ? m.manager_id : S.boot.me.id)).join('')}</select></label>
    <label class="fld"><span>الإدارة</span><select class="in" name="department_id"><option value="">—</option>${deps.map((x) => opt(x.id, x.name, m?.department_id)).join('')}</select></label>
    <label class="fld"><span>الوظيفة (التوصيف)</span><select class="in" name="position_id"><option value="">—</option>${poss.map((x) => opt(x.id, x.title, m?.position_id)).join('')}</select></label>
    <div class="row full"><button class="btn primary" type="submit">${m ? 'حفظ' : `${I('plus')}إضافة ودعوة`}</button>${m ? `<button type="button" class="btn" data-act="edit-member" data-id="">إلغاء</button>
      <button type="button" class="btn ${m.status === 'disabled' ? '' : 'warn'}" data-act="toggle-member" data-id="${esc(m.id)}">${m.status === 'disabled' ? 'إعادة التفعيل' : 'تعطيل الحساب'}</button>` : ''}</div>
  </form>`;
}
const appLink = () => `${location.origin}${location.pathname}`;
const inviteText = (m, c) => (c.kind === 'reset'
  ? `مرحبًا ${m.name}،\nرمز إعادة تعيين كلمة مرورك في ITrack (صالح ٢٤ ساعة):\n${c.code}\nافتح: ${appLink()}#/code/${c.code}\nثم اكتب بريدك (${m.email}) وكلمة المرور الجديدة.`
  : `مرحبًا ${m.name}،\nأُضفت إلى «${S.boot.org.name}» على ITrack لتوثيق إنجازك اليومي وتنظيم مهامك.\n١) افتح الرابط: ${appLink()}#/code/${c.code}\n٢) بريدك: ${m.email}\n٣) الرمز: ${c.code} (صالح ١٤ يومًا)\n٤) اختر كلمة مرور، وستدخل مباشرة.\nيمكنك تثبيت التطبيق من المتصفح: «إضافة إلى الشاشة الرئيسية».`);
function codeBox(m) {
  let c = S.codes[m.id];
  if (c && c.kind === 'invite' && m.joined) c = null; // انضم بالفعل: رمز الدعوة لم يعد مفيدًا
  if (m.status === 'disabled') return '';
  if (!c) return `<div class="row" style="margin-top:12px"><button type="button" class="btn sm" data-act="issue-code" data-id="${esc(m.id)}">${m.joined ? 'رمز إعادة تعيين كلمة المرور' : 'إنشاء رمز دعوة'}</button></div>
    <p class="hint" style="margin-top:6px">${m.joined ? 'إن نسي كلمة مروره: أصدر رمزًا وأرسله له. الرمز القديم يُلغى.' : 'الرمز يُعرض مرة واحدة؛ إن ضاع أصدر رمزًا جديدًا.'}</p>`;
  return `<p class="hint" style="margin-top:12px">${c.kind === 'reset' ? 'رمز إعادة التعيين' : 'رسالة الدعوة'} (أرسلها بالبريد أو واتساب — لن تظهر مرة أخرى):</p><pre class="invite">${esc(inviteText(m, c))}</pre><button class="btn sm" data-act="copy-invite" data-id="${esc(m.id)}" style="margin-top:8px">نسخ الرسالة</button>`;
}
function orgMembers() {
  const all = members().filter((m) => m.email !== undefined);
  const groups = new Map();
  for (const m of all) { const k = m.department_id || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const row = (m) => {
    const open = S.edit.member === m.id;
    return `<div><div class="person${m.status === 'disabled' ? ' off' : ''}">${avatar(m.name)}<div class="who"><b>${esc(m.name)}</b><small dir="auto">${esc(m.email)}</small></div>
      <div class="nums"><span>${ROLE[m.role]}</span>${posById(m.position_id) ? `<span>· ${esc(posById(m.position_id).title)}</span>` : ''}${memberById(m.manager_id) ? `<span>· يتبع ${esc(memberById(m.manager_id).name)}</span>` : ''}</div>
      ${m.status === 'invited' ? '<span class="tag out">مدعو، لم ينضم</span>' : m.status === 'disabled' ? '<span class="tag blocked">معطّل</span>' : '<span class="tag done">نشط</span>'}
      <button class="btn sm" data-act="edit-member" data-id="${open ? '' : esc(m.id)}" aria-expanded="${open}">${open ? 'إغلاق' : 'تعديل'}</button></div>
      ${open ? `<div class="edit-box">${memberForm(m)}${codeBox(m)}</div>` : ''}</div>`;
  };
  return `<div class="grid2"><div class="card"><h2>${I('people', 'd')}الأعضاء · ${n(all.length)}</h2>
      ${[...groups.entries()].map(([k, ms]) => `<p class="grp">${esc(depById(k)?.name || 'بلا إدارة')}</p><div class="people">${ms.map(row).join('')}</div>`).join('')}</div>
    <div class="stack"><div class="card"><h2>${I('plus')}إضافة عضو</h2>${memberForm(null)}
      <p class="hint" style="margin-top:12px">بعد الإضافة تظهر رسالة دعوة فيها رابط ورمز. يفتحها ويختار كلمة مرور فيُربط بمكانه تلقائيًا.</p></div>
      <div class="card"><h2>${I('doc')}الأدوار</h2><ul class="hint" style="margin:0;padding-inline-start:18px;display:grid;gap:4px"><li><b>مسؤول الجهة</b>: يرى الجميع ويدير الهيكل والسجل.</li><li><b>مدير</b>: يرى من يتبعونه على أي عمق، يعتمد ويعيد.</li><li><b>موظف</b>: يرى تقاريره وتوصيفه فقط.</li></ul></div></div></div>`;
}
function posEditor(p) {
  const deps = S.boot.departments.filter((x) => x.active || x.id === p?.department_id);
  const rs = (p?.responsibilities || []).filter((r) => r.active);
  const rrow = (r, i) => `<div class="resp-row"><input type="hidden" name="rid" value="${esc(r?.id || '')}" />
      <input class="in" name="rt" maxlength="160" value="${esc(r?.title || '')}" placeholder="المسؤولية (مثال: استلام الشحنات ومطابقتها)" aria-label="المسؤولية ${n(i + 1)}" />
      <textarea class="in auto" name="rd" rows="1" maxlength="800" placeholder="التفاصيل أو معيار الإنجاز (اختياري)" aria-label="تفاصيل المسؤولية ${n(i + 1)}">${esc(r?.detail || '')}</textarea>
      <div class="acts"><button type="button" class="ib" data-act="resp-up" aria-label="أعلى">${I('down')}</button><button type="button" class="ib" data-act="resp-del" aria-label="حذف">${I('trash')}</button></div></div>`;
  return `<form class="form-grid" data-form="position" data-id="${esc(p?.id || '')}">
    <div class="form-grid two"><label class="fld"><span>المسمّى الوظيفي</span><input class="in" name="title" required maxlength="100" value="${esc(p?.title || '')}" /></label>
    <label class="fld"><span>الإدارة</span><select class="in" name="department_id"><option value="">—</option>${deps.map((x) => opt(x.id, x.name, p?.department_id)).join('')}</select></label></div>
    <label class="fld"><span>الغرض من الوظيفة</span><textarea class="in auto" name="summary" rows="2" maxlength="1000">${esc(p?.summary || '')}</textarea></label>
    <div><p class="hint" style="margin-bottom:8px">المسؤوليات: كل بند يكتبه الموظف يُربط بواحدة منها. حذف مسؤولية يعطّلها فقط، فتبقى التقارير القديمة كما هي.</p>
    <div class="resp-rows">${(rs.length ? rs : [null, null, null]).map(rrow).join('')}</div>
    <button type="button" class="btn sm" data-act="resp-add" style="margin-top:8px">${I('plus')}مسؤولية</button></div>
    <div class="row"><button class="btn primary" type="submit">حفظ${p ? ` (الإصدار ${n(p.version + 1)} إن تغيّر شيء)` : ''}</button><button type="button" class="btn" data-act="edit-pos" data-id="">إلغاء</button></div>
  </form>`;
}
function orgPositions() {
  const list = S.boot.positions;
  const holders = (pid) => members().filter((m) => m.position_id === pid && m.status !== 'disabled').length;
  const editing = S.edit.pos;
  return `<div class="grid2"><div class="stack">${editing === 'new' ? `<div class="card"><h2>${I('plus')}وظيفة جديدة</h2>${posEditor(null)}</div>` : ''}
    ${list.length ? list.map((p) => (editing === p.id ? `<div class="card"><h2>${I('doc')}تعديل: ${esc(p.title)}</h2>${posEditor(p)}</div>` : `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${I('doc')}${esc(p.title)}</h2><button class="btn sm" data-act="edit-pos" data-id="${esc(p.id)}">تعديل</button></div>
      <p class="hint" style="margin:6px 0 10px">${esc(depById(p.department_id)?.name || 'بلا إدارة')} · ${n(holders(p.id))} موظف · الإصدار ${n(p.version)}</p>
      ${p.summary ? `<p style="margin:0 0 10px">${esc(p.summary)}</p>` : ''}<ul class="jd">${p.responsibilities.filter((r) => r.active).map((r) => `<li><div><b>${esc(r.title)}</b>${r.detail ? `<p>${esc(r.detail)}</p>` : ''}</div></li>`).join('') || '<li class="cold"><div>لا مسؤوليات بعد.</div></li>'}</ul></div>`)).join('')
      : editing !== 'new' ? '<div class="card"><div class="empty"><p>لا وظائف بعد. ابدأ بأكثر وظيفة تكرارًا في فريقك.</p></div></div>' : ''}</div>
    <div class="stack"><div class="card"><h2>${I('doc')}التوصيف الوظيفي</h2><p class="hint">اكتب لكل وظيفة مسؤولياتها الثابتة بلغة قابلة للقياس. كل بند يومي يُربط بمسؤولية، فترى أين يذهب وقت الفريق وما المُهمَل.</p>
      ${editing === 'new' ? '' : `<button class="btn primary" data-act="edit-pos" data-id="new" style="margin-top:12px">${I('plus')}وظيفة جديدة</button>`}</div></div></div>`;
}
function orgDeps() {
  const list = S.boot.departments;
  const count = (id) => members().filter((m) => m.department_id === id && m.status !== 'disabled').length;
  return `<div class="grid2"><div class="card"><h2>${I('people', 'd')}الإدارات</h2>
    ${list.length ? `<div class="people">${list.map((x) => (S.edit.dep === x.id
      ? `<form class="person" data-form="dep" data-id="${esc(x.id)}"><input class="in grow" name="name" required maxlength="80" value="${esc(x.name)}" aria-label="اسم الإدارة" style="flex:1" /><button class="btn sm primary" type="submit">حفظ</button><button type="button" class="btn sm" data-act="edit-dep" data-id="">إلغاء</button></form>`
      : `<div class="person${x.active ? '' : ' off'}"><div class="who"><b>${esc(x.name)}</b><small>${n(count(x.id))} عضو${x.active ? '' : ' · معطّلة'}</small></div><button class="btn sm" data-act="edit-dep" data-id="${esc(x.id)}">تسمية</button><button class="btn sm" data-act="toggle-dep" data-id="${esc(x.id)}">${x.active ? 'تعطيل' : 'تفعيل'}</button></div>`)).join('')}</div>` : '<div class="empty"><p>لا إدارات بعد.</p></div>'}</div>
    <div class="card"><h2>${I('plus')}إدارة جديدة</h2><form class="row" data-form="dep" data-id=""><input class="in grow" name="name" required maxlength="80" placeholder="مثال: اللوجستيات" aria-label="اسم الإدارة" /><button class="btn primary" type="submit">إضافة</button></form></div></div>`;
}

/* ═════════════ السجل ═════════════ */
function vAudit() {
  const a = need('audit', () => call('GET', '/api/audit?limit=200'));
  const body = !a ? loadingCard() : a.error ? errCard(a) : `<div class="card"><ol class="trail">${a.rows.map((r) => {
    const subj = r.subject_id && memberById(r.subject_id);
    const extra = r.data?.comment || r.data?.name || r.data?.title || (r.data?.date ? rel(r.data.date) : '') || '';
    return `<li class="a-${r.action.split('.')[1]}"><b>${esc(r.actor || '—')}</b> ${ACTION[r.action] || esc(r.action)}${subj && r.subject_id !== r.actor_id ? ` · ${esc(subj.name)}` : ''}<time>${fTime.format(new Date(r.at))}</time>${extra ? `<p>${esc(extra)}</p>` : ''}</li>`;
  }).join('')}</ol></div>`;
  return `<div class="wrap">${vh('سجل التدقيق', 'كل إجراء في الجهة: من فعله ومتى. لا يُعدَّل ولا يُحذف.')}${body}</div>`;
}

/* ═════════════ الإعدادات ═════════════ */
function vSettings() {
  const th = document.documentElement.dataset.theme;
  return `<div class="wrap">${vh('الإعدادات')}<div class="grid2"><div class="stack">
    <div class="card"><h2>${I('sun')}المظهر</h2><div class="row">${[['petrol', 'بترولي'], ['navy', 'كحلي'], ['aqua', 'سماوي']].map(([k, l]) => `<button class="chip" data-act="theme" data-v="${k}" aria-pressed="${th === k}">${l}</button>`).join('')}</div></div>
    <div class="card"><h2>${I('user')}الحساب</h2><p dir="ltr" style="margin:0 0 6px;text-align:right">${esc(S.me.email)}</p><p class="hint">${esc(S.boot.me.name)} · ${ROLE[myRole()]} في «${esc(S.boot.org.name)}»</p>
      <div class="row" style="margin-top:12px">${S.me.orgs.length > 1 ? '<button class="btn" data-act="switch-org">تبديل الجهة</button>' : ''}<button class="btn" data-act="signout">خروج</button></div></div>
    <div class="card"><h2>${I('gear')}تغيير كلمة المرور</h2><form data-form="password" class="form-grid">
      <input type="email" name="u" autocomplete="username" value="${esc(S.me.email)}" hidden />
      <label class="fld"><span>الحالية</span><input class="in" type="password" name="old" required autocomplete="current-password" dir="ltr" /></label>
      <label class="fld"><span>الجديدة (٨ أحرف على الأقل)</span><input class="in" type="password" name="pass" required minlength="8" autocomplete="new-password" dir="ltr" /></label>
      <label class="fld"><span>تأكيد الجديدة</span><input class="in" type="password" name="pass2" required minlength="8" autocomplete="new-password" dir="ltr" /></label>
      <button class="btn" type="submit">تغيير</button></form></div></div>
    <div class="card"><h2>${I('doc')}عن ITrack</h2><p class="hint">نسخة تجريبية. بياناتك في خادم الجهة، والصلاحيات تُفرض في الخادم. كل رفع واعتماد وإعادة يُسجَّل في سجل لا يُعدَّل.</p></div></div></div>`;
}

/* ═════════════ الأحداث ═════════════ */
let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3600); }
const curDay = () => { const r = route(); return isDay(r.a) && r.a <= today() ? r.a : today(); };

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  const act = el.dataset.act;
  const d = curDay();
  switch (act) {
    case 'auth-tab': S.authTab = el.dataset.v; render(); break;
    case 'reset': S.authTab = 'code'; render(); toast('اطلب من مسؤول جهتك «رمز إعادة تعيين» ثم أدخله هنا.'); break;
    case 'skip-code': S.prefCode = ''; S.me = { ...S.me, orgs: S.me.orgs.filter((o) => !o.invited) }; render(); break;
    case 'issue-code': {
      try { S.codes[el.dataset.id] = await call('POST', `/api/members/${el.dataset.id}/code`, {}); drop('audit'); render(); }
      catch (er) { toast(er.message); }
      break;
    }
    case 'signout': if (Object.values(S.dirty).some(Boolean) && !confirm('تغييرات غير محفوظة. خروج؟')) break; store.del('it:org'); signOut(); break;
    case 'retry-gate': S.err = null; S.me = null; loadMe(); render(); break;
    case 'retry': S.cache.clear(); render(); break;
    case 'pick-org': S.org = el.dataset.id; store.set('it:org', S.org); loadBoot(); render(); break;
    case 'switch-org': S.org = null; S.boot = null; store.del('it:org'); S.cache.clear(); render(); break;
    case 'theme': setTheme(el.dataset.v); break;
    case 'state': { const it = S.draft[d]?.items[+el.dataset.i]; if (it) { it.state = el.dataset.v; if (it.state !== 'blocked') it.blocker = ''; touch(d); render(); if (it.state === 'blocked') setTimeout(() => view.querySelector(`[data-k="bl-${el.dataset.i}"]`)?.focus(), 30); } break; }
    case 'del-item': { const dr = S.draft[d]; if (dr) { const [gone] = dr.items.splice(+el.dataset.i, 1); touch(d); render(); toast(`حُذف: ${gone.text.slice(0, 40)}`); } break; }
    case 'submit': {
      el.disabled = true;
      try {
        if (S.dirty[d] || inflight[d]) { clearTimeout(saveTimers[d]); await save(d); if (S.dirty[d]) throw new Error('تعذّر حفظ آخر التغييرات. تحقّق من الاتصال.'); }
        await call('POST', `/api/report/${d}/submit`, { today: today() });
        delete S.draft[d]; drop(`rep|${S.boot.me.id}|${d}`, `hist|${S.boot.me.id}`, 'day|', 'inbox');
        toast('رُفع التقرير.');
      } catch (er) { toast(er.message); el.disabled = false; }
      render(); break;
    }
    case 'fst': S.f.st = el.dataset.v; render(); break;
    case 'edit-member': S.edit.member = el.dataset.id || null; render(); break;
    case 'toggle-member': {
      const m = memberById(el.dataset.id); if (!m) break;
      const on = m.status === 'disabled';
      if (!on && !confirm(`تعطيل حساب ${m.name}؟ لن يستطيع الدخول، وتبقى تقاريره محفوظة.`)) break;
      mutate(() => call('PATCH', `/api/members/${m.id}`, { status: on ? 'active' : 'disabled' }), on ? 'أُعيد التفعيل.' : 'عُطّل الحساب.');
      break;
    }
    case 'copy-invite': { const m = memberById(el.dataset.id); const c = S.codes[el.dataset.id]; if (m && c) navigator.clipboard?.writeText(inviteText(m, c)).then(() => toast('نُسخت رسالة الدعوة.'), () => toast('انسخها يدويًا من المربع.')); break; }
    case 'edit-pos': S.edit.pos = el.dataset.id || null; render(); if (S.edit.pos) setTimeout(() => view.querySelector('[data-form=position] [name=title]')?.focus(), 40); break;
    case 'resp-add': { const box = el.closest('form').querySelector('.resp-rows'); const tmp = document.createElement('div'); tmp.innerHTML = posEditor({ responsibilities: [{ active: 1 }] }); const row = tmp.querySelector('.resp-row'); box.appendChild(row); row.querySelector('[name=rt]').focus(); break; }
    case 'resp-del': el.closest('.resp-row').remove(); break;
    case 'resp-up': { const row = el.closest('.resp-row'); if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); break; }
    case 'edit-dep': S.edit.dep = el.dataset.id || null; render(); break;
    case 'toggle-dep': { const x = depById(el.dataset.id); if (x) mutate(() => call('PATCH', `/api/departments/${x.id}`, { active: !x.active }), 'حُفظ.'); break; }
    default:
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'fdep') { S.f.dep = el.value; render(); return; }
  if (el.dataset.edit && el.tagName === 'SELECT') {
    const d = curDay(); const it = S.draft[d]?.items[+el.dataset.i]; if (!it) return;
    it[el.dataset.edit] = el.dataset.edit === 'minutes' ? (Number(el.value) || null) : (el.value || null);
    touch(d); render();
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches('textarea.auto')) autosize(el);
  if (!el.dataset.edit || el.tagName === 'SELECT') return;
  const d = curDay(); const dr = S.draft[d]; if (!dr) return;
  if (el.dataset.edit === 'note') dr.note = el.value;
  else { const it = dr.items[+el.dataset.i]; if (it) it[el.dataset.edit] = el.value; }
  touch(d); // لا إعادة رسم أثناء الكتابة
});
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (el.dataset?.edit === 'text') { const d = curDay(); const it = S.draft[d]?.items[+el.dataset.i]; if (it && !it.text.trim()) { S.draft[d].items.splice(+el.dataset.i, 1); touch(d); render(); } }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.id === 'new-item') { e.preventDefault(); e.target.form.requestSubmit(); }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const get = (k) => (fd.get(k) || '').toString().trim();
  const btn = e.submitter;
  switch (form.dataset.form) {
    case 'auth': {
      if (btn) btn.disabled = true;
      try { if (form.dataset.op === 'up') { await signUp(get('email'), fd.get('pass')); toast('أُنشئ الحساب.'); } else await signIn(get('email'), fd.get('pass')); }
      catch (er) { toast(er.message); if (btn) btn.disabled = false; }
      break;
    }
    case 'code': {
      if (btn) btn.disabled = true;
      try {
        const r = await redeemCode(get('email'), get('code'), fd.get('pass'));
        S.prefCode = '';
        if (location.hash.startsWith('#/code/')) history.replaceState(null, '', location.pathname + location.search);
        if (r.org) { S.org = r.org; store.set('it:org', r.org); }
        S.boot = null; S.cache.clear(); await loadMe(); if (S.org) loadBoot();
        toast(r.kind === 'reset' ? 'عُيّنت كلمة المرور الجديدة.' : 'انضممت إلى الجهة.');
      } catch (er) { toast(er.message); if (btn) btn.disabled = false; }
      break;
    }
    case 'password': {
      if (btn) btn.disabled = true;
      if (fd.get('pass') !== fd.get('pass2')) { toast('كلمتا المرور غير متطابقتين.'); if (btn) btn.disabled = false; break; }
      try { await changePassword(fd.get('old'), fd.get('pass')); form.reset(); toast('غُيّرت كلمة المرور، وخرجت أجهزتك الأخرى.'); }
      catch (er) { toast(er.message); }
      if (btn) btn.disabled = false;
      break;
    }
    case 'org': {
      if (btn) btn.disabled = true;
      try { const r = await api('POST', '/api/orgs', { name: get('name'), my_name: get('my_name') }); S.org = r.id; store.set('it:org', r.id); await loadMe(); loadBoot(); location.hash = '#/org/departments'; toast('أُنشئت الجهة. ابدأ بالإدارات ثم الوظائف ثم الأعضاء.'); }
      catch (er) { toast(er.message); if (btn) btn.disabled = false; }
      break;
    }
    case 'add-item': {
      const d = curDay(); const dr = S.draft[d]; const text = get('text');
      if (!dr || !text) return;
      if (dr.items.length >= 30) { toast('الحد ٣٠ بندًا لليوم.'); return; }
      dr.items.push({ id: null, text, responsibility_id: get('responsibility_id') || null, minutes: Number(get('minutes')) || null, state: 'done', blocker: '' });
      touch(d); form.reset(); render();
      setTimeout(() => { const t = view.querySelector('#new-item'); t?.focus(); }, 30);
      break;
    }
    case 'review': {
      const action = btn?.value || 'comment';
      const comment = get('comment');
      if (action === 'return' && !comment) { toast('اكتب سبب الإعادة حتى يعرف ما يعدّل.'); form.comment.focus(); return; }
      if (action === 'comment' && !comment) { toast('اكتب الملاحظة.'); return; }
      const id = form.dataset.id; const d = form.dataset.d;
      try { await call('POST', '/api/review', { member_id: id, date: d, action, comment }); drop(`rep|${id}|${d}`, `hist|${id}`, 'day|', 'audit', 'inbox'); toast({ approve: 'اعتُمد التقرير.', return: 'أُعيد للموظف للتعديل.', comment: 'أُضيفت الملاحظة.' }[action]); }
      catch (er) { toast(er.message); }
      render(); break;
    }
    case 'member': {
      const id = form.dataset.id;
      const body = { name: get('name'), role: get('role'), manager_id: get('manager_id') || null, department_id: get('department_id') || null, position_id: get('position_id') || null };
      if (!id) body.email = get('email');
      const ok = await mutate(() => (id ? call('PATCH', `/api/members/${id}`, body) : call('POST', '/api/members', body)), id ? 'حُفظ.' : 'أُضيف. انسخ رسالة الدعوة وأرسلها له.');
      if (ok) { if (!id) { form.reset(); S.edit.member = ok.id; if (ok.code) S.codes[ok.id] = ok; } else S.edit.member = null; render(); }
      break;
    }
    case 'position': {
      const id = form.dataset.id;
      const rids = fd.getAll('rid'); const rts = fd.getAll('rt'); const rds = fd.getAll('rd');
      const body = { title: get('title'), department_id: get('department_id') || null, summary: get('summary'), responsibilities: rts.map((t, i) => ({ id: rids[i] || undefined, title: String(t).trim(), detail: String(rds[i] || '').trim() })).filter((r) => r.title) };
      const ok = await mutate(() => (id ? call('PUT', `/api/positions/${id}`, body) : call('POST', '/api/positions', body)), 'حُفظ التوصيف.');
      if (ok) { S.edit.pos = null; render(); }
      break;
    }
    case 'dep': {
      const id = form.dataset.id;
      const ok = await mutate(() => (id ? call('PATCH', `/api/departments/${id}`, { name: get('name') }) : call('POST', '/api/departments', { name: get('name') })), 'حُفظ.');
      if (ok) { S.edit.dep = null; if (!id) form.reset(); render(); }
      break;
    }
    default:
  }
});

/** تعديل في الهيكل: نرسل، ثم نعيد تحميل الصورة الكاملة من الخادم (مصدر الحقيقة الوحيد). */
async function mutate(fn, msg) {
  try { const r = await fn(); await loadBoot(true); drop('audit', 'day|'); toast(msg); return r || true; }
  catch (er) { toast(er.message); return null; }
}

function setTheme(v) {
  const th = ['petrol', 'navy', 'aqua'].includes(v) ? v : 'petrol';
  document.documentElement.dataset.theme = th;
  store.set('it:theme', th);
  $('meta[name=theme-color]')?.setAttribute('content', { petrol: '#062a2f', navy: '#0c1a35', aqua: '#07617a' }[th]);
  render();
}

/* ═════════════ الإقلاع ═════════════ */
async function loadMe() {
  try { S.me = await api('GET', '/api/me'); S.err = null; }
  catch (e) { S.err = e.message; }
  render();
}
async function loadBoot(quiet) {
  try { S.boot = await call('GET', '/api/bootstrap'); }
  catch (e) {
    if (['not-member', 'verify-email', 'need-code'].includes(e.code)) { S.org = null; store.del('it:org'); S.boot = null; await loadMe(); }
    else if (!quiet) S.err = e.message;
    else toast(e.message);
  }
  render();
}

initAuth((u) => {
  const was = S.user?.uid;
  S.user = u || null;
  if (!u) { Object.assign(S, { me: null, boot: null, err: null, draft: {}, dirty: {} }); S.cache.clear(); render(); return; }
  if (was !== u.uid) { S.cache.clear(); S.me = null; S.boot = null; }
  if (u.emailVerified) { loadMe().then(() => { if (S.org && S.me?.orgs.find((o) => o.id === S.org)) loadBoot(); }); }
  render();
}).catch(() => { S.user = null; S.err = 'تعذّر تحميل خدمة الدخول. تحقّق من الاتصال.'; render(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
