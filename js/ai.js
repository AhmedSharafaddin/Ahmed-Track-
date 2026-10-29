// الإدخال الصوتي ومحضر الاجتماع — يُحمَّل عند أول استخدام فقط.
// المسار: تسجيل في المتصفح ← تحويل إلى WAV أحادي 16kHz ← خادمك (Whisper) ← نص ← تحليل إلى مهام/محضر ← بطاقة تأكيد.
// لا يُضاف شيء دون موافقتك، ولا يُحفظ صوت في أي مكان.

import { pushConfig } from './config.js';
import { store } from './store.js';
import { todayKey, keyAdd, esc, n, fmtDate, isDateKey } from './utils.js';
import { areas, people, createTask, updateTask, taskById, settings } from './model.js';

const base = () => (pushConfig?.url || '').replace(/\/$/, '');
const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const VOICE_MAX = 90; // ثانية للملاحظة الصوتية
const SEG = 90; // طول مقطع المحضر بالثواني (كل مقطع يُفرَّغ وحده أثناء الاجتماع)

export const aiState = () => {
  if (!base()) return 'no-server';
  if (store.mode !== 'cloud') return 'signin';
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'no-mic';
  return 'ok';
};
export const AI_MSG = {
  'no-server': 'الإدخال الصوتي يعمل بعد تشغيل خادم التطبيق (الإعدادات ← التنبيهات).',
  signin: 'سجّل الدخول للمزامنة أولًا، فالخادم لا يقبل إلا طلباتك الموقّعة.',
  'no-mic': 'هذا المتصفح لا يسمح بتسجيل الصوت.',
  401: 'انتهت جلسة الدخول. أعد فتح التطبيق وحاول مجددًا.',
  429: 'وصلت الحد اليومي للذكاء الاصطناعي (يتجدد كل يوم).',
  501: 'الذكاء الاصطناعي غير مفعّل على الخادم: أضف ربط Workers AI باسم AI.',
  net: 'تعذّر الوصول للخادم. تحقق من الاتصال.',
};

/* ───────── الاتصال بالخادم ───────── */
async function call(path, body, raw = false, qs = '') {
  const token = await store.idToken();
  if (!token) throw Object.assign(new Error('signin'), { code: 'signin' });
  let res;
  try {
    res = await fetch(`${base()}${path}${qs}`, {
      method: 'POST',
      headers: { 'content-type': raw ? 'text/plain' : 'application/json', authorization: `Bearer ${token}` },
      body: raw ? body : JSON.stringify(body),
    });
  } catch { throw Object.assign(new Error('net'), { code: 'net' }); }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status });
  return res.json();
}

const context = () => {
  const d = new Date();
  return { today: todayKey(), weekday: WEEKDAYS[d.getDay()], areas: areas().map((a) => a.name), people: people().map((p) => p.name).slice(0, 40) };
};

/* ───────── التسجيل والتحويل ───────── */
function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}

/** مسجّل يقسّم التسجيل إلى مقاطع مستقلة (كل مقطع ملف صوتي كامل). */
class Recorder {
  constructor(segSec, onSeg) { this.segSec = segSec; this.onSeg = onSeg; this.parts = []; this.t0 = 0; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.mime = pickMime();
    this.t0 = Date.now();
    this._chunk();
  }
  _chunk() {
    const mr = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    const parts = [];
    mr.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(parts, { type: mr.mimeType || this.mime || 'audio/webm' });
      if (blob.size > 2000) this.onSeg(blob);
      if (this._final) this._final();
    };
    mr.start();
    this.mr = mr;
    if (this.segSec) this.timer = setTimeout(() => { if (mr.state === 'recording') { mr.stop(); this._chunk(); } }, this.segSec * 1000);
  }
  get seconds() { return this.t0 ? Math.round((Date.now() - this.t0) / 1000) : 0; }
  stop() {
    clearTimeout(this.timer);
    return new Promise((resolve) => {
      this._final = resolve;
      if (this.mr?.state === 'recording') this.mr.stop(); else resolve();
      this.stream?.getTracks().forEach((t) => t.stop());
    });
  }
  cancel() { this.onSeg = () => {}; clearTimeout(this.timer); try { this.mr?.stop(); } catch {} this.stream?.getTracks().forEach((t) => t.stop()); }
}

/** أي صوت يفكّه المتصفح ← WAV أحادي 16kHz (يقبله Whisper دائمًا، وحجمه صغير). */
async function toWavBase64(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let audio;
  try { audio = await ac.decodeAudioData(await blob.arrayBuffer()); } finally { ac.close?.(); }
  let rate = 16000;
  let off;
  try { off = new OfflineAudioContext(1, Math.ceil(audio.duration * rate), rate); } catch { rate = 22050; off = new OfflineAudioContext(1, Math.ceil(audio.duration * rate), rate); }
  const src = off.createBufferSource();
  src.buffer = audio; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const x = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(new Blob([buf], { type: 'audio/wav' })); });
  return String(url).slice(String(url).indexOf(',') + 1);
}

async function transcribe(blob) {
  const b64 = await toWavBase64(blob);
  const hint = [...areas().map((a) => a.name), ...people().map((p) => p.name).slice(0, 15)].join('، ');
  const { text } = await call('/transcribe', b64, true, hint ? `?hint=${encodeURIComponent(hint.slice(0, 280))}` : '');
  return (text || '').trim();
}

/* ───────── واجهة مشتركة ───────── */
const fmtSec = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const errMsg = (e) => AI_MSG[e?.code] || (e?.name === 'NotAllowedError' ? 'لم يُسمح بالميكروفون. اسمح له من إعدادات المتصفح.' : e?.name === 'EncodingError' ? 'تعذّر قراءة التسجيل الصوتي على هذا الجهاز.' : /[\u0600-\u06FF]/.test(e?.message || '') ? e.message : `حدث خطأ: ${e?.message || e}`);

function recordingView(title, sub, I, extra = '') {
  return `<div class="cap voice"><div class="cap-h"><h2>${title}</h2><button class="ib" data-v="cancel" aria-label="إلغاء">${I('x')}</button></div>
    <div class="rec"><span class="rec-dot" aria-hidden="true"></span><b id="rec-t" aria-live="off">0:00</b></div>
    <p class="note rec-sub">${sub}</p>${extra}
    <div class="row rec-acts"><button class="btn primary big" data-v="stop">${I('stop', 'f')}أنهيت</button><button class="btn" data-v="cancel">إلغاء</button></div></div>`;
}
const busyView = (msg) => `<div class="cap voice"><div class="busy"><span class="spin" aria-hidden="true"></span><p role="status">${msg}</p></div></div>`;
const errView = (msg, I) => `<div class="cap voice"><div class="cap-h"><h2>تعذّر الإكمال</h2><button class="ib" data-v="cancel" aria-label="إغلاق">${I('x')}</button></div><p class="warn">${esc(msg)}</p><div class="row"><button class="btn" data-v="cancel">إغلاق</button></div></div>`;

function bindOnce(dlg, handler) {
  const onClick = (e) => { const b = e.target.closest('[data-v]'); if (b && dlg.contains(b)) handler(b.dataset.v, b, e); };
  dlg.addEventListener('click', onClick);
  const off = () => { dlg.removeEventListener('click', onClick); dlg.removeEventListener('close', off); };
  dlg.addEventListener('close', off);
  return off;
}

/* ───────── الإدخال الصوتي ───────── */
export async function openVoice({ dlg, I, toast, ctx = {} }) {
  dlg.classList.remove('commit-dlg');
  let rec = null;
  let ticker = null;
  let stopped = false;
  const blobs = [];
  const finish = () => { clearInterval(ticker); };
  const off = bindOnce(dlg, async (v) => {
    if (v === 'cancel') { rec?.cancel(); finish(); dlg.close(); }
    if (v === 'stop' && !stopped) { stopped = true; await rec.stop(); finish(); process(); }
  });
  dlg.addEventListener('close', () => { rec?.cancel(); finish(); }, { once: true });

  dlg.innerHTML = recordingView('قل ما تريد تسجيله', `تكلّم بطبيعتك، حتى باللهجة. مثال: «بكرة الساعة ١٠ اجتماع مع المدير العام في المكتب، وخلي خالد يرسل عرض السعر يوم الأحد». حتى ${n(VOICE_MAX)} ثانية.`, I);
  if (!dlg.open) dlg.showModal();
  try {
    rec = new Recorder(0, (b) => blobs.push(b));
    await rec.start();
  } catch (e) { off(); dlg.innerHTML = errView(errMsg(e), I); bindOnce(dlg, () => dlg.close()); return; }
  ticker = setInterval(() => {
    const el = dlg.querySelector('#rec-t');
    if (el) el.textContent = fmtSec(rec.seconds);
    if (rec.seconds >= VOICE_MAX && !stopped) dlg.querySelector('[data-v="stop"]')?.click();
  }, 250);

  async function process() {
    off();
    dlg.innerHTML = busyView('أحوّل صوتك إلى نص…');
    try {
      if (!blobs.length) throw new Error('لم يُلتقط صوت. حاول مرة أخرى وتكلّم بعد ظهور المؤقت.');
      const text = await transcribe(blobs[0]);
      if (!text) throw new Error('لم أسمع كلامًا واضحًا. حاول مرة أخرى في مكان أهدأ.');
      dlg.innerHTML = busyView('أفهم ما قلته وأرتبه…');
      const { items } = await call('/parse', { text, ...context() });
      confirmView(text, items?.length ? items : [{ kind: 'task', title: text.slice(0, 200) }]);
    } catch (e) {
      dlg.innerHTML = errView(errMsg(e), I);
      bindOnce(dlg, () => dlg.close());
    }
  }

  function confirmView(text, items) {
    const aOpts = (sel) => `<option value="">بلا مجال (الوارد)</option>${areas().map((a) => `<option value="${a.id}"${a.name === sel || a.id === ctx.area ? ' selected' : ''}>${a.emoji ? `${esc(a.emoji)} ` : ''}${esc(a.name)}</option>`).join('')}`;
    const card = (it, i) => `<fieldset class="vitem" data-i="${i}">
      <div class="vi-top"><label class="chip-t"><input type="checkbox" name="on" checked /> أضف</label>
        <div class="seg sm" role="group" aria-label="النوع"><button type="button" data-v="kind" data-k="task" class="${it.kind !== 'meeting' ? 'on' : ''}" aria-pressed="${it.kind !== 'meeting'}">مهمة</button><button type="button" data-v="kind" data-k="meeting" class="${it.kind === 'meeting' ? 'on' : ''}" aria-pressed="${it.kind === 'meeting'}">${I('meet')}اجتماع</button></div></div>
      <input type="hidden" name="kind" value="${it.kind === 'meeting' ? 'meeting' : 'task'}" />
      <label class="fld"><span>العنوان</span><input class="in" name="title" value="${esc(it.title)}" maxlength="200" required /></label>
      <div class="vi-grid">
        <label class="fld"><span>اليوم</span><input class="in" type="date" name="due" value="${esc(it.due || '')}" /></label>
        <label class="fld"><span>الوقت</span><input class="in" type="time" name="time" value="${esc(it.time || '')}" /></label>
        <label class="fld"><span>المجال</span><select class="in" name="areaId">${aOpts(it.area)}</select></label>
        <label class="fld"><span>المسؤول</span><input class="in" name="assignee" value="${esc(it.assignee || '')}" placeholder="أنا" maxlength="40" /></label>
        <label class="fld m-only"><span>المكان</span><input class="in" name="place" value="${esc(it.place || '')}" maxlength="120" /></label>
        <label class="fld m-only"><span>المدة (دقيقة)</span><input class="in" type="number" min="5" max="600" step="5" name="duration" value="${it.duration || ''}" /></label>
      </div>
      <input type="hidden" name="important" value="${it.important ? '1' : ''}" /><input type="hidden" name="urgent" value="${it.urgent ? '1' : ''}" />
    </fieldset>`;
    dlg.innerHTML = `<form class="cap voice vconfirm" method="dialog">
      <div class="cap-h"><h2>راجع قبل الإضافة</h2><button type="button" class="ib" data-v="cancel" aria-label="إلغاء">${I('x')}</button></div>
      <p class="heard"><span>سمعت:</span> «${esc(text)}»</p>
      ${items.map(card).join('')}
      <div class="row"><button type="button" class="btn primary" data-v="add">${I('check')}أضف المحدد</button><button type="button" class="btn" data-v="again">${I('mic')}سجّل من جديد</button><button type="button" class="btn ghost" data-v="cancel">إلغاء</button></div>
    </form>`;
    dlg.querySelectorAll('.vitem').forEach((f) => f.classList.toggle('is-meet', f.elements.kind.value === 'meeting'));
    const offC = bindOnce(dlg, (v, b) => {
      if (v === 'cancel') dlg.close();
      if (v === 'again') { offC(); openVoice({ dlg, I, toast, ctx }); return; }
      if (v === 'kind') {
        const f = b.closest('.vitem');
        f.elements.kind.value = b.dataset.k;
        f.classList.toggle('is-meet', b.dataset.k === 'meeting');
        f.querySelectorAll('[data-v="kind"]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      }
      if (v === 'add') {
        let added = 0;
        dlg.querySelectorAll('.vitem').forEach((f) => {
          const e = f.elements;
          if (!e.on.checked || !e.title.value.trim()) return;
          const meet = e.kind.value === 'meeting';
          const due = isDateKey(e.due.value) ? e.due.value : null;
          const time = /^\d{2}:\d{2}$/.test(e.time.value) && due ? e.time.value : null;
          const who = e.assignee.value.trim() || null;
          const me = (settings().name || '').trim();
          const assignee = who && who !== me && who !== 'أنا' ? who : null;
          createTask({
            title: e.title.value.trim().slice(0, 200), areaId: e.areaId.value || null, due, time,
            remind: time ? (meet ? 15 : 0) : null,
            important: !!e.important.value, urgent: !!e.urgent.value,
            ...(assignee ? { assignee, assignedAt: todayKey(), followUp: due && due > todayKey() ? due : keyAdd(todayKey(), 2) } : {}),
            ...(meet ? { kind: 'meeting', place: e.place.value.trim().slice(0, 120) || null, duration: Math.min(600, Math.max(5, Number(e.duration.value) || 60)) } : {}),
          });
          added++;
        });
        dlg.close();
        toast(added ? `أُضيف ${added === 1 ? 'عنصر واحد' : added === 2 ? 'عنصران' : `${n(added)} عناصر`}.` : 'لم يُضف شيء.');
      }
    });
  }
}

/* ───────── محضر الاجتماع ───────── */
export async function openMinutes({ dlg, I, toast, id, go }) {
  const t = taskById(id);
  if (!t) return;
  dlg.classList.remove('commit-dlg');
  dlg.innerHTML = `<div class="cap voice"><div class="cap-h"><h2>محضر: ${esc(t.title)}</h2><button class="ib" data-v="cancel" aria-label="إغلاق">${I('x')}</button></div>
    <p class="note">سجّل الاجتماع كاملًا، أو الصق ملاحظاتك المكتوبة. سأستخرج الملخص والقرارات والمطلوب من كل شخص، ثم تراجعها قبل الحفظ.</p>
    <div class="row" style="margin-top:12px"><button class="btn primary big" data-v="rec" ${aiState() === 'ok' ? '' : 'disabled'}>${I('mic')}سجّل الاجتماع</button><button class="btn big" data-v="paste">${I('note')}الصق نصًا</button></div>
    ${aiState() === 'ok' ? '' : `<p class="warn" style="margin-top:10px">${AI_MSG[aiState()]}</p>`}
    <p class="note" style="margin-top:10px">${I('bolt')}نبّه الحضور أنك تسجّل. الصوت لا يُحفظ: يُحوَّل إلى نص فقط.</p></div>`;
  if (!dlg.open) dlg.showModal();
  const off = bindOnce(dlg, (v) => {
    if (v === 'cancel') dlg.close();
    if (v === 'paste') { off(); pasteView(); }
    if (v === 'rec') { off(); recordMeeting(); }
  });

  function pasteView() {
    dlg.innerHTML = `<div class="cap voice"><div class="cap-h"><h2>نص الاجتماع</h2><button class="ib" data-v="cancel" aria-label="إغلاق">${I('x')}</button></div>
      <label class="fld"><span>الصق التفريغ أو ملاحظاتك</span><textarea class="in" id="min-text" rows="10" maxlength="60000"></textarea></label>
      <div class="row"><button class="btn primary" data-v="go" ${aiState() === 'no-server' || aiState() === 'signin' ? 'disabled' : ''}>استخرج المحضر</button><button class="btn" data-v="cancel">إلغاء</button></div></div>`;
    setTimeout(() => dlg.querySelector('#min-text')?.focus(), 30);
    const off2 = bindOnce(dlg, (v) => {
      if (v === 'cancel') dlg.close();
      if (v === 'go') { const txt = dlg.querySelector('#min-text').value.trim(); if (txt.length < 20) { toast('النص قصير جدًا.'); return; } off2(); summarize(txt); }
    });
  }

  async function recordMeeting() {
    const texts = [];
    let pending = 0;
    let failed = 0;
    let chain = Promise.resolve();
    const status = () => { const el = dlg.querySelector('#rec-s'); if (el) el.textContent = `فُرّغ ${n(texts.filter(Boolean).length)} مقطع${pending ? `، و${n(pending)} قيد التفريغ` : ''}${failed ? `، تعذّر ${n(failed)}` : ''}`; };
    const onSeg = (blob) => {
      const i = texts.length; texts.push(''); pending++; status();
      chain = chain.then(() => transcribe(blob).then((x) => { texts[i] = x; }).catch(() => { failed++; })).finally(() => { pending--; status(); });
    };
    const rec = new Recorder(SEG, onSeg);
    let ticker = null;
    dlg.innerHTML = recordingView('أسجّل الاجتماع', 'اترك الجهاز قريبًا من المتحدثين. يُفرَّغ التسجيل على مقاطع أثناء الاجتماع، فلا تنتظر طويلًا في النهاية. أبقِ الشاشة مفتوحة.', I, '<p class="note" id="rec-s" aria-live="polite"></p>');
    let wake = null;
    try { wake = await navigator.wakeLock?.request('screen'); } catch {}
    const stopAll = () => { clearInterval(ticker); try { wake?.release(); } catch {} };
    const off3 = bindOnce(dlg, async (v) => {
      if (v === 'cancel') { rec.cancel(); stopAll(); dlg.close(); }
      if (v === 'stop') {
        off3(); stopAll();
        await rec.stop();
        dlg.innerHTML = busyView('أكمل تفريغ آخر المقاطع…');
        await chain;
        const full = texts.filter(Boolean).join('\n');
        if (full.length < 20) { dlg.innerHTML = errView(failed ? 'تعذّر تفريغ التسجيل. تحقق من الاتصال.' : 'لم يُلتقط كلام كافٍ.', I); bindOnce(dlg, () => dlg.close()); return; }
        summarize(full);
      }
    });
    dlg.addEventListener('close', () => { rec.cancel(); stopAll(); }, { once: true });
    try { await rec.start(); } catch (e) { off3(); stopAll(); dlg.innerHTML = errView(errMsg(e), I); bindOnce(dlg, () => dlg.close()); return; }
    ticker = setInterval(() => { const el = dlg.querySelector('#rec-t'); if (el) el.textContent = fmtSec(rec.seconds); }, 500);
  }

  async function summarize(text) {
    dlg.innerHTML = busyView('أكتب المحضر: الملخص، القرارات، والمطلوب من كل شخص…');
    try {
      const m = await call('/minutes', { text, title: t.title, ...context() });
      review(m, text);
    } catch (e) { dlg.innerHTML = errView(errMsg(e), I); bindOnce(dlg, () => dlg.close()); }
  }

  function review(m, transcript) {
    const lines = (a) => esc((a || []).join('\n'));
    const act = (a, i) => `<div class="mact" data-i="${i}">
      <label class="chip-t"><input type="checkbox" name="mk" checked /> مهمة</label>
      <input class="in" name="title" value="${esc(a.title)}" maxlength="200" aria-label="المطلوب" />
      <input class="in" name="owner" value="${esc(a.owner || '')}" placeholder="المسؤول" maxlength="40" aria-label="المسؤول" />
      <input class="in" type="date" name="due" value="${esc(a.due || '')}" aria-label="الموعد" /></div>`;
    dlg.innerHTML = `<div class="cap voice mreview"><div class="cap-h"><h2>راجع المحضر</h2><button class="ib" data-v="cancel" aria-label="إغلاق">${I('x')}</button></div>
      <label class="fld"><span>الملخص</span><textarea class="in" id="m-sum" rows="3" maxlength="2000">${esc(m.summary || '')}</textarea></label>
      <label class="fld"><span>الحضور (سطر لكل اسم)</span><textarea class="in" id="m-att" rows="2">${lines(m.attendees)}</textarea></label>
      <label class="fld"><span>القرارات (سطر لكل قرار)</span><textarea class="in" id="m-dec" rows="4">${lines(m.decisions)}</textarea></label>
      <div class="fld"><span>المطلوب ومن المسؤول — المحدد يصبح مهمة مُسندة بموعد متابعة</span>${(m.actions || []).map(act).join('') || '<p class="note">لم يُستخرج مطلوب محدد.</p>'}</div>
      ${m.dates?.length ? `<div class="fld"><span>مواعيد مذكورة</span><ul class="steps">${m.dates.map((d) => `<li>${esc(d.what)}${d.date ? ` — ${fmtDate(d.date)}` : ''}</li>`).join('')}</ul></div>` : ''}
      <p class="note">راجع الأسماء والمواعيد: التفريغ الآلي قد يخطئ، خاصة في الأسماء.</p>
      <div class="row"><button class="btn primary" data-v="save">${I('check')}احفظ المحضر</button><button class="btn ghost" data-v="cancel">إلغاء</button></div></div>`;
    bindOnce(dlg, (v) => {
      if (v === 'cancel') dlg.close();
      if (v !== 'save') return;
      const split = (id2) => dlg.querySelector(id2).value.split('\n').map((x) => x.trim()).filter(Boolean);
      const me = (settings().name || '').trim();
      const actions = [];
      let made = 0;
      dlg.querySelectorAll('.mact').forEach((r) => {
        const title = r.querySelector('[name=title]').value.trim();
        if (!title) return;
        const owner = r.querySelector('[name=owner]').value.trim() || null;
        const due = isDateKey(r.querySelector('[name=due]').value) ? r.querySelector('[name=due]').value : null;
        const a = { title, owner, due, taskId: null };
        if (r.querySelector('[name=mk]').checked) {
          const assignee = owner && owner !== me && owner !== 'أنا' ? owner : null;
          const nt = createTask({
            title, areaId: t.areaId || null, due, notes: `من محضر: ${t.title}`,
            ...(assignee ? { assignee, assignedAt: todayKey(), followUp: due && due > todayKey() ? due : keyAdd(todayKey(), 2) } : {}),
          });
          a.taskId = nt?.id || null;
          made++;
        }
        actions.push(a);
      });
      updateTask(t.id, {
        minutes: {
          at: new Date().toISOString(), summary: dlg.querySelector('#m-sum').value.trim().slice(0, 2000),
          attendees: split('#m-att').slice(0, 30), decisions: split('#m-dec').slice(0, 30),
          actions, dates: (m.dates || []).slice(0, 20), transcript: transcript.slice(0, 30000),
        },
      });
      dlg.close();
      toast(`حُفظ المحضر${made ? ` و${made === 1 ? 'أُنشئت مهمة واحدة' : made === 2 ? 'أُنشئت مهمتان' : `أُنشئت ${n(made)} مهام`}` : ''}.`);
      go?.(`#/minutes/${t.id}`);
    });
  }
}
