// مركز القيادة — التشغيل والأحداث والعرض.
// الشاشات في views.js، والمنطق في model.js، والبيانات والمزامنة في store.js.

import { store } from './store.js';
import { uid, todayKey, keyAdd, n, esc } from './utils.js';
import {
  S, areas, areaById, goalById, taskById, isOpen, createTask, updateTask, toggleTask, focusPatch, FULL_MSG,
  rollover, followedUp, parseQuick, convertSetupFile,
} from './model.js';
import { ui, env, ROUTES, pane, focusView, navItems, quickAdd, fmtClock, I } from './views.js';

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const paneEl = $('#pane');
const fx = $('#focus');
const dlg = $('#dlg');
const isDesk = () => matchMedia('(min-width: 900px)').matches;
let lastDay = todayKey();

/* ═════════════ العرض ═════════════ */
let scheduled = false;
let forcePane = false;

function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.dataset.f) return `[data-f="${el.dataset.f}"]`;
  if (el.dataset.step) return `[data-step="${el.dataset.step}"]`;
  return null;
}

function render() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!store.status.ready) return;
    const active = document.activeElement;
    const key = focusKey(active);
    const sel = active && 'selectionStart' in active ? (() => { try { return [active.selectionStart, active.selectionEnd]; } catch { return null; } })() : null;

    // المحتوى الرئيسي
    view.innerHTML = (ROUTES[ui.route] || ROUTES.today)();
    document.body.classList.toggle('widget-mode', ui.route === 'widget');

    // التنقل الجانبي والسفلي
    const nv = navItems();
    $('#nav').innerHTML = `${nv.smart}<hr />${nv.views}<hr />${nv.lists}<a href="#/settings#areas" class="ni addlist">${I.plus}<span>مجال جديد</span></a>`;
    const here = location.hash.replace(/#areas$/, '') || '#/today';
    document.querySelectorAll('[data-nav]').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === here ? 'page' : 'false'));
    const tabFor = { today: 'today', matrix: 'matrix', goals: 'goals', review: 'review' }[ui.route] || 'lists';
    document.querySelectorAll('.tabbar a').forEach((a) => a.setAttribute('aria-current', a.dataset.route === tabFor ? 'page' : 'false'));

    // لوحة التفاصيل: لا نعيد رسمها أثناء الكتابة فيها
    const t = ui.sel ? taskById(ui.sel) : null;
    if (ui.sel && !t) ui.sel = null;
    const typing = active && paneEl.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && paneEl.dataset.id === ui.sel;
    document.body.classList.toggle('pane-open', !!t);
    if (!typing || forcePane) {
      paneEl.innerHTML = pane(t);
      paneEl.dataset.id = t ? t.id : '';
      autosize($('#p-title'));
    }
    forcePane = false;

    // وضع التركيز
    const ft = ui.focusId ? taskById(ui.focusId) : null;
    if (ui.focusId && !ft) ui.focusId = null;
    if (ft) { fx.innerHTML = focusView(ft); fx.hidden = false; } else { fx.hidden = true; fx.innerHTML = ''; }

    renderSync();
    if (key) {
      const el = $(key);
      if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch {} }
    }
  });
}

function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function renderSync() {
  const el = $('#sync');
  const st = store.status;
  const states = {
    local: ['', 'على هذا الجهاز'],
    'cloud-error': ['error', 'غير متصل'],
    'cloud-signed-out': ['error', 'سجّل الدخول'],
    cloud: st.error ? ['error', 'خطأ مزامنة'] : st.pending || !st.serverConfirmed ? ['pending', 'يزامن…'] : ['ok', 'متزامن'],
  };
  const [state, label] = states[store.mode] || ['', ''];
  el.dataset.state = state;
  el.textContent = label;
}

let toastTimer;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="link" id="toast-undo">تراجع</button>' : ''}`;
  el.classList.add('show');
  if (undo) $('#toast-undo').onclick = () => { undo(); el.classList.remove('show'); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 3200);
}

/* ═════════════ التنقل ═════════════ */
function onRoute() {
  const m = location.hash.match(/^#\/(\w+)(?:\/([^#]+))?/) || [];
  const r = ROUTES[m[1]] ? m[1] : 'today';
  const changed = r !== ui.route || (m[2] || null) !== ui.param;
  ui.route = r;
  ui.param = m[2] ? decodeURIComponent(m[2]) : null;
  if (changed && r !== 'review') ui.weekOffset = 0;
  if (changed) ui.sel = null;
  if (r !== 'search' && changed) { ui.q = ''; const q = $('#q'); if (q) q.value = ''; }
  document.title = r === 'widget' ? 'أولويات اليوم' : 'مركز القيادة';
  render();
  if (changed) window.scrollTo(0, 0);
  if (location.hash.endsWith('#areas')) setTimeout(() => $('#areas')?.scrollIntoView({ block: 'start' }), 50);
}

/* ═════════════ الحوارات ═════════════ */
function openCapture(ctx = {}, title = 'مهمة جديدة') {
  dlg.innerHTML = `<div class="cap"><div class="cap-h"><h2>${title}</h2><button class="ib" data-act="close" aria-label="إغلاق">${I.x}</button></div>${quickAdd({ ...ctx, dialog: '1' }, 'ماذا تريد أن تنجز؟')}</div>`;
  dlg.showModal();
  setTimeout(() => $('#qa', dlg)?.focus(), 30);
}

function openGoalDialog(g = {}) {
  const isNew = !g.id;
  const opt = (sel) => '<option value="">بدون مجال</option>' + areas().map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  dlg.innerHTML = `<form data-form="goal" data-id="${g.id || ''}" class="stack">
    <div class="cap-h"><h2>${isNew ? 'هدف جديد' : 'تعديل الهدف'}</h2><button class="ib" type="button" data-act="close" aria-label="إغلاق">${I.x}</button></div>
    <label class="fld"><span>الهدف</span><input class="in" name="title" value="${esc(g.title || '')}" required maxlength="160" placeholder="نتيجة واضحة يمكن قياسها" /></label>
    <label class="fld"><span>لماذا؟</span><textarea class="in" name="why" rows="3" maxlength="1000" placeholder="ما الذي سيتغيّر إن تحقق؟">${esc(g.why || '')}</textarea></label>
    <div class="two">
      <label class="fld"><span>المجال</span><select class="in" name="areaId">${opt(g.areaId)}</select></label>
      <label class="fld"><span>الموعد المستهدف</span><input class="in" type="date" name="targetDate" value="${esc(g.targetDate || '')}" /></label>
    </div>
    <label class="fld"><span>الحالة</span><select class="in" name="status">
      <option value="active"${!g.status || g.status === 'active' ? ' selected' : ''}>نشط</option>
      <option value="paused"${g.status === 'paused' ? ' selected' : ''}>مؤجل بوعي</option>
      <option value="done"${g.status === 'done' ? ' selected' : ''}>تحقق</option></select></label>
    <div class="row"><button class="btn primary" type="submit">حفظ</button><button class="btn" type="button" data-act="close">إلغاء</button><span class="spacer"></span>
      ${isNew ? '' : `<button class="btn danger" type="button" data-act="del-goal" data-id="${g.id}">حذف</button>`}</div>
  </form>`;
  dlg.showModal();
  setTimeout(() => $('[name=title]', dlg)?.focus(), 30);
}

/* ═════════════ وضع التركيز ═════════════ */
let fxTick = null;
function tick() {
  const T = ui.timer;
  if (!T.running) return;
  T.left = Math.max(0, Math.round((T.endAt - Date.now()) / 1000));
  const time = $('#fx-time');
  const arc = $('#fx-arc');
  if (time) time.textContent = fmtClock(T.left);
  if (arc) { const c = 2 * Math.PI * 92; arc.style.strokeDashoffset = (c * (T.left / T.total)).toFixed(1); }
  document.title = `${fmtClock(T.left)} · تركيز`;
  if (T.left === 0) {
    T.running = false;
    clearInterval(fxTick);
    document.title = 'مركز القيادة';
    chime();
    toast('انتهت الجلسة. خذ خمس دقائق استراحة ثم عد.');
    render();
  }
}
function chime() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((f, i) => {
      const o = ac.createOscillator(); const g = ac.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + i * 0.25 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.25 + 0.5);
      o.start(ac.currentTime + i * 0.25); o.stop(ac.currentTime + i * 0.25 + 0.55);
    });
  } catch {}
}
function endFocus() {
  ui.focusId = null;
  ui.timer.running = false;
  clearInterval(fxTick);
  document.title = 'مركز القيادة';
  render();
}

/* ═════════════ الأحداث ═════════════ */
function setSteps(id, fn) {
  const t = taskById(id);
  if (!t) return;
  const steps = fn((t.steps || []).map((s) => ({ ...s })));
  forcePane = true;
  updateTask(id, { steps });
}

function done(id) {
  const t = taskById(id);
  const wasOpen = t && isOpen(t);
  const msg = toggleTask(id);
  if (wasOpen) { ui.justDone = id; setTimeout(() => { ui.justDone = null; }, 700); }
  if (msg) toast(msg);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || (el.tagName === 'INPUT' && el.type !== 'checkbox')) return;
  if (el.tagName === 'INPUT') return;
  const { act } = el.dataset;
  const id = el.dataset.id || ui.sel;
  switch (act) {
    case 'toggle': done(el.dataset.id); if (el.dataset.end) endFocus(); break;
    case 'open': ui.sel = el.dataset.id; forcePane = true; render(); if (!isDesk()) paneEl.scrollTop = 0; break;
    case 'close-pane': ui.sel = null; render(); break;
    case 'star': { const t = taskById(id); if (t) updateTask(id, { important: !t.important }); break; }
    case 'focus': {
      const fp = focusPatch();
      if (!fp) { toast(FULL_MSG); break; }
      forcePane = true; updateTask(id, fp); toast('أُضيفت إلى أولويات اليوم.');
      break;
    }
    case 'unfocus': forcePane = true; updateTask(id, { focusDate: null }); break;
    case 'followed': forcePane = true; followedUp(id); toast('سُجّلت المتابعة. التالية بعد ٣ أيام.'); break;
    case 'set-due': forcePane = true; updateTask(ui.sel, { due: el.dataset.v || null }); break;
    case 'step-toggle': setSteps(id, (s) => { s[+el.dataset.i].done = !s[+el.dataset.i].done; return s; }); break;
    case 'step-del': setSteps(id, (s) => s.filter((_, i) => i !== +el.dataset.i)); break;
    case 'focus-steps': $('#p-newstep')?.focus(); break;
    case 'focus-assign': $('#p-assignee')?.focus(); break;
    case 'reset-slips': forcePane = true; updateTask(ui.sel, { slips: 0 }); break;
    case 'del-task': {
      const t = taskById(id);
      if (!t) break;
      store.remove('tasks', id);
      ui.sel = null;
      toast('حُذفت المهمة.', () => store.put('tasks', t));
      break;
    }
    case 'start-focus':
      ui.focusId = id;
      ui.timer = { total: ui.timer.total, left: ui.timer.total, running: false, endAt: 0 };
      render();
      break;
    case 'end-focus': endFocus(); break;
    case 'fx-len': if (!ui.timer.running) { const s = +el.dataset.m * 60; ui.timer.total = s; ui.timer.left = s; render(); } break;
    case 'fx-toggle': {
      const T = ui.timer;
      if (T.running) { tick(); T.running = false; clearInterval(fxTick); document.title = 'مركز القيادة'; }
      else { if (T.left === 0) T.left = T.total; T.endAt = Date.now() + T.left * 1000; T.running = true; clearInterval(fxTick); fxTick = setInterval(tick, 500); }
      render();
      break;
    }
    case 'capture': openCapture(ui.route === 'area' ? { area: ui.param } : ui.route === 'list' ? { list: ui.param } : ui.route === 'today' ? { ctx: 'today' } : {}); break;
    case 'new-in-quad': openCapture({ q: el.dataset.q }, 'مهمة في هذا المربع'); break;
    case 'new-for-goal': openCapture({ goal: el.dataset.id }, `خطوة لـ«${goalById(el.dataset.id)?.title || ''}»`); break;
    case 'new-goal': openGoalDialog({}); break;
    case 'edit-goal': openGoalDialog(goalById(el.dataset.id)); break;
    case 'close': dlg.close(); break;
    case 'del-goal':
      if (confirm('حذف الهدف؟ مهامه تبقى لكن بلا هدف.')) {
        S().tasks.filter((t) => t.goalId === el.dataset.id).forEach((t) => updateTask(t.id, { goalId: null }));
        store.remove('goals', el.dataset.id); dlg.close(); toast('حُذف الهدف.');
      }
      break;
    case 'del-area': {
      const a = areaById(el.dataset.id);
      const used = S().tasks.filter((t) => t.areaId === el.dataset.id).length;
      if (confirm(`حذف مجال «${a?.name}»؟${used ? ` ستنتقل ${n(used)} مهمة إلى الوارد.` : ''}`)) {
        S().tasks.filter((t) => t.areaId === el.dataset.id).forEach((t) => updateTask(t.id, { areaId: null }));
        S().goals.filter((g) => g.areaId === el.dataset.id).forEach((g) => store.put('goals', { ...g, areaId: null }));
        store.remove('areas', el.dataset.id);
      }
      break;
    }
    case 'week': ui.weekOffset = Math.min(0, ui.weekOffset + Number(el.dataset.d)); render(); break;
    case 'signout': store.signOut(); break;
    case 'export': exportData(); break;
    case 'install': env.installPrompt?.prompt(); env.installPrompt = null; break;
    case 'open-widget': window.open(`${location.pathname}#/widget`, 'cc-widget', 'width=380,height=560'); break;
    case 'widget-open':
      if (window.opener && !window.opener.closed) { e.preventDefault(); window.opener.focus(); }
      break;
  }
});

/* حقول لوحة التفاصيل تُحفظ تلقائيًا عند التغيير (مثل To Do) */
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'import' && el.files[0]) { importData(el.files[0]).finally(() => { el.value = ''; }); return; }
  if (el.dataset.f && ui.sel) {
    const f = el.dataset.f;
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (f === 'title' && !v) { el.value = taskById(ui.sel)?.title || ''; return; }
    if (['areaId', 'goalId', 'due', 'repeat', 'followUp'].includes(f)) v = v || null;
    forcePane = f !== 'title' && f !== 'notes';
    updateTask(ui.sel, { [f]: v });
    return;
  }
  if (el.dataset.step && ui.sel) {
    const i = +el.dataset.step;
    const v = el.value.trim();
    setSteps(ui.sel, (s) => (v ? (s[i].title = v, s) : s.filter((_, j) => j !== i)));
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset?.draft) ui.drafts[el.dataset.draft] = el.value;
  if (el.classList.contains('ptitle')) autosize(el);
  if (el.id === 'qa') {
    const box = el.closest('form')?.querySelector('.qa-tokens');
    if (box) {
      const p = parseQuick(el.value);
      box.innerHTML = p.tokens.map((t) => `<span class="tok k-${t.k}">${t.k === 'assignee' ? I.user : t.k === 'area' ? `<i style="--c:${esc(t.color)}"></i>` : I.star}${esc(t.v)}</span>`).join('');
    }
  }
  if (el.dataset?.act === 'search') {
    ui.q = el.value;
    if (ui.q.trim() && ui.route !== 'search') location.hash = '#/search';
    else render();
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const get = (k) => (fd.get(k) || '').toString().trim();
  const on = (k) => fd.get(k) === 'on';

  switch (form.dataset.form) {
    case 'quick': {
      const raw = get('title');
      if (!raw) return;
      const p = parseQuick(raw);
      if (!p.title) return toast('اكتب عنوان المهمة.');
      const ds = form.dataset;
      const goal = ds.goal ? goalById(ds.goal) : null;
      const q = ds.q || '';
      const f = {
        title: p.title,
        important: p.important || on('important') || ds.list === 'important' || q === 'q1' || q === 'q2',
        urgent: p.urgent || on('urgent') || q === 'q1' || q === 'q3',
        areaId: p.areaId || ds.area || goal?.areaId || null,
        goalId: goal?.id || null,
        due: get('due') || (ds.list === 'planned' ? todayKey() : null),
        assignee: p.assignee || null,
        assignedAt: p.assignee ? todayKey() : null,
        followUp: p.assignee ? keyAdd(todayKey(), 2) : null,
      };
      let msg = '';
      if (ds.ctx === 'today') {
        const fp = focusPatch();
        if (fp) { Object.assign(f, fp); msg = 'أُضيفت إلى أولويات اليوم.'; }
        else { f.due = f.due || todayKey(); msg = 'الثلاث ممتلئة، فأُضيفت إلى «أيضًا اليوم».'; }
      } else if (ds.list === 'assigned' && !f.assignee) msg = 'أُضيفت. حدّد الشخص من تفاصيلها أو اكتب @الاسم.';
      createTask(f);
      if (f.assignee) msg = `أُسندت إلى ${f.assignee}، والمتابعة بعد يومين.`;
      delete ui.drafts.qa;
      form.reset();
      form.querySelector('.qa-tokens').innerHTML = '';
      if (ds.dialog) dlg.close();
      if (msg) toast(msg);
      render();
      break;
    }
    case 'step': {
      const v = get('title');
      if (!v || !ui.sel) return;
      setSteps(ui.sel, (s) => [...s, { id: uid(), title: v, done: false }]);
      form.reset();
      break;
    }
    case 'goal': {
      const id = form.dataset.id;
      const old = id ? goalById(id) : {};
      const title = get('title');
      if (!title) return;
      store.put('goals', { id: id || uid(), ...old, title, why: get('why'), areaId: get('areaId') || null, targetDate: get('targetDate') || null, status: get('status') || 'active' });
      dlg.close();
      break;
    }
    case 'review': {
      const wk = form.dataset.week;
      const old = S().reviews.find((r) => r.id === wk) || {};
      store.put('reviews', { ...old, id: wk, wins: get('wins'), blockers: get('blockers'), next: get('next') });
      ['wins', 'blockers', 'next'].forEach((k) => delete ui.drafts[`rv-${wk}-${k}`]);
      toast('حُفظت المراجعة.');
      break;
    }
    case 'name': try { localStorage.setItem('cc:name', get('name')); } catch {} toast('حُفظ.'); render(); break;
    case 'area': {
      const a = areaById(form.dataset.id);
      if (a && get('name')) { store.put('areas', { ...a, name: get('name'), color: get('color') }); toast('حُفظ المجال.'); }
      break;
    }
    case 'new-area': {
      if (!get('name')) return;
      const order = Math.max(0, ...S().areas.map((a) => a.order || 0)) + 1;
      store.put('areas', { id: uid(), name: get('name'), color: get('color'), order });
      form.reset();
      break;
    }
    case 'auth': {
      const op = e.submitter?.value || 'in';
      const email = get('email');
      const pass = fd.get('password') || '';
      const msgs = {
        'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة.',
        'auth/email-already-in-use': 'هذا البريد مسجّل. استخدم «دخول».',
        'auth/weak-password': 'كلمة المرور قصيرة (٦ أحرف على الأقل).',
        'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت.',
        'auth/operation-not-allowed': 'إنشاء الحسابات مغلق في إعدادات Firebase.',
        'auth/admin-restricted-operation': 'إنشاء الحسابات مغلق في إعدادات Firebase.',
        'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.',
      };
      const fail = (err) => toast(msgs[err.code] || `تعذّر الإجراء (${err.code || err.message}).`);
      if (op === 'reset') {
        if (!email) return toast('اكتب بريدك أولًا.');
        store.resetPassword(email).then(() => toast('أُرسل رابط إعادة التعيين إلى بريدك.'), fail);
      } else {
        (op === 'up' ? store.signUp(email, pass) : store.signIn(email, pass)).then(() => toast('تم الدخول. جارٍ المزامنة…'), fail);
      }
      break;
    }
  }
});

dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (e.key === 'Escape') {
    if (ui.focusId) { endFocus(); return; }
    if (dlg.open) return;
    if (ui.sel) { ui.sel = null; render(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || dlg.open) return;
  if (e.code === 'KeyN') { e.preventDefault(); const qa = $('#qa', view); if (qa && isDesk()) qa.focus(); else openCapture(ui.route === 'today' ? { ctx: 'today' } : {}); }
  if (e.code === 'Slash') { e.preventDefault(); if (isDesk()) $('#q').focus(); else location.hash = '#/lists'; }
});

/* سحب المهام بين مربعات المصفوفة */
document.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('li.t[draggable]');
  if (!li) return;
  e.dataTransfer.setData('text/plain', li.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  li.classList.add('dragging');
});
document.addEventListener('dragend', (e) => e.target.classList?.remove('dragging'));
document.addEventListener('dragover', (e) => {
  const q = e.target.closest?.('[data-quad]');
  if (!q) return;
  e.preventDefault();
  document.querySelectorAll('.quad.over').forEach((x) => x !== q && x.classList.remove('over'));
  q.classList.add('over');
});
document.addEventListener('dragleave', (e) => {
  const q = e.target.closest?.('[data-quad]');
  if (q && !q.contains(e.relatedTarget)) q.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  const q = e.target.closest?.('[data-quad]');
  if (!q) return;
  e.preventDefault();
  q.classList.remove('over');
  const id = e.dataTransfer.getData('text/plain');
  const k = q.dataset.quad;
  if (id) updateTask(id, { important: k === 'q1' || k === 'q2', urgent: k === 'q1' || k === 'q3' });
});

/* ═════════════ النسخ الاحتياطي والاستيراد ═════════════ */
function exportData() {
  const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `command-center-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** ملف الإعداد القديم: كل مجالاته تُوزّع على مجالاتك الثلاثة الحالية. */
function setupAreaMap(domains) {
  const find = (word) => areas().find((a) => a.name.includes(word))?.id || null;
  const asas = find('أسس');
  const joby = find('الجوبي');
  const personal = find('شخصي');
  const map = {};
  for (const d of domains) {
    map[d.id] = d.name.includes('الجوبي') ? joby : /شخصي|التطوير المهني/.test(d.name) ? personal : asas;
  }
  return map;
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app === 'command-center') {
      const count = (data.tasks || []).length;
      if (!confirm(`استيراد ${n(count)} مهمة سيستبدل كل البيانات الحالية. متابعة؟`)) return;
      store.importAll(data);
      toast('تم الاستيراد.');
      return;
    }
    if (Array.isArray(data.domains) && Array.isArray(data.tasks)) {
      const { goals, tasks } = convertSetupFile(data, setupAreaMap(data.domains));
      const haveG = new Set(S().goals.map((g) => g.id));
      const haveT = new Set(S().tasks.map((t) => t.id));
      const newG = goals.filter((g) => !haveG.has(g.id));
      const newT = tasks.filter((t) => !haveT.has(t.id));
      if (!newG.length && !newT.length) { toast('هذا الملف مُستورد من قبل.'); return; }
      if (!confirm(`دمج ${n(newT.length)} مهمة و${n(newG.length)} أهداف مع بياناتك الحالية دون حذف شيء. متابعة؟`)) return;
      newG.forEach((g) => store.put('goals', g));
      newT.forEach((t) => store.put('tasks', t));
      toast(`أُضيفت ${n(newT.length)} مهمة و${n(newG.length)} أهداف.`);
      return;
    }
    throw new Error('unknown');
  } catch {
    toast('الملف ليس نسخة احتياطية صالحة لمركز القيادة.');
  }
}

/* ═════════════ التشغيل ═════════════ */
function checkDay() {
  if (todayKey() !== lastDay) {
    lastDay = todayKey();
    if (store.status.ready) { const k = rollover(); if (k) toast(`عادت ${n(k)} من أولويات الأمس إلى قوائمها. اختر ثلاث اليوم من جديد.`); }
    render();
  }
}

let rolledFor = null;
store.subscribe((state, status) => {
  const source = store.mode === 'cloud' ? store.user?.uid : 'local';
  if (rolledFor !== source && status.ready && (store.mode !== 'cloud' || status.serverConfirmed)) {
    rolledFor = source;
    const k = rollover();
    if (k) toast(`عادت ${n(k)} من أولويات الأمس لم تُنجز. اختر ثلاث اليوم من جديد.`);
  }
  render();
});

window.addEventListener('hashchange', onRoute);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkDay(); if (ui.timer.running) tick(); } });
setInterval(checkDay, 60_000);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); env.installPrompt = e; if (ui.route === 'settings') render(); });
matchMedia('(min-width: 900px)').addEventListener('change', render);

onRoute();
store.boot().catch((e) => { console.error(e); view.innerHTML = '<p class="loading">تعذّر تشغيل التطبيق.</p>'; });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
