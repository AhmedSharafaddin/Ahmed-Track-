// مركز القيادة — التشغيل والأحداث والعرض.
// الشاشات في views.js، والمنطق في model.js، والبيانات والمزامنة في store.js،
// ومكوّنات الاختيار في picker.js، والتنبيهات في notify.js.

import { store } from './store.js';
import { uid, todayKey, keyAdd, n, esc, fmtTime, relDay, isDateKey } from './utils.js';
import {
  S, areas, areaById, goalById, taskById, isOpen, createTask, updateTask, toggleTask, focusPatch, FULL_MSG,
  rollover, followedUp, parseQuick, convertSetupFile, settings, saveSettings, snooze, dayLoads,
  setWaiting,
} from './model.js';
import { ui, env, ROUTES, pane, focusView, navItems, quickAdd, fmtClock, I, commitSheet } from './views.js';
import { notify } from './notify.js';

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const paneEl = $('#pane');
const navEl = $('#nav');
const fx = $('#focus');
const dlg = $('#dlg');
const isDesk = () => matchMedia('(min-width: 900px)').matches;
let lastDay = todayKey();

/* ═════════════ العرض ═════════════
   • كل التحديثات في إطار رسم واحد (requestAnimationFrame) مهما تعددت التغييرات.
   • لا نلمس DOM إن لم يتغيّر الناتج (مقارنة نصية رخيصة مقابل إعادة بناء مكلفة).
   • تغيّر حالة المزامنة فقط لا يعيد رسم الشاشة. */
let scheduled = false;
let forcePane = false;
const last = { view: '', nav: '', pane: '', route: '', fx: '' };

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
  requestAnimationFrame(paint);
}

function paint() {
  scheduled = false;
  if (!store.status.ready) return;
  const active = document.activeElement;
  const key = focusKey(active);
  let sel = null;
  try { if (active && 'selectionStart' in active && active.selectionStart != null) sel = [active.selectionStart, active.selectionEnd]; } catch {}

  const html = (ROUTES[ui.route] || ROUTES.today)();
  if (html !== last.view) { view.innerHTML = html; last.view = html; }
  document.body.classList.toggle('widget-mode', ui.route === 'widget');
  document.body.dataset.route = ui.route;
  document.body.classList.add('ready');

  const nv = navItems();
  const navHtml = `${nv.grp('مركز التحكم')}${nv.ctrl}${nv.grp('القوائم الذكية')}${nv.smart}${nv.grp('أدوات')}${nv.views}${nv.grp('المجالات')}${nv.lists}<a href="#/settings#areas" class="ni addlist">${I('plus')}<span>مجال جديد</span></a>`;
  if (navHtml !== last.nav) { navEl.innerHTML = navHtml; last.nav = navHtml; }
  const here = location.hash.replace(/#areas$/, '').replace(/\?.*$/, '') || '#/today';
  if (here !== last.route) {
    last.route = here;
    document.querySelectorAll('[data-nav]').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === here ? 'page' : 'false'));
    const tabFor = { today: 'today', matrix: 'matrix', goals: 'goals', dashboard: 'dashboard', review: 'dashboard' }[ui.route] || 'lists';
    document.querySelectorAll('.tabbar a').forEach((a) => a.setAttribute('aria-current', a.dataset.route === tabFor ? 'page' : 'false'));
  } else {
    navEl.querySelectorAll('[data-nav]').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === here ? 'page' : 'false'));
  }

  // لوحة التفاصيل: لا نعيد رسمها أثناء الكتابة فيها
  const t = ui.sel ? taskById(ui.sel) : null;
  if (ui.sel && !t) ui.sel = null;
  document.body.classList.toggle('pane-open', !!t);
  const typing = active && paneEl.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && paneEl.dataset.id === ui.sel;
  if (!typing || forcePane) {
    const ph = pane(t);
    if (ph !== last.pane) { paneEl.innerHTML = ph; last.pane = ph; autosize($('#p-title')); }
    paneEl.dataset.id = t ? t.id : '';
  }
  forcePane = false;

  const ft = ui.focusId ? taskById(ui.focusId) : null;
  if (ui.focusId && !ft) ui.focusId = null;
  if (ft) {
    const fh = focusView(ft);
    const opening = fx.hidden;
    if (last.fx !== fh) { fx.innerHTML = fh; last.fx = fh; }
    fx.hidden = false;
    setInert(true);
    if (opening) setTimeout(() => $('.fx-go', fx)?.focus(), 30);
  } else if (!fx.hidden) { fx.hidden = true; fx.innerHTML = ''; last.fx = ''; setInert(false); }

  renderSync();
  if (key) {
    const el = $(key);
    if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch {} }
  }
}

/** وضع التركيز نافذة كاملة: ما خلفه لا يُركَّز عليه بلوحة المفاتيح ولا يقرؤه قارئ الشاشة. */
function setInert(on) {
  for (const sel of ['.shell', '.tabbar', '.fab']) { const el = $(sel); if (el) el.inert = on; }
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
    cloud: st.error ? ['error', 'خطأ مزامنة'] : st.booting ? (st.offline ? ['error', 'دون اتصال'] : ['pending', 'يتصل…']) : st.pending || !st.serverConfirmed ? ['pending', 'يزامن…'] : ['ok', 'متزامن'],
  };
  const [state, label] = states[store.mode] || ['', ''];
  if (el.dataset.state !== state) el.dataset.state = state;
  if (el.textContent !== label) el.textContent = label;
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
let pendingTask = null; // مهمة مطلوبة من تنبيه قبل وصول البيانات
function onRoute() {
  const h = location.hash;
  const tm = h.match(/^#\/task\/([^?#]+)(?:\?a=(\w+))?/);
  if (tm) {
    pendingTask = { id: decodeURIComponent(tm[1]), a: tm[2] || '' };
    history.replaceState(null, '', '#/today');
    handlePendingTask();
  }
  const m = location.hash.match(/^#\/(\w+)(?:\/([^#?]+))?/) || [];
  const r = ROUTES[m[1]] ? m[1] : 'today';
  const changed = r !== ui.route || (m[2] || null) !== ui.param;
  ui.route = r;
  ui.param = m[2] ? decodeURIComponent(m[2]) : null;
  if (changed && r !== 'review') ui.weekOffset = 0;
  if (changed && !tm) ui.sel = null;
  if (r !== 'search' && changed) { ui.q = ''; const q = $('#q'); if (q) q.value = ''; }
  document.title = r === 'widget' ? 'أولويات اليوم' : 'مركز القيادة';
  render();
  if (changed) window.scrollTo(0, 0);
  if (location.hash.endsWith('#areas')) setTimeout(() => $('#areas')?.scrollIntoView({ block: 'start' }), 60);
}

/** فتح مهمة من تنبيه: «ابدأ» ⇒ وضع التركيز، «أجّل» ⇒ تأجيل، وإلا لحظة القرار. */
function handlePendingTask() {
  if (!pendingTask || !store.status.ready) return;
  const t = taskById(pendingTask.id);
  if (!t) return; // ننتظر وصول البيانات من المزامنة
  const { a } = pendingTask;
  pendingTask = null;
  if (!isOpen(t)) { toast('هذه المهمة أُنجزت بالفعل.'); return; }
  if (a === 'start') { startFocus(t.id); return; }
  if (a === 'snooze') { toast(snooze(t.id, 15)); return; }
  ui.sel = isDesk() ? t.id : null;
  dlg.innerHTML = commitSheet(t);
  dlg.classList.add('commit-dlg');
  dlg.showModal();
  setTimeout(() => $('[data-act="commit-start"]', dlg)?.focus(), 30);
}

/* ═════════════ الحوارات ═════════════ */
function openCapture(ctx = {}, title = 'مهمة جديدة') {
  dlg.classList.remove('commit-dlg');
  delete ui.drafts['qa-d'];
  delete ui.drafts['qa-d:date'];
  dlg.innerHTML = `<div class="cap"><div class="cap-h"><h2>${esc(title)}</h2><button class="ib" data-act="close" aria-label="إغلاق">${I('x')}</button></div>${quickAdd({ ...ctx, dialog: '1' }, 'ماذا تريد أن تنجز؟', 'qa-d')}</div>`;
  dlg.showModal();
  setTimeout(() => $('#qa-d', dlg)?.focus(), 30);
}

function openGoalDialog(g = {}) {
  const isNew = !g.id;
  dlg.classList.remove('commit-dlg');
  const opt = (sel) => '<option value="">بدون مجال</option>' + areas().map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${a.emoji ? `${esc(a.emoji)} ` : ''}${esc(a.name)}</option>`).join('');
  dlg.innerHTML = `<form data-form="goal" data-id="${g.id || ''}" class="stack">
    <div class="cap-h"><h2>${isNew ? 'هدف جديد' : 'تعديل الهدف'}</h2><button class="ib" type="button" data-act="close" aria-label="إغلاق">${I('x')}</button></div>
    <div class="goal-title">
      <button type="button" class="emo-btn big" data-act="goal-emoji" aria-label="رمز الهدف">${g.emoji ? esc(g.emoji) : I('smiley')}</button>
      <input type="hidden" name="emoji" value="${esc(g.emoji || '')}" />
      <label class="fld"><span>الهدف</span><input class="in" name="title" value="${esc(g.title || '')}" required maxlength="160" placeholder="نتيجة واضحة يمكن قياسها" /></label>
    </div>
    <label class="fld"><span>لماذا؟</span><textarea class="in" name="why" rows="3" maxlength="1000" placeholder="ما الذي سيتغيّر إن تحقق؟">${esc(g.why || '')}</textarea></label>
    <div class="two">
      <label class="fld"><span>المجال</span><select class="in" name="areaId">${opt(g.areaId)}</select></label>
      <div class="fld"><span>الموعد المستهدف</span><input type="hidden" name="targetDate" value="${esc(g.targetDate || '')}" />
        <button type="button" class="in pick-btn" data-act="goal-date">${I('cal')}<span>${g.targetDate ? relDay(g.targetDate) : 'اختر تاريخًا'}</span></button></div>
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

/** منتقي التاريخ والرمز يُحمَّل عند أول استخدام فقط (لا يثقل الفتح). */
const openDatePicker = (o) => import('./picker.js').then((m) => m.openDatePicker(o));
const openEmojiPicker = (o) => import('./picker.js').then((m) => m.openEmojiPicker(o));
const pickerBase = () => ({ loads: dayLoads(), capacity: (Number(settings().capacity) || 6) * 60 });

/* ═════════════ وضع التركيز ═════════════ */
let fxTick = null;
/** قياس الوقت الفعلي: كل فترة تشغيل في وضع التركيز تُضاف لمهمتها (دقائق) مع سجل يومي مختصر. */
function logFocus() {
  const T = ui.timer;
  if (!T.runFrom || !ui.focusId) return;
  const secs = (Math.min(Date.now(), T.endAt || Date.now()) - T.runFrom) / 1000;
  T.runFrom = 0;
  const min = Math.round(secs / 60);
  const t = taskById(ui.focusId);
  if (!t || min < 1) return;
  const day = todayKey();
  const log = (Array.isArray(t.focusLog) ? t.focusLog.filter((x) => Array.isArray(x)) : []).slice(-29);
  if (log.length && log[log.length - 1][0] === day) log[log.length - 1] = [day, log[log.length - 1][1] + min]; else log.push([day, min]);
  updateTask(t.id, { spent: (t.spent || 0) + min, focusLog: log });
}

function startFocus(id) {
  if (ui.focusId && ui.focusId !== id) logFocus();
  ui.focusId = id;
  ui.timer = { total: ui.timer.total, left: ui.timer.total, running: false, endAt: 0 };
  render();
}
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
    logFocus();
    T.running = false;
    clearInterval(fxTick);
    document.title = 'مركز القيادة';
    chime();
    toast('انتهت الجلسة. خذ خمس دقائق استراحة ثم عد.');
    last.fx = '';
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
  if (ui.timer.running) logFocus();
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

/** تعبئة حقول الموعد المخفية في نموذج الإضافة السريعة، وعرضها على الزر. */
function setQuickDate(form, v) {
  ui.drafts[`${form.dataset.qid}:date`] = v.date ? v : null;
  const vals = { due: v.date, time: v.time, remind: v.remind, intent: v.intent };
  for (const k of Object.keys(vals)) form.elements[k].value = vals[k] ?? '';
  const btn = form.querySelector('.qa-date');
  btn.classList.toggle('on', !!v.date);
  btn.querySelector('span').textContent = v.date ? `${relDay(v.date)}${v.time ? ` ${fmtTime(v.time)}` : ''}${v.remind != null ? ' 🔔' : ''}` : 'موعد';
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const { act } = el.dataset;
  const id = el.dataset.id || ui.sel;
  switch (act) {
    case 'toggle': if (el.dataset.end && ui.timer.running) { tick(); logFocus(); ui.timer.running = false; } done(el.dataset.id); if (el.dataset.end) endFocus(); break;
    case 'open': ui.sel = el.dataset.id; forcePane = true; render(); if (!isDesk()) paneEl.scrollTop = 0; break;
    case 'close-pane': ui.sel = null; render(); break;
    case 'waiting': { const t = taskById(id); if (t) { const on = t.status !== 'waiting'; forcePane = true; setWaiting(id, on); toast(on ? 'سُجّلت بانتظار الاعتماد. لن تُحسب متأخرة عليك.' : 'أُعيدت مفتوحة.'); } break; }
    case 'theme': setTheme(el.dataset.v); break;
    case 'star': { const t = taskById(id); if (t) updateTask(id, { important: !t.important }); break; }
    case 'focus': {
      const fp = focusPatch();
      if (!fp) { toast(FULL_MSG); break; }
      forcePane = true; updateTask(id, fp); toast('أُضيفت إلى أولويات اليوم.');
      break;
    }
    case 'unfocus': forcePane = true; updateTask(id, { focusDate: null }); break;
    case 'followed': forcePane = true; followedUp(id); toast('سُجّلت المتابعة. التالية بعد 3 أيام.'); break;
    case 'voice': {
      const ctx = el.closest('form')?.dataset || {};
      if (dlg.open) dlg.close();
      import('./ai.js').then((m) => { const st = m.aiState(); if (st !== 'ok') { toast(m.AI_MSG[st]); return; } m.openVoice({ dlg, I, toast, ctx: { area: ctx.area || (ui.route === 'area' ? ui.param : null), ctx: ctx.ctx } }); });
      break;
    }
    case 'minutes': import('./ai.js').then((m) => m.openMinutes({ dlg, I, toast, id: el.dataset.id, go: (h) => { location.hash = h; } })); break;
    case 'meeting-toggle': { const t = taskById(id); if (t) { forcePane = true; const on = t.kind !== 'meeting'; updateTask(id, on ? { kind: 'meeting', duration: t.duration || 60, remind: t.time && t.remind == null ? 15 : t.remind } : { kind: null }); } break; }
    case 'set-dur': forcePane = true; updateTask(ui.sel, { duration: Number(el.dataset.v) }); break;
    case 'ics': { const t = taskById(id); if (t) downloadIcs(t); break; }
    case 'print': window.print(); break;
    case 'set-est': { const t = taskById(ui.sel); const v = Number(el.dataset.v); forcePane = true; updateTask(ui.sel, { est: t?.est === v ? null : v }); break; }
    case 'pick-due': {
      const t = taskById(ui.sel);
      if (!t) break;
      openDatePicker({
        ...pickerBase(), title: 'الموعد والتذكير',
        value: { date: t.due, time: t.time, remind: t.remind, intent: t.intent },
        onSave: (v) => { forcePane = true; updateTask(t.id, { due: v.date, time: v.date ? v.time : null, remind: v.date ? v.remind : null, intent: v.intent || '' }); if (v.remind != null) maybeAskNotify(); },
      });
      break;
    }
    case 'pick-follow': {
      const t = taskById(ui.sel);
      if (!t) break;
      openDatePicker({ ...pickerBase(), mode: 'date', title: `متى تتابع مع ${t.assignee}؟`, value: { date: t.followUp }, onSave: (v) => { forcePane = true; updateTask(t.id, { followUp: v.date }); } });
      break;
    }
    case 'qa-date': {
      const qid = el.closest('form').dataset.qid;
      const f = el.closest('form').elements;
      openDatePicker({
        ...pickerBase(), title: 'موعد المهمة الجديدة',
        value: { date: f.due.value || null, time: f.time.value || null, remind: f.remind.value === '' ? null : f.remind.value === 'morning' ? 'morning' : Number(f.remind.value), intent: f.intent.value },
        // النموذج قد يُعاد رسمه أثناء فتح المنتقي (مزامنة) ⇒ نبحث عن النسخة الحالية منه
        onSave: (v) => {
          const input = document.getElementById(qid);
          if (input) { setQuickDate(input.closest('form'), v); input.focus(); } else ui.drafts[`${qid}:date`] = v.date ? v : null;
        },
      });
      break;
    }
    case 'step-toggle': setSteps(id, (s) => { s[+el.dataset.i].done = !s[+el.dataset.i].done; return s; }); break;
    case 'step-del': setSteps(id, (s) => s.filter((_, i) => i !== +el.dataset.i)); break;
    case 'focus-steps': $('#p-newstep')?.focus(); break;
    case 'focus-assign': $('#p-assignee')?.focus(); break;
    case 'reset-slips': forcePane = true; updateTask(ui.sel, { slips: 0, snoozes: 0 }); break;
    case 'del-task': {
      const t = taskById(id);
      if (!t) break;
      store.remove('tasks', id);
      ui.sel = null;
      toast('حُذفت المهمة.', () => store.put('tasks', t));
      break;
    }
    case 'start-focus': startFocus(id); break;
    case 'end-focus': endFocus(); break;
    case 'fx-len': if (!ui.timer.running) { const s = +el.dataset.m * 60; ui.timer.total = s; ui.timer.left = s; render(); } break;
    case 'fx-toggle': {
      const T = ui.timer;
      if (T.running) { tick(); logFocus(); T.running = false; clearInterval(fxTick); document.title = 'مركز القيادة'; }
      else { if (T.left === 0) T.left = T.total; T.endAt = Date.now() + T.left * 1000; T.runFrom = Date.now(); T.running = true; clearInterval(fxTick); fxTick = setInterval(tick, 500); }
      render();
      break;
    }
    case 'commit-start': dlg.close(); startFocus(el.dataset.id); break;
    case 'commit-snooze': dlg.close(); toast(snooze(el.dataset.id, el.dataset.v === 'tomorrow' ? 'tomorrow' : Number(el.dataset.v))); break;
    case 'commit-done': dlg.close(); done(el.dataset.id); break;
    case 'capture': openCapture(ui.route === 'area' ? { area: ui.param } : ui.route === 'list' ? { list: ui.param } : ui.route === 'today' ? { ctx: 'today' } : {}); break;
    case 'new-in-quad': openCapture({ q: el.dataset.q }, 'مهمة في هذا المربع'); break;
    case 'new-for-goal': openCapture({ goal: el.dataset.id }, `خطوة لـ«${goalById(el.dataset.id)?.title || ''}»`); break; // يُهرَّب داخل openCapture
    case 'new-goal': openGoalDialog({}); break;
    case 'edit-goal': openGoalDialog(goalById(el.dataset.id)); break;
    case 'goal-emoji': {
      const form = el.closest('form');
      openEmojiPicker({ value: form.elements.emoji.value, title: 'رمز الهدف', onPick: (v) => { form.elements.emoji.value = v || ''; el.innerHTML = v ? esc(v) : I('smiley'); } });
      break;
    }
    case 'goal-date': {
      const form = el.closest('form');
      openDatePicker({ ...pickerBase(), mode: 'date', title: 'الموعد المستهدف', value: { date: form.elements.targetDate.value || null },
        onSave: (v) => { form.elements.targetDate.value = v.date || ''; el.querySelector('span').textContent = v.date ? relDay(v.date) : 'اختر تاريخًا'; } });
      break;
    }
    case 'edit-area-emoji': {
      const a = areaById(el.dataset.id);
      if (a) openEmojiPicker({ value: a.emoji || '', title: `رمز «${a.name}»`, onPick: (v) => store.put('areas', { ...a, emoji: v || null }) });
      break;
    }
    case 'area-color': { const a = areaById(el.dataset.id); if (a) store.put('areas', { ...a, color: el.dataset.v }); break; }
    case 'set-capacity': saveSettings({ capacity: Number(el.dataset.v) }); break;
    case 'notify-on':
      notify.enable().then((r) => {
        toast({ granted: 'فُعّلت التنبيهات.', denied: 'رُفض الإذن. فعّله من إعدادات المتصفح.', 'server-failed': 'فُعّلت محليًا، وتعذّر ربط خادم التنبيهات الآن.', unsupported: 'هذا المتصفح لا يدعم التنبيهات.' }[r] || 'لم تُفعّل التنبيهات.');
        last.view = ''; render();
      });
      break;
    case 'notify-off': notify.disable().then(() => { toast('أُوقفت التنبيهات على هذا الجهاز.'); last.view = ''; render(); }); break;
    case 'notify-test': notify.test().then((r) => toast(r.devices ? `أُرسل لـ${n(r.devices)} ${r.devices === 1 ? 'جهاز' : 'أجهزة'}.` : 'لا أجهزة مربوطة.')).catch(() => toast('تعذّر الاتصال بخادم التنبيهات.')); break;
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
    case 'signout':
      // قبل الخروج: إيقاف تنبيهات هذا الحساب على الجهاز، ومسح نسخته المحفوظة منه
      notify.disable().finally(() => { store.forgetDevice(); store.signOut(); toast('سُجّل الخروج، ومُسحت بيانات الحساب من هذا الجهاز.'); });
      break;
    case 'export': exportData(); break;
    case 'install': env.installPrompt?.prompt(); env.installPrompt = null; break;
    case 'check-update':
      if (!env.swReg) { toast('التحديث التلقائي غير متاح في هذا المتصفح.'); break; }
      toast('جارٍ البحث عن تحديث…');
      env.swReg.update()
        .then(() => { if (!env.swReg.installing && !env.swReg.waiting) toast('لديك أحدث إصدار.'); })
        .catch(() => toast('تعذّر الاتصال. حاول لاحقًا.'));
      break;
    case 'open-widget': window.open(`${location.pathname}#/widget`, 'cc-widget', 'width=380,height=560'); break;
    case 'widget-open':
      if (window.opener && !window.opener.closed) { e.preventDefault(); window.opener.focus(); }
      break;
  }
});

/** أول مرة يضبط فيها تذكيرًا: نعرض تفعيل التنبيهات في لحظة الحاجة لا قبلها. */
function maybeAskNotify() {
  if (!notify.supported || notify.permission !== 'default' || notify.needsInstall) return;
  toast('لن يصلك التذكير قبل تفعيل التنبيهات.', null);
  const el = $('#toast');
  const b = document.createElement('button');
  b.className = 'link';
  b.textContent = 'فعّلها الآن';
  b.onclick = () => { el.classList.remove('show'); notify.enable().then((r) => toast(r === 'granted' ? 'فُعّلت التنبيهات.' : 'لم تُفعّل التنبيهات.')); };
  el.appendChild(b);
}

/* حقول لوحة التفاصيل تُحفظ تلقائيًا عند التغيير */
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'import' && el.files[0]) { importData(el.files[0]).finally(() => { el.value = ''; }); return; }
  if (el.dataset.tf) {
    if (el.dataset.tf === 'status') { location.hash = el.value === 'open' ? '#/all' : `#/all/${el.value}`; return; }
    if (el.dataset.tf !== 'q') { ui.tf[el.dataset.tf] = el.value; render(); }
    return;
  }
  if (el.dataset.set) { saveSettings({ [el.dataset.set]: el.value || null }); return; }
  if (el.dataset.f && ui.sel) {
    const f = el.dataset.f;
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (f === 'title' && !v) { el.value = taskById(ui.sel)?.title || ''; return; }
    if (['areaId', 'goalId', 'due', 'repeat', 'followUp', 'place'].includes(f)) v = v || null;
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
  if (el.classList.contains('qa-in')) {
    const box = el.closest('form')?.querySelector('.qa-tokens');
    if (box) {
      const p = parseQuick(el.value);
      box.innerHTML = p.tokens.map((t) => `<span class="tok k-${t.k}">${t.k === 'assignee' ? I('user') : t.k === 'area' ? (t.emoji ? esc(t.emoji) : `<i style="--c:${esc(t.color)}"></i>`) : I('star', 'f')}${esc(t.v)}</span>`).join('');
    }
  }
  if (el.dataset?.tf === 'q') { ui.tf.q = el.value; render(); return; }
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
      const rem = get('remind');
      const f = {
        title: p.title,
        important: p.important || on('important') || ds.list === 'important' || q === 'q1' || q === 'q2',
        urgent: p.urgent || on('urgent') || q === 'q1' || q === 'q3',
        areaId: p.areaId || ds.area || goal?.areaId || null,
        goalId: goal?.id || null,
        due: get('due') || (ds.list === 'planned' ? todayKey() : null),
        time: get('time') || null,
        remind: rem === '' ? null : rem === 'morning' ? 'morning' : Number(rem),
        intent: get('intent'),
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
      delete ui.drafts[form.dataset.qid];
      form.reset();
      setQuickDate(form, {});
      form.querySelector('.qa-tokens').innerHTML = '';
      if (ds.dialog) dlg.close();
      if (msg) toast(msg);
      if (f.remind != null) maybeAskNotify();
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
    case 'catch': {
      const v = get('title');
      if (!v) return;
      createTask({ title: v });
      form.reset();
      toast('سُجّلت في الوارد. عد لتركيزك.');
      break;
    }
    case 'goal': {
      const id = form.dataset.id;
      const old = id ? goalById(id) : {};
      const title = get('title');
      if (!title) return;
      store.put('goals', { id: id || uid(), ...old, title, emoji: get('emoji') || null, why: get('why'), areaId: get('areaId') || null, targetDate: get('targetDate') || null, status: get('status') || 'active' });
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
    case 'name': saveSettings({ name: get('name') }); try { localStorage.setItem('cc:name', get('name')); } catch {} toast('حُفظ.'); break;
    case 'area': {
      const a = areaById(form.dataset.id);
      if (a && get('name')) { store.put('areas', { ...a, name: get('name') }); toast('حُفظ المجال.'); }
      break;
    }
    case 'new-area': {
      if (!get('name')) return;
      const order = Math.max(0, ...S().areas.map((a) => a.order || 0)) + 1;
      const colors = ['#2f9474', '#a2782d', '#6e7abf', '#b6675a', '#2b8bb3', '#728b41', '#986cab', '#b06e3e', '#009394', '#b3647e'];
      store.put('areas', { id: uid(), name: get('name'), color: colors[S().areas.length % colors.length], emoji: null, order });
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
        'auth/weak-password': 'كلمة المرور قصيرة (6 أحرف على الأقل).',
        'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت.',
        'auth/operation-not-allowed': 'إنشاء الحسابات مغلق في إعدادات Firebase.',
        'auth/admin-restricted-operation': 'إنشاء الحسابات مغلق في إعدادات Firebase.',
        'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.',
      };
      const fail = (err) => toast(msgs[err.code] || `تعذّر الإجراء (${err.code || err.message}).`);
      if (!store.cloud) return toast('خدمة المزامنة لم تُحمّل بعد. تأكد من الاتصال وحاول بعد لحظات.');
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
    if (document.querySelector('dialog[open]')) return;
    if (ui.sel) { ui.sel = null; render(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || document.querySelector('dialog[open]')) return;
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

function setupAreaMap(domains) {
  const find = (word) => areas().find((a) => a.name.includes(word))?.id || null;
  const asas = find('أسس');
  const joby = find('الجوبي');
  const personal = find('شخصي');
  const map = {};
  for (const d of domains) map[d.id] = d.name.includes('الجوبي') ? joby : /شخصي|التطوير المهني/.test(d.name) ? personal : asas;
  return map;
}

/** تنقية ملف مستورد: معرّفات آمنة، تواريخ صحيحة، ونصوص فقط — لا شيء يُدرج في الصفحة كما هو. */
const SAFE_ID = /^[\w-]{1,100}$/;
/** ملف تقويم (ICS) يفتحه تقويم الآيفون أو Outlook: الاجتماع بوقته ومدته وتنبيه قبل ١٥ دقيقة. */
function downloadIcs(t) {
  if (!t.due) { toast('حدّد موعد الاجتماع أولًا.'); return; }
  const e = (x) => String(x || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const d = t.due.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const when = t.time
    ? [`DTSTART:${d}T${t.time.replace(':', '')}00`, `DURATION:PT${t.duration || 60}M`]
    : [`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${keyAdd(t.due, 1).replace(/-/g, '')}`];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ahmed-Track//AR', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${t.id}@ahmed-track`, `DTSTAMP:${stamp}`, ...when, `SUMMARY:${e(t.title)}`,
    ...(t.place ? [`LOCATION:${e(t.place)}`] : []), ...(t.notes ? [`DESCRIPTION:${e(t.notes.slice(0, 1000))}`] : []),
    ...(t.time ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${e(t.title)}`, 'TRIGGER:-PT15M', 'END:VALARM'] : []),
    'END:VEVENT', 'END:VCALENDAR'];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'meeting'}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast('افتح الملف ثم «إضافة إلى التقويم».');
}

function setTheme(v) {
  const th = ['green', 'exec'].includes(v) ? v : 'dar';
  env.theme = th;
  document.documentElement.dataset.theme = th;
  try { localStorage.setItem('cc:theme', th); } catch {}
  last.view = ''; render();
}

function sanitize(data) {
  const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const date = (v) => (isDateKey(v) ? v : null);
  const out = {};
  for (const c of ['areas', 'goals', 'tasks', 'reviews']) {
    out[c] = (Array.isArray(data[c]) ? data[c] : []).filter((x) => x && SAFE_ID.test(x.id)).map((x) => {
      const y = { ...x, id: x.id };
      if ('title' in y) y.title = str(y.title, 300);
      if ('name' in y) y.name = str(y.name, 80);
      if (c === 'areas') y.color = /^#[0-9a-f]{6}$/i.test(y.color) ? y.color : '#2f9474';
      for (const k of ['due', 'followUp', 'focusDate', 'assignedAt', 'targetDate']) if (k in y) y[k] = date(y[k]);
      if (c === 'tasks' && 'status' in y) y.status = ['todo', 'done', 'waiting'].includes(y.status) ? y.status : 'todo';
      if ('waitingSince' in y) y.waitingSince = date(y.waitingSince);
      if (c === 'tasks') {
        if ('kind' in y) y.kind = y.kind === 'meeting' ? 'meeting' : null;
        if ('place' in y) y.place = str(y.place, 120) || null;
        for (const k of ['duration', 'spent']) if (k in y) y[k] = Number.isFinite(y[k]) && y[k] >= 0 && y[k] < 1e6 ? Math.round(y[k]) : null;
        if ('focusLog' in y) y.focusLog = (Array.isArray(y.focusLog) ? y.focusLog : []).filter((x) => Array.isArray(x) && isDateKey(x[0]) && Number.isFinite(x[1])).slice(-30).map((x) => [x[0], Math.round(x[1])]);
        if ('minutes' in y) {
          const m = y.minutes && typeof y.minutes === 'object' ? y.minutes : null;
          const arr = (a, n, f) => (Array.isArray(a) ? a.slice(0, n).map(f) : []);
          y.minutes = m ? {
            at: str(m.at, 40), summary: str(m.summary, 2000), transcript: str(m.transcript, 30000),
            attendees: arr(m.attendees, 30, (x) => str(x, 60)), decisions: arr(m.decisions, 30, (x) => str(x, 400)),
            actions: arr(m.actions, 40, (a) => ({ title: str(a?.title, 200), owner: str(a?.owner, 40) || null, due: date(a?.due), taskId: SAFE_ID.test(a?.taskId || '') ? a.taskId : null })),
            dates: arr(m.dates, 20, (d) => ({ what: str(d?.what, 200), date: date(d?.date) })),
          } : null;
        }
      }
      if ('time' in y) y.time = /^\d{2}:\d{2}$/.test(y.time) ? y.time : null;
      for (const k of ['areaId', 'goalId', 'nextId']) if (y[k] && !SAFE_ID.test(y[k])) y[k] = null;
      if (Array.isArray(y.steps)) y.steps = y.steps.filter((st) => st && SAFE_ID.test(st.id)).map((st) => ({ id: st.id, title: str(st.title, 200), done: !!st.done }));
      return y;
    });
  }
  return { ...data, ...out };
}

async function importData(file) {
  try {
    const raw = JSON.parse(await file.text());
    const data = raw.app === 'command-center' ? sanitize(raw) : raw;
    if (data.app === 'command-center') {
      const count = (data.tasks || []).length;
      if (!confirm(`استيراد ${n(count)} مهمة سيستبدل كل البيانات الحالية. متابعة؟`)) return;
      store.importAll(data);
      toast('تم الاستيراد.');
      return;
    }
    if (Array.isArray(data.domains) && Array.isArray(data.tasks)) {
      const { goals, tasks } = sanitize(convertSetupFile(data, setupAreaMap(data.domains)));
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
    // في وضع الحساب: لا ترحيل قبل تأكيد الخادم، كي لا يُبنى على نسخة قديمة
    if (store.status.ready && (store.mode !== 'cloud' || store.status.serverConfirmed)) { const k = rollover(); if (k) toast(`عادت ${n(k)} من أولويات الأمس إلى قوائمها. اختر ثلاث اليوم من جديد.`); }
    render();
    notify.plan();
  }
}

let rolledFor = null;
let planT = 0;
store.subscribe((state, status, dataChanged) => {
  const source = store.mode === 'cloud' ? store.user?.uid : 'local';
  if (rolledFor !== source && status.ready && (store.mode !== 'cloud' || status.serverConfirmed)) {
    rolledFor = source;
    const k = rollover();
    if (k) toast(`عادت ${n(k)} من أولويات الأمس لم تُنجز. اختر ثلاث اليوم من جديد.`);
  }
  if (!dataChanged) { renderSync(); return; }
  render();
  handlePendingTask();
  clearTimeout(planT);
  planT = setTimeout(() => notify.plan(), 600); // الجدول يُبنى بعد هدوء التغييرات
});

window.addEventListener('hashchange', onRoute);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkDay(); if (ui.timer.running) tick(); notify.plan(); } });
setInterval(checkDay, 60_000);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); env.installPrompt = e; if (ui.route === 'settings') { last.view = ''; render(); } });
matchMedia('(min-width: 900px)').addEventListener('change', render);

onRoute();
store.boot().catch((e) => { console.error(e); view.innerHTML = '<p class="loading">تعذّر تشغيل التطبيق.</p>'; });

/* ═════════════ التحديث التلقائي والتنبيهات من الـService Worker ═════════════ */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const sw = navigator.serviceWorker;
  const hadController = Boolean(sw.controller);
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  sw.addEventListener('message', (e) => {
    if (e.data?.version) { env.appVersion = e.data.version; if (ui.route === 'settings') { last.view = ''; render(); } }
    if (e.data?.type === 'nav' && e.data.hash) location.hash = e.data.hash; // نقر على تنبيه والتطبيق مفتوح
  });
  // التسجيل بعد اكتمال الفتح: في أول زيارة لا ينافس تنزيلُ ملفات التخزين عرضَ الشاشة
  const register = () => sw.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      env.swReg = reg;
      notify.reg = reg;
      notify.prefetch();
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      setInterval(check, 60 * 60 * 1000);
      sw.ready.then((r) => r.active?.postMessage('version'));
    })
    .catch((e) => console.warn('SW registration failed', e));
  if (sw.controller) register();
  else if (document.readyState === 'complete') setTimeout(register, 1500);
  else window.addEventListener('load', () => setTimeout(register, 1500), { once: true });
}
