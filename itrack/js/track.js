// ITrack — المتابعة: لوحة المدير، المهام المسندة (قائمة / لوحة / تقويم)، تفاصيل المهمة والاعتماد والنقاش،
// نموذج الإسناد، التشغيل والتكامل (للمسؤول)، ولوحة الأوامر Ctrl+K.
// كل رقم هنا يحسبه الخادم بقواعد معلنة (انظر computeMetrics في worker.js)؛ الواجهة تعرض فقط.
let H = null; // أدوات app.js (الحالة والرسم والاتصال)
export function init(h) { H = h; }

const PR = { 1: 'عادية', 2: 'مهمة', 3: 'حرجة' };
const ST = { new: 'جديدة', doing: 'قيد التنفيذ', blocked: 'متعثّرة', review: 'بانتظار الاعتماد', done: 'منجزة' };
const WHY = { overdue: 'فات موعدها', lag: 'متأخرة عن الجدول', soon: 'تستحق قريبًا والإنجاز دون النصف', blocked: 'متعثّرة' };
const RISK = { high: 'تحتاج تدخّلًا', med: 'راقبها', ok: 'على المسار' };
const FREQ = { '': 'بلا تكرار', daily: 'يومي', weekly: 'أسبوعي', monthly: 'شهري' };
const WD = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export { FREQ, PR };

/* ═════════════ أدوات ═════════════ */
const col = (x) => (x.status === 'done' ? (x.rv?.state === 'pending' ? 'review' : 'done') : x.blocked ? 'blocked' : (x.prog || 0) > 0 ? 'doing' : 'new');
const late = (x) => x.status !== 'done' && x.due && x.due < H.today();
const pct = (v) => (v === null || v === undefined ? '—' : `${H.n(v)}٪`);
const tone = (v, good = 85, mid = 65) => (v === null || v === undefined ? '' : v >= good ? 'ok' : v >= mid ? 'mid' : 'bad');
const ring = (v, size = 44) => {
  const r = size / 2 - 4; const c = 2 * Math.PI * r; const p = v == null ? 0 : Math.max(0, Math.min(100, v));
  return `<svg class="ring ${tone(v)}${p ? '' : ' z'}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="rt"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="rv" stroke-dasharray="${(c * p) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle">${v == null ? '—' : H.n(v)}</text></svg>`;
};
const meter = (v, cls = '') => `<span class="meter ${cls || tone(v)}" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, v || 0))}%"></i></span>`;
const loadTone = (p) => (p == null ? '' : p > 110 ? 'bad' : p < 40 ? 'low' : 'ok');
const prioDot = (p) => `<i class="pd p${p}" title="${PR[p]}" aria-label="أولوية ${PR[p]}"></i>`;
const dueTxt = (x) => (x.due ? `${H.rel(x.due)}${x.time ? ` ${x.time}` : ''}` : 'بلا موعد');
const ref = (x) => `#/track/t/${encodeURIComponent(x.member_id)}/${encodeURIComponent(x.id)}`;
const who = (id) => H.memberById(id);
const canAssignTo = () => H.members().filter((m) => m.email !== undefined && m.status !== 'disabled' && m.id !== H.S.boot.me.id && (H.isAdmin() || H.S.boot.me.subs.includes(m.id)));
const feat = (k) => !!H.S.boot?.settings?.feat?.[k];
const aiReady = () => H.S.boot?.ai && feat('ai');
function range() {
  const t = H.today(); const p = H.S.tp || '30';
  if (p === 'month') return { from: t.slice(0, 8) + '01', to: t, label: 'هذا الشهر' };
  const d = p === '7' ? 6 : 29; return { from: H.addD(t, -d), to: t, label: p === '7' ? 'آخر ٧ أيام' : 'آخر ٣٠ يومًا' };
}
const metrics = () => { const r = range(); return H.need(`met|${r.from}|${r.to}`, () => H.call('GET', `/api/metrics?from=${r.from}&to=${r.to}`)); };
const assigned = () => H.need('asg', () => H.call('GET', '/api/assigned'));

/** طلب خام (صور، CSV) بنفس الجلسة. */
async function raw(path, opts = {}) {
  const s = H.session();
  let res;
  try { res = await fetch(H.apiUrl + path, { ...opts, headers: { authorization: `Bearer ${s?.token}`, 'x-org': H.S.org, ...(opts.headers || {}) } }); }
  catch { throw new Error('لا اتصال بالخادم.'); }
  if (!res.ok) { let d = {}; try { d = await res.json(); } catch {} throw new Error(d.message || 'تعذّر الطلب.'); }
  return res;
}
const photos = new Map();
function photo(fid) {
  if (!photos.has(fid)) {
    photos.set(fid, null);
    raw(`/api/files/${encodeURIComponent(fid)}`).then((r) => r.blob()).then((b) => { photos.set(fid, URL.createObjectURL(b)); H.render(); }, () => { photos.set(fid, ''); H.render(); });
  }
  const u = photos.get(fid);
  return u ? `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="صورة إنجاز" width="96" height="96" loading="lazy" /></a>` : u === '' ? '<span class="ph-x">انتهت مدة الاحتفاظ</span>' : '<span class="ph-ld" aria-label="تحميل"></span>';
}
async function download(path, name) {
  const r = await raw(path); const b = await r.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ═════════════ الإطار: ثلاث شاشات تحت «المتابعة» ═════════════ */
export function tabs(cur) {
  const t = [['board', '#/track', 'لوحة المتابعة'], ['tasks', '#/track/tasks', 'المهام'], ['team', '#/team', 'التقارير اليومية']];
  return `<nav class="tabs" aria-label="المتابعة">${t.map(([k, h, l]) => `<a href="${h}"${k === cur ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
}
export function vTrack(a, b, c) {
  if (a === 'new') return vAssign();
  if (a === 't') return vTask(b, c);
  if (a === 'm') return vPerson(b);
  if (a === 'tasks') return vTasks();
  return vBoard();
}
const periodSeg = () => `<div class="seg" role="group" aria-label="الفترة">${[['7', '٧ أيام'], ['30', '٣٠ يومًا'], ['month', 'هذا الشهر']].map(([k, l]) => `<button data-act="tp" data-v="${k}" aria-pressed="${(H.S.tp || '30') === k}">${l}</button>`).join('')}</div>`;
const assignBtn = () => `<a class="btn primary" href="#/track/new">${H.I('plus')}إسناد مهمة <kbd>N</kbd></a>`;

/* ═════════════ لوحة المتابعة ═════════════ */
function vBoard() {
  const M = metrics(); const A = assigned(); const ib = H.inbox();
  const r = range();
  const head = H.vh('المتابعة', `${r.label} · من ${H.rel(r.from)} إلى ${H.rel(r.to)}`, `${periodSeg()}${assignBtn()}`);
  if (!M) return `<div class="wrap">${head}${tabs('board')}${H.loadingCard()}</div>`;
  if (M.error) return `<div class="wrap">${head}${tabs('board')}${H.errCard(M)}</div>`;
  const ms = M.members.filter((x) => !H.S.f.tdep || who(x.member_id)?.department_id === H.S.f.tdep);
  if (!M.members.length) return `<div class="wrap">${head}${tabs('board')}<div class="card"><div class="empty"><p>لا أحد يتبعك بعد، فلا مؤشرات لعرضها.</p></div></div></div>`;
  // إجمالي الفريق من نفس القواعد
  const sum = (f) => ms.reduce((s, x) => s + f(x), 0);
  const elig = sum((x) => x.assigned.due + x.duties.expected); const dn = sum((x) => (x.assigned.done) + x.duties.done);
  const comp = elig ? Math.round((Math.min(dn, elig) / elig) * 100) : null;
  const doneAll = sum((x) => x.assigned.done + x.duties.done);
  const ontime = doneAll ? Math.round((sum((x) => x.assigned.ontime + x.duties.ontime) / doneAll) * 100) : null;
  const overdue = sum((x) => x.assigned.overdue); const blocked = sum((x) => x.blocked); const missed = sum((x) => x.duties.missed);
  const pend = ib && !ib.error ? (ib.team?.pending || []).length + ib.review.length : 0;
  const kpi = (v, l, cls = '', h = '') => `<${h ? `a href="${h}"` : 'div'} class="kpi ${cls}"><b>${v}</b><span>${l}</span></${h ? 'a' : 'div'}>`;
  const kpis = `<div class="kpis k6">
    ${kpi(`${ring(comp, 52)}`, 'الإنجاز', 'ringk')}${kpi(pct(ontime), 'في الموعد', tone(ontime))}
    ${kpi(H.n(overdue), 'متأخرة الآن', overdue ? 'hot' : '', '#/track/tasks?st=late')}${kpi(H.n(blocked), 'متعثّرة', blocked ? 'hot' : '', '#/track/tasks?st=blocked')}
    ${kpi(H.n(missed), 'واجبات فاتت', missed ? 'warnk' : '')}${kpi(H.n(pend), 'بانتظار قرارك', pend ? 'accentk' : '', '#/track/tasks?st=review')}</div>`;
  // قرارك: ما ينتظر اعتمادك (مهام وتقارير)
  const queue = ib && !ib.error ? [
    ...(ib.team?.pending || []).map((x) => ({ h: ref(x), m: who(x.member_id), t: x.title, s: 'مهمة منجزة', at: x.doneAt })),
    ...ib.review.map((x) => ({ h: `#/m/${encodeURIComponent(x.member_id)}/${x.date}`, m: who(x.member_id), t: `تقرير ${H.rel(x.date)}`, s: 'تقرير يومي', at: x.submitted_at })),
  ].filter((x) => x.m).sort((a2, b2) => (a2.at || 0) - (b2.at || 0)) : [];
  const qCard = queue.length ? `<div class="card queue"><h2>${H.I('hourglass')}بانتظار قرارك · ${H.n(queue.length)}</h2><div class="people">${queue.slice(0, 6).map((x) => `<a class="person" href="${x.h}">${H.avatar(x.m.name)}<div class="who"><b>${H.esc(x.t)}</b><small>${H.esc(x.m.name)} · ${x.s}</small></div>${H.I('fwd')}</a>`).join('')}</div></div>` : '';
  // الإدارات
  const deps = H.S.boot.departments.filter((d) => d.active).map((d) => {
    const xs = M.members.filter((x) => who(x.member_id)?.department_id === d.id); if (!xs.length) return null;
    const e = xs.reduce((s, x) => s + x.assigned.due + x.duties.expected, 0); const k = xs.reduce((s, x) => s + x.assigned.done + x.duties.done, 0);
    return { d, n: xs.length, c: e ? Math.round((Math.min(k, e) / e) * 100) : null, od: xs.reduce((s, x) => s + x.assigned.overdue, 0), bl: xs.reduce((s, x) => s + x.blocked, 0), hi: xs.filter((x) => x.risk === 'high').length };
  }).filter(Boolean);
  const depCards = deps.length > 1 ? `<div class="rollup" role="group" aria-label="الإدارات">${deps.map((x) => `<button type="button" class="rcard dep" data-act="tdep" data-v="${H.esc(x.d.id)}" aria-pressed="${H.S.f.tdep === x.d.id}">
      ${ring(x.c, 46)}<div><b>${H.esc(x.d.name)}</b><span class="rn">${H.n(x.n)} موظف</span>
      <span class="rm">${x.od ? `<em class="hot">${H.n(x.od)} متأخرة</em>` : ''}${x.bl ? `<em class="hot">${H.n(x.bl)} متعثّرة</em>` : ''}${x.hi ? `<em>${H.n(x.hi)} يحتاج تدخّلًا</em>` : ''}${!x.od && !x.bl && !x.hi ? '<em>على المسار</em>' : ''}</span></div></button>`).join('')}</div>` : '';
  // السرعة: النقاط الموزونة المنجزة أسبوعيًا
  const pts = M.team.points; const mx = Math.max(1, ...pts);
  const vel = `<div class="card"><h2>${H.I('chart')}سرعة الإنجاز</h2><p class="hint" style="margin:-6px 0 10px">النقاط الموزونة المنجزة أسبوعيًا (حرجة ٣، مهمة ٢، عادية ١)</p>
    <div class="vbars" role="img" aria-label="سرعة الإنجاز لآخر ٨ أسابيع: ${pts.map((p) => H.n(p)).join('، ')}">${pts.map((p, i) => `<div class="vb${i === pts.length - 1 ? ' cur' : ''}"><i style="height:${Math.round((p / mx) * 100)}%"></i><b>${H.n(p)}</b><small>${H.esc(H.fShort.format(H.parse(M.weeks[i])).split('،').pop())}</small></div>`).join('')}</div></div>`;
  // أبرز إنجازات الأسبوع: التطبيق يُبرز الإنجاز لا العقاب
  const stars = [...M.members].filter((x) => x.trend[7] > 0).sort((a2, b2) => b2.trend[7] - a2.trend[7]).slice(0, 3);
  const kudos = stars.length ? `<div class="card kudos"><h2>${H.I('flag')}أبرز إنجازات هذا الأسبوع</h2><div class="people">${stars.map((x) => { const m = who(x.member_id); return m ? `<a class="person" href="#/track/m/${encodeURIComponent(m.id)}">${H.avatar(m.name)}<div class="who"><b>${H.esc(m.name)}</b><small>${H.n(x.trend[7])} نقطة · ${pct(x.ontime)} في الموعد</small></div></a>` : ''; }).join('')}</div></div>` : '';
  // الأحوج للتدخل
  const rows = [...ms].sort((a2, b2) => b2.score - a2.score || (a2.completion ?? 101) - (b2.completion ?? 101));
  const table = `<div class="card"><div class="row hrow"><h2 style="margin:0">${H.I('people')}الأحوج للتدخّل أولًا</h2>
      <div class="row"><button class="btn sm" data-act="csv" data-v="people">${H.I('doc')}Excel: الموظفون</button><button class="btn sm" data-act="csv" data-v="tasks">${H.I('doc')}Excel: المهام</button></div></div>
    ${H.S.f.tdep ? `<p class="hint">مصفّى على: ${H.esc(H.depById(H.S.f.tdep)?.name || '')} · <button class="link" data-act="tdep" data-v="${H.esc(H.S.f.tdep)}">إلغاء</button></p>` : ''}
    <div class="tbl" role="table" aria-label="مؤشرات الموظفين"><div class="tr th" role="row"><span role="columnheader">الموظف</span><span role="columnheader">الإنجاز</span><span role="columnheader">في الموعد</span><span role="columnheader">متأخرة</span><span role="columnheader">واجبات فاتت</span><span role="columnheader">الحِمل</span><span role="columnheader">الحالة</span></div>
    ${rows.map((x) => { const m = who(x.member_id); if (!m) return ''; const pos = H.posById(m.position_id);
      return `<a class="tr" role="row" href="#/track/m/${encodeURIComponent(m.id)}"><span role="cell" class="tw">${H.avatar(m.name)}<span><b>${H.esc(m.name)}</b><small>${H.esc(pos?.title || H.ROLE[m.role])}</small></span></span>
        <span role="cell" data-l="الإنجاز">${meter(x.completion)}<b>${pct(x.completion)}</b></span><span role="cell" data-l="في الموعد">${pct(x.ontime)}</span>
        <span role="cell" data-l="متأخرة" class="${x.assigned.overdue ? 'hot' : ''}">${H.n(x.assigned.overdue)}</span><span role="cell" data-l="واجبات فاتت" class="${x.duties.missed ? 'warnc' : ''}">${H.n(x.duties.missed)}</span>
        <span role="cell" data-l="الحِمل">${meter(x.load.pct, loadTone(x.load.pct))}<small>${pct(x.load.pct)}</small></span><span role="cell"><span class="rk ${x.risk}">${RISK[x.risk]}</span></span></a>`; }).join('')}</div>
    <p class="hint" style="margin-top:10px">الإنجاز = المنجز ÷ (المنجز + ما فات موعده). ما لم يحن موعده لا يُحسب على أحد. الحِمل = المتبقي المقدّر من المفتوح ÷ ساعات عمل الأيام السبعة القادمة.</p></div>`;
  // مخاطر التأخير قبل وقوعها
  const risks = M.risks.filter((x) => !H.S.f.tdep || who(x.member_id)?.department_id === H.S.f.tdep).slice(0, 10);
  const rCard = `<div class="card"><h2>${H.I('fire')}مخاطر التأخير</h2>${risks.length ? `<ul class="risks">${risks.map((x) => { const m = who(x.member_id); return `<li><a href="${ref(x)}">${prioDot(x.prio)}<span class="rt"><b>${H.esc(x.title)}</b><small>${H.esc(m?.name || '')} · ${dueTxt(x)}</small></span>
      <span class="why">${x.why.map((w) => `<em class="w-${w}">${WHY[w]}</em>`).join('')}${x.blocked ? `<small>${H.esc(x.blocked.slice(0, 60))}</small>` : ''}</span>${meter(x.prog, 'acc')}</a></li>`; }).join('')}</ul>` : '<div class="empty"><p>لا مخاطر ظاهرة الآن.</p></div>'}
    <p class="hint">تُكتشف بقواعد واضحة: فات الموعد، أو مضى نصف الوقت والإنجاز أقل منه بكثير، أو بقي يوم والإنجاز دون النصف، أو متعثّرة.</p></div>`;
  void A;
  return `<div class="wrap">${head}${tabs('board')}${kpis}${qCard}${depCards}${table}<div class="grid2" style="margin-top:16px"><div class="stack">${rCard}</div><div class="stack">${vel}${kudos}</div></div></div>`;
}

/* ═════════════ موظف واحد ═════════════ */
function vPerson(id) {
  const m = who(id);
  if (!m || m.email === undefined) return H.deny();
  const r = range();
  const M = H.need(`met|${r.from}|${r.to}|${id}`, () => H.call('GET', `/api/metrics?from=${r.from}&to=${r.to}&member=${encodeURIComponent(id)}`));
  const A = assigned();
  const x = M && !M.error ? M.members[0] : null;
  const pos = H.posById(m.position_id);
  const list = A && !A.error ? A.tasks.filter((t) => t.member_id === id) : [];
  const open = list.filter((t) => t.status !== 'done').sort(byUrg); const done = list.filter((t) => t.status === 'done').sort((a2, b2) => (b2.doneAt || 0) - (a2.doneAt || 0)).slice(0, 12);
  const stat = (v, l, cls = '') => `<div class="kpi ${cls}"><b>${v}</b><span>${l}</span></div>`;
  const mxT = x ? Math.max(1, ...x.trend) : 1;
  return `<div class="wrap"><p style="margin:0 0 10px"><a class="link" style="color:var(--on-bg)" href="#/track">← المتابعة</a></p>
    ${H.vh(H.esc(m.name), [pos?.title, H.depById(m.department_id)?.name, H.secById(m.section_id)?.name].filter(Boolean).map(H.esc).join(' · '), `${periodSeg()}<a class="btn" href="#/m/${encodeURIComponent(id)}/${H.today()}">التقارير اليومية</a><a class="btn primary" href="#/track/new?to=${encodeURIComponent(id)}">${H.I('plus')}أسند له</a>`)}
    ${!M ? H.loadingCard() : M.error ? H.errCard(M) : `<div class="kpis k6">${stat(ring(x.completion, 52), 'الإنجاز', 'ringk')}${stat(pct(x.weighted), 'الموزون بالأولوية')}${stat(pct(x.ontime), 'في الموعد', tone(x.ontime))}
      ${stat(pct(x.approval), 'اعتُمد من المراجَع')}${stat(`${H.n(x.duties.done)}/${H.n(x.duties.expected)}`, 'الواجبات الدورية', x.duties.missed ? 'warnk' : '')}${stat(pct(x.reports.pct), `التقارير (${H.n(x.reports.days)} من ${H.n(x.reports.expected)})`)}</div>
      <div class="grid2"><div class="card"><h2>${H.I('list')}المفتوحة · ${H.n(open.length)}</h2>${open.length ? `<ul class="tl2">${open.map(trow).join('')}</ul>` : '<div class="empty"><p>لا شيء مفتوح.</p></div>'}
        ${done.length ? `<h2 style="margin-top:18px">${H.I('check')}أُنجزت مؤخرًا</h2><ul class="tl2">${done.map(trow).join('')}</ul>` : ''}</div>
      <div class="stack"><div class="card"><h2>${H.I('chart')}النقاط أسبوعيًا</h2><div class="vbars sm">${x.trend.map((p, i) => `<div class="vb${i === 7 ? ' cur' : ''}"><i style="height:${Math.round((p / mxT) * 100)}%"></i><b>${H.n(p)}</b></div>`).join('')}</div></div>
        <div class="card"><h2>${H.I('hourglass')}الحِمل</h2>${meter(x.load.pct, loadTone(x.load.pct))}<p class="hint" style="margin-top:8px">${H.mins(x.load.minutes)} متبقية من ${H.mins(x.load.capacity)} متاحة في ٧ أيام (${pct(x.load.pct)}). ${x.load.pct > 110 ? 'محمّل فوق طاقته: أعد التوزيع أو أجّل.' : x.load.pct < 40 ? 'لديه سعة لمهام إضافية.' : ''}</p></div></div></div>`}</div>`;
}
const urg = (t) => (t.blocked ? 0 : late(t) ? 1 : t.prio === 3 ? 2 : 3);
const byUrg = (a2, b2) => urg(a2) - urg(b2) || (a2.due || '9').localeCompare(b2.due || '9');
function trow(x) {
  const m = who(x.member_id); const c = col(x);
  return `<li><a class="trow" href="${ref(x)}">${prioDot(x.prio)}<span class="rt"><b>${H.esc(x.title)}</b><small>${x.asg.kind === 'duty' ? `واجب ${FREQ[x.asg.freq]} · ` : ''}${H.esc(m?.name || '')} · <span class="${late(x) ? 'hot' : ''}">${dueTxt(x)}</span></small></span>
    <span class="tmeta">${x.comments ? `<span>${H.I('note')}${H.n(x.comments)}</span>` : ''}${x.photos.length ? `<span>${H.I('share')}${H.n(x.photos.length)}</span>` : ''}${c !== 'done' && c !== 'review' ? meter(x.prog, 'acc') : ''}<span class="sc s-${late(x) && c !== 'blocked' ? 'late' : c}">${late(x) && c !== 'blocked' ? 'متأخرة' : ST[c]}</span></span></a></li>`;
}

/* ═════════════ المهام: قائمة / لوحة / تقويم ═════════════ */
function vTasks() {
  const A = assigned();
  const f = H.S.tf;
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  if (qs.get('st') && f.st !== qs.get('st')) { f.st = qs.get('st'); }
  const v = H.S.tv || 'list';
  const head = H.vh('المتابعة', 'كل ما أسندته أنت أو غيرك لفريقك، وواجبات التوصيف', assignBtn());
  if (!A) return `<div class="wrap">${head}${tabs('tasks')}${H.loadingCard()}</div>`;
  if (A.error) return `<div class="wrap">${head}${tabs('tasks')}${H.errCard(A)}</div>`;
  const q = (f.q || '').trim().toLowerCase();
  let list = A.tasks.filter((x) => (!f.kind || x.asg.kind === f.kind) && (!f.dep || who(x.member_id)?.department_id === f.dep) && (!f.member || x.member_id === f.member)
    && (!q || `${x.title} ${who(x.member_id)?.name || ''} ${x.asg.desc || ''}`.toLowerCase().includes(q)));
  const by = { open: (x) => x.status !== 'done', late, blocked: (x) => x.status !== 'done' && !!x.blocked, review: (x) => col(x) === 'review', done: (x) => x.status === 'done', mine: (x) => x.asg.by === H.S.boot.me.id };
  const counts = Object.fromEntries(Object.entries(by).map(([k, fn]) => [k, list.filter(fn).length]));
  if (v !== 'board') list = list.filter(by[f.st || 'open'] || by.open);
  const chip = (k, l) => `<button class="chip" data-act="tst" data-v="${k}" aria-pressed="${(f.st || 'open') === k}">${l}${counts[k] ? ` <b>${H.n(counts[k])}</b>` : ''}</button>`;
  const deps = H.S.boot.departments.filter((d) => d.active);
  const ppl = canAssignTo();
  const bar = `<div class="filters tbar">
    <label class="srch">${H.I('search')}<input class="in" type="search" data-tq data-k="tq" placeholder="ابحث في المهام… ( / )" value="${H.esc(f.q || '')}" aria-label="بحث" /></label>
    ${deps.length > 1 ? `<select class="in" data-tf="dep" aria-label="الإدارة"><option value="">كل الإدارات</option>${deps.map((d) => `<option value="${H.esc(d.id)}"${d.id === f.dep ? ' selected' : ''}>${H.esc(d.name)}</option>`).join('')}</select>` : ''}
    <select class="in" data-tf="member" aria-label="الموظف"><option value="">كل الموظفين</option>${ppl.map((m) => `<option value="${H.esc(m.id)}"${m.id === f.member ? ' selected' : ''}>${H.esc(m.name)}</option>`).join('')}</select>
    <div class="seg" role="group" aria-label="النوع">${[['', 'الكل'], ['assign', 'مسندة'], ['duty', 'واجبات']].map(([k, l]) => `<button data-act="tkind" data-v="${k}" aria-pressed="${(f.kind || '') === k}">${l}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="طريقة العرض">${[['list', 'list', 'قائمة'], ['board', 'grid', 'لوحة'], ['cal', 'cal', 'تقويم']].map(([k, ic, l]) => `<button data-act="tv" data-v="${k}" aria-pressed="${v === k}">${H.I(ic)}<span>${l}</span></button>`).join('')}</div></div>
    ${v !== 'board' ? `<div class="filters">${chip('open', 'المفتوحة')}${chip('late', 'المتأخرة')}${chip('blocked', 'المتعثّرة')}${chip('review', 'بانتظار الاعتماد')}${chip('done', 'المنجزة')}${chip('mine', 'أسندتها أنا')}</div>` : ''}`;
  let body;
  if (v === 'board') {
    const cols = ['new', 'doing', 'blocked', 'review', 'done'];
    const weekAgo = Date.now() - 7 * 864e5;
    body = `<div class="kanban" role="list">${cols.map((k) => { const xs = list.filter((x) => col(x) === k && (k !== 'done' || (x.doneAt || 0) > weekAgo)).sort(byUrg);
      return `<section class="kcol k-${k}" role="listitem" aria-label="${ST[k]}"><h3>${ST[k]}<span>${H.n(xs.length)}</span></h3>${xs.slice(0, 60).map((x) => { const m = who(x.member_id);
        return `<a class="kcard${late(x) ? ' late' : ''}" href="${ref(x)}"><b>${prioDot(x.prio)}${H.esc(x.title)}</b><span class="km">${m ? `${H.avatar(m.name)}${H.esc(m.name)}` : ''}</span><span class="km"><span class="${late(x) ? 'hot' : ''}">${dueTxt(x)}</span>${x.comments ? `<span>${H.I('note')}${H.n(x.comments)}</span>` : ''}${x.photos.length ? `<span>${H.I('share')}${H.n(x.photos.length)}</span>` : ''}</span>${k === 'doing' || k === 'new' ? meter(x.prog, 'acc') : ''}${x.blocked ? `<small class="hot">${H.esc(x.blocked.slice(0, 70))}</small>` : ''}</a>`; }).join('') || '<p class="hint">—</p>'}</section>`; }).join('')}</div>
      <p class="hint">المنجزة: آخر ٧ أيام. الأعمدة تتغيّر بما يرفعه الموظف؛ القرار عندك في «بانتظار الاعتماد».</p>`;
  } else if (v === 'cal') body = calendar(list);
  else body = list.length ? `<ul class="tl2">${list.sort(byUrg).slice(0, 300).map(trow).join('')}</ul>` : `<div class="empty"><p>لا مهام في هذا التصنيف.</p>${ppl.length ? `<a class="btn primary sm" href="#/track/new">${H.I('plus')}إسناد مهمة</a>` : ''}</div>`;
  return `<div class="wrap">${head}${tabs('tasks')}<div class="card">${bar}${body}</div></div>`;
}
function calendar(list) {
  const base = H.S.calM || H.today().slice(0, 7);
  const [y, mo] = base.split('-').map(Number);
  const first = new Date(y, mo - 1, 1); const days = new Date(y, mo, 0).getDate();
  const lead = (first.getDay() + 1) % 7; // الأسبوع يبدأ السبت
  const by = new Map(); for (const x of list) if (x.due && x.due.startsWith(base)) { if (!by.has(x.due)) by.set(x.due, []); by.get(x.due).push(x); }
  const t = H.today();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cc off"></div>');
  for (let d = 1; d <= days; d++) {
    const k = `${base}-${String(d).padStart(2, '0')}`; const xs = (by.get(k) || []).sort(byUrg);
    cells.push(`<div class="cc${k === t ? ' today' : ''}"><span class="cd">${H.n(d)}</span>${xs.slice(0, 3).map((x) => `<a class="ce s-${late(x) ? 'late' : col(x)}" href="${ref(x)}" title="${H.esc(x.title)} · ${H.esc(who(x.member_id)?.name || '')}">${H.esc(x.title)}</a>`).join('')}${xs.length > 3 ? `<small>+${H.n(xs.length - 3)}</small>` : ''}</div>`);
  }
  const mName = new Intl.DateTimeFormat('ar-u-nu-latn', { month: 'long', year: 'numeric' }).format(first);
  const shift = (n2) => { const d = new Date(y, mo - 1 + n2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  return `<div class="calbar"><button class="ib" data-act="calm" data-v="${shift(-1)}" aria-label="الشهر السابق">${H.I('fwd')}</button><b>${mName}</b><button class="ib" data-act="calm" data-v="${shift(1)}" aria-label="الشهر التالي">${H.I('back')}</button><button class="btn sm" data-act="calm" data-v="${t.slice(0, 7)}">اليوم</button></div>
    <div class="cal" role="group" aria-label="تقويم ${mName}">${['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'].map((w) => `<div class="cw">${w}</div>`).join('')}${cells.join('')}</div>`;
}

/* ═════════════ تفاصيل مهمة ═════════════ */
function vTask(owner, tid) {
  const key = `task|${owner}|${tid}`;
  const D = H.need(key, () => H.call('GET', `/api/task/${encodeURIComponent(owner)}/${encodeURIComponent(tid)}`));
  const m = who(owner);
  const back = `<p style="margin:0 0 10px"><a class="link" style="color:var(--on-bg)" href="#/track/tasks">← المهام</a></p>`;
  if (!D) return `<div class="wrap">${back}${H.loadingCard()}</div>`;
  if (D.error) return `<div class="wrap">${back}${H.errCard(D)}</div>`;
  const x = D.task; const a = x.asg || {}; const c = col(x);
  const edit = H.S.edit.task === key && D.can_edit;
  const chips = `<span class="sc s-${late(x) && c !== 'blocked' ? 'late' : c}">${late(x) && c !== 'blocked' ? 'متأخرة' : ST[c]}</span><span class="tag p${x.prio}">${PR[x.prio]}</span>${a.kind === 'duty' ? `<span class="tag">واجب ${FREQ[a.freq]}</span>` : ''}`;
  const steps = x.steps.length ? `<ul class="chk">${x.steps.map((s) => `<li class="${s.done ? 'on' : ''}">${H.I(s.done ? 'check' : 'x')}<span>${H.esc(s.title)}</span></li>`).join('')}</ul>` : '';
  const rv = x.rv;
  const decide = D.can_review && x.status === 'done' ? `<form class="form-grid decide" data-form="tdecide" data-o="${H.esc(owner)}" data-t="${H.esc(tid)}">
      <label class="fld"><span>${rv?.state === 'ok' ? 'اعتمدتها. ملاحظة إضافية (اختياري)' : 'ملاحظتك (مطلوبة عند الإعادة)'}</span><textarea class="in auto" name="note" rows="2" maxlength="1000" data-k="dn"></textarea></label>
      <div class="row">${rv?.state !== 'ok' ? `<button class="btn ok" name="action" value="approve" type="submit">${H.I('check')}اعتماد</button>` : ''}<button class="btn warn" name="action" value="return" type="submit">${H.I('back')}إعادة للتعديل</button></div></form>` : '';
  const thread = D.comments.map((cm) => `<li class="${cm.author_id === H.S.boot.me.id ? 'me' : ''}"><b>${H.esc(cm.author || '—')}</b><time>${H.fTime.format(new Date(cm.at))}</time>${cm.body ? `<p>${H.esc(cm.body)}</p>` : ''}${cm.file_id ? photo(cm.file_id) : ''}</li>`).join('');
  const sumK = `sum|${owner}|${tid}`; const sum = H.S.cache.get(sumK);
  const comments = `<div class="card"><h2>${H.I('note')}النقاش · ${H.n(D.comments.length)}</h2>
    ${aiReady() && D.comments.length >= 3 ? `<div class="aisum">${sum ? (sum.error ? `<p class="hint">${H.esc(sum.error)}</p>` : `<p><b>${H.I('sparkle')}الملخص:</b> ${H.esc(sum.summary)}</p>${sum.open?.length ? `<ul>${sum.open.map((o) => `<li>${H.esc(o)}</li>`).join('')}</ul>` : ''}`) : `<button class="btn sm" data-act="tsum" data-o="${H.esc(owner)}" data-t="${H.esc(tid)}">${H.I('sparkle')}لخّص النقاش</button>`}</div>` : ''}
    ${thread ? `<ol class="thread">${thread}</ol>` : '<p class="hint">لا تعليقات بعد. اكتب هنا بدل واتساب: يبقى النقاش مع المهمة ويُرى سجله.</p>'}
    ${feat('comments') ? `<form data-form="tcomment" data-o="${H.esc(owner)}" data-t="${H.esc(tid)}" class="tcf"><textarea class="in auto" name="body" rows="1" maxlength="2000" data-k="tc|${H.esc(tid)}" placeholder="اكتب تعليقًا… ‎@الاسم للإشارة · Ctrl+Enter للإرسال"></textarea><button class="btn primary sm" type="submit">إرسال</button></form>` : '<p class="hint">التعليقات معطّلة في إعدادات الجهة.</p>'}</div>`;
  const trail = D.trail.length ? `<div class="card"><h2>${H.I('clock')}السجل</h2><ol class="trail">${D.trail.map((t) => `<li><b>${H.esc(t.actor || '—')}</b> ${H.ACTION[t.action] || H.esc(t.action)}<time>${H.fTime.format(new Date(t.at))}</time>${t.data?.note || t.data?.reason || t.data?.rpt ? `<p>${H.esc(t.data.note || t.data.reason || t.data.rpt)}</p>` : ''}</li>`).join('')}</ol></div>` : '';
  const editForm = edit ? `<form class="form-grid" data-form="tedit" data-o="${H.esc(owner)}" data-t="${H.esc(tid)}">
      <label class="fld"><span>العنوان</span><input class="in" name="title" required maxlength="200" value="${H.esc(x.title)}" /></label>
      <label class="fld"><span>الوصف</span><textarea class="in auto" name="desc" rows="2" maxlength="2000">${H.esc(a.desc || '')}</textarea></label>
      <div class="form-grid two"><label class="fld"><span>الموعد</span><input class="in" type="date" name="due" value="${H.esc(x.due || '')}" /></label>
      <label class="fld"><span>الأولوية</span><select class="in" name="prio">${[1, 2, 3].map((p) => `<option value="${p}"${x.prio === p ? ' selected' : ''}>${PR[p]}</option>`).join('')}</select></label></div>
      <div class="row"><label class="chk1"><input type="checkbox" name="review"${a.review ? ' checked' : ''} /> تحتاج اعتمادي</label><label class="chk1"><input type="checkbox" name="photo"${a.photo ? ' checked' : ''} /> تتطلب صورة</label></div>
      <div class="row"><button class="btn primary" type="submit">حفظ</button><button type="button" class="btn" data-act="tedit" data-v="">إلغاء</button><span class="spacer"></span><button type="button" class="btn warn" data-act="tcancel" data-o="${H.esc(owner)}" data-t="${H.esc(tid)}">${H.I('trash')}إلغاء المهمة</button></div></form>` : '';
  return `<div class="wrap">${back}
    ${H.vh(H.esc(x.title), `${m ? H.esc(m.name) : ''}${a.kind === 'assign' ? ` · أسندها ${H.esc(a.byName || '')}` : ' · من التوصيف الوظيفي'} · ${dueTxt(x)}`, `${chips}${D.can_edit && !edit ? `<button class="btn sm" data-act="tedit" data-v="${H.esc(key)}">تعديل</button>` : ''}`)}
    <div class="grid2"><div class="stack"><div class="card">${editForm || `
      ${a.desc ? `<p class="desc">${H.esc(a.desc)}</p>` : ''}
      <div class="progline">${meter(x.prog, 'acc')}<b>${H.n(x.prog)}٪</b>${x.est ? `<small>${H.I('hourglass')}تقدير ${H.mins(x.est)}${x.spent ? ` · فعلي ${H.mins(x.spent)}` : ''}</small>` : ''}</div>
      ${x.blocked ? `<div class="notice warn"><b>${H.I('fire')}متعثّرة</b><p>${H.esc(x.blocked)}</p></div>` : ''}
      ${rv?.state === 'returned' ? `<div class="notice warn"><b>أعادها ${H.esc(rv.byName || '')} للتعديل</b>${rv.note ? `<p>${H.esc(rv.note)}</p>` : ''}</div>` : rv?.state === 'ok' ? `<div class="notice ok"><b>اعتمدها ${H.esc(rv.byName || '')}</b>${rv.note ? `<p>${H.esc(rv.note)}</p>` : ''}</div>` : ''}
      ${steps}
      ${x.rpt ? `<div class="notice"><b>تقرير الموظف</b><p>${H.esc(x.rpt)}</p></div>` : '<p class="hint">لم يكتب الموظف تفاصيل الإنجاز بعد.</p>'}
      ${x.photos.length ? `<div class="phs">${x.photos.map(photo).join('')}</div>` : a.photo ? '<p class="hint">تتطلب صورة إنجاز، ولم تُرفق بعد.</p>' : ''}
      ${x.doneAt ? `<p class="hint">رُفعت منجزة ${H.fTime.format(new Date(x.doneAt))}${x.due ? (H.keyOf(new Date(x.doneAt)) <= x.due ? ' · في موعدها' : ' · بعد موعدها') : ''}</p>` : ''}
      ${decide}`}</div>${comments}</div><div class="stack">${trail}</div></div></div>`;
}

/* ═════════════ نموذج الإسناد ═════════════ */
function blankAssign() { return { title: '', desc: '', due: '', time: '', prio: 1, est: '', review: true, photo: false, steps: '', to: new Set(), q: '' }; }
function vAssign() {
  if (!H.S.af) H.S.af = blankAssign();
  const f = H.S.af;
  const pre = new URLSearchParams(location.hash.split('?')[1] || '').get('to');
  if (pre && !f._pre) { f.to.add(pre); f._pre = true; }
  const ppl = canAssignTo();
  const r = range();
  const M = H.S.cache.get(`met|${r.from}|${r.to}`) || metrics();
  const load = new Map((M && !M.error ? M.members : []).map((x) => [x.member_id, x.load.pct]));
  const q = (f.q || '').trim();
  const groups = new Map();
  for (const m of ppl) { const k = `${m.department_id || ''}|${m.section_id || ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const box = [...groups.entries()].map(([k, ms]) => {
    const [d, s] = k.split('|'); const vis = ms.filter((m) => !q || m.name.includes(q)); if (!vis.length) return '';
    const all = vis.every((m) => f.to.has(m.id));
    return `<fieldset class="grpbox"><legend>${H.esc(H.depById(d)?.name || 'بلا إدارة')}${s ? ` ‹ ${H.esc(H.secById(s)?.name || '')}` : ''}</legend>
      <button type="button" class="link" data-act="af-grp" data-v="${H.esc(vis.map((m) => m.id).join(','))}" data-on="${all ? '0' : '1'}">${all ? 'إلغاء الكل' : 'اختر الكل'}</button>
      ${vis.map((m) => { const lp = load.get(m.id); return `<label class="pick"><input type="checkbox" data-af-to="${H.esc(m.id)}"${f.to.has(m.id) ? ' checked' : ''} />${H.avatar(m.name)}<span class="pn">${H.esc(m.name)}<small>${H.esc(H.posById(m.position_id)?.title || H.ROLE[m.role])}</small></span>${lp != null ? `<em class="ld ${loadTone(lp)}" title="الحِمل في ٧ أيام">${pct(lp)}</em>` : ''}</label>`; }).join('')}</fieldset>`;
  }).join('');
  const over = [...f.to].filter((id) => (load.get(id) || 0) > 110).map((id) => who(id)?.name).filter(Boolean);
  return `<div class="wrap"><p style="margin:0 0 10px"><a class="link" style="color:var(--on-bg)" href="#/track/tasks">← المهام</a></p>
    ${H.vh('إسناد مهمة', 'تصل لمهام الموظف مباشرة، ويُنبَّه بها. يرفع إنجازه بالنسبة والتفاصيل والصور، وتعتمدها أنت.')}
    ${ppl.length ? `<form class="grid2" data-form="assign"><div class="card form-grid">
      <label class="fld"><span>المهمة</span><input class="in" data-af="title" name="title" required maxlength="200" value="${H.esc(f.title)}" placeholder="ابدأ بفعل: جهّز، راجع، سلّم…" data-k="af-title" autocomplete="off" /></label>
      <label class="fld"><span>التفاصيل ومعيار الإنجاز</span><textarea class="in auto" data-af="desc" rows="3" maxlength="2000" data-k="af-desc" placeholder="ما المطلوب بالضبط؟ متى تُعتبر منجزة؟">${H.esc(f.desc)}</textarea></label>
      <div class="form-grid two"><label class="fld"><span>الموعد</span><input class="in" type="date" data-af="due" min="${H.today()}" value="${H.esc(f.due)}" /></label>
        <label class="fld"><span>الوقت (اختياري)</span><input class="in" type="time" data-af="time" value="${H.esc(f.time)}" /></label></div>
      <div class="fld"><span>الأولوية</span><div class="seg prio" role="radiogroup" aria-label="الأولوية">${[1, 2, 3].map((p) => `<button type="button" role="radio" class="p${p}" data-act="af-prio" data-v="${p}" aria-checked="${f.prio === p}">${PR[p]}</button>`).join('')}</div>
        <small class="hint">حرجة = مهمة وعاجلة · مهمة = مهمة غير عاجلة · تظهر للموظف في مصفوفته بنفس التصنيف.</small></div>
      <label class="fld"><span>الوقت المتوقع</span><select class="in" data-af="est"><option value="">—</option>${[15, 30, 60, 90, 120, 180, 240, 480].map((x) => `<option value="${x}"${String(x) === String(f.est) ? ' selected' : ''}>${H.mins(x)}</option>`).join('')}</select></label>
      <div class="row"><label class="chk1"><input type="checkbox" data-af="review"${f.review ? ' checked' : ''} /> تحتاج اعتمادي بعد الإنجاز</label><label class="chk1"><input type="checkbox" data-af="photo"${f.photo ? ' checked' : ''} /> تتطلب صورة إثبات</label></div>
      <label class="fld"><span>خطوات (اختياري، سطر لكل خطوة)</span><textarea class="in auto" data-af="steps" rows="2" maxlength="1500" data-k="af-steps">${H.esc(f.steps)}</textarea></label>
      ${aiReady() ? `<button type="button" class="btn sm" data-act="af-ai">${H.I('sparkle')}اقترح خطوات بالذكاء الاصطناعي</button>` : ''}
    </div>
    <div class="stack"><div class="card"><h2>${H.I('people')}إلى · ${H.n(f.to.size)}</h2>
      <label class="srch">${H.I('search')}<input class="in" type="search" data-af="q" value="${H.esc(f.q)}" placeholder="ابحث باسم الموظف" aria-label="ابحث باسم الموظف" data-k="af-q" /></label>
      <div class="picks">${box || '<p class="hint">لا نتائج.</p>'}</div>
      ${over.length ? `<p class="notice warn" role="status">محمّل فوق طاقته هذا الأسبوع: ${over.map(H.esc).join('، ')}. فكّر في غيره أو موعد أبعد.</p>` : ''}
      <button class="btn primary big" type="submit"${f.to.size && f.title.trim() ? '' : ' disabled'}>${H.I('check')}إسناد${f.to.size > 1 ? ` إلى ${H.n(f.to.size)}` : ''} <kbd>Ctrl+Enter</kbd></button></div></div></form>`
      : '<div class="card"><div class="empty"><p>لا أحد يتبعك لتسند له.</p></div></div>'}</div>`;
}

/* ═════════════ التشغيل والتكامل (المسؤول) ═════════════ */
const FEAT_INFO = {
  comments: ['النقاش داخل المهمة', 'تعليقات بين الموظف ومديره على المهمة نفسها، مع إشارة @الاسم.', false],
  photos: ['صور إثبات الإنجاز', 'تُضغط في الجهاز وتُحفظ في قاعدة الجهة نفسها، وتُحذف بعد مدة الاحتفاظ.', false],
  ai: ['الذكاء الاصطناعي', 'الإدخال الصوتي، محضر الاجتماع، تقسيم المهمة، تلخيص النقاش. يعمل محليًا إن ربط الـIT نموذجًا على سيرفر الجهة، أو سحابيًا.', true],
  webhooks: ['الإشعارات الخارجية (Webhooks)', 'يرسل الأحداث لأنظمة أخرى: Slack أو Teams أو Google Chat أو ERP أو n8n، موقّعة بـ HMAC.', true],
  api: ['مفاتيح API', 'لنظام خارجي يقرأ المؤشرات ويُسند مهامًا ويصدّر البيانات. كل مفتاح يعمل باسمك، على مسارات محددة فقط.', true],
  ics: ['رابط التقويم', 'كل موظف يشترك في مهامه من Outlook أو Google Calendar أو تقويم الجوال برابط سري.', true],
};
const RULE_INFO = { assigned: 'عند إسناد مهمة أو تعديلها أو إلغائها: نبّه الموظف', done: 'عند إنجاز مهمة مسندة: نبّه من أسندها', blocked: 'عند التعثّر: نبّه المدير فورًا', returned: 'عند الاعتماد أو الإعادة: نبّه الموظف', comment: 'عند تعليق جديد: نبّه المشاركين ومن ذُكر', overdue: 'المتأخرات: تظهر للموظف ولمديره', dueSoon: 'قبل الموعد بيوم: ذكّر الموظف', report: 'إن لم يرفع تقريره بحلول الساعة المحددة: ذكّره' };
const EV_AR = { 'task.assigned': 'إسناد', 'task.done': 'إنجاز', 'task.blocked': 'تعثّر', 'task.approved': 'اعتماد', 'task.returned': 'إعادة', 'task.cancelled': 'إلغاء', 'comment.created': 'تعليق', 'report.submitted': 'رفع تقرير' };
const toggle = (name, on, label, desc, out) => `<label class="sw-row"><span><b>${label}</b>${out ? '<em class="out" title="يتصل بخارج شبكة الجهة أو يُستدعى منها">يحتاج موافقة IT</em>' : ''}<small>${desc}</small></span><input type="checkbox" class="sw" name="${name}"${on ? ' checked' : ''} /></label>`;
export function vOps() {
  const s = H.need('ops', () => H.call('GET', '/api/settings'));
  const keys = H.need('keys', () => H.call('GET', '/api/keys'));
  if (!s) return H.loadingCard();
  if (s.error) return H.errCard(s);
  const nk = H.S.newKey;
  const hooks = s.hooks.map((h, i) => `<div class="hookrow"><input type="hidden" name="hid" value="${H.esc(h.id)}" />
      <div class="form-grid two"><label class="fld"><span>الاسم</span><input class="in" name="hname" maxlength="60" value="${H.esc(h.name || '')}" /></label><label class="fld"><span>الرابط</span><input class="in" name="hurl" dir="ltr" maxlength="400" value="${H.esc(h.url)}" /></label></div>
      <div class="evs">${s.events.map((e) => `<label class="chk1"><input type="checkbox" name="hev${i}" value="${e}"${!h.events.length || h.events.includes(e) ? ' checked' : ''} />${EV_AR[e]}</label>`).join('')}</div>
      <div class="row"><label class="chk1"><input type="checkbox" name="hon${i}"${h.on ? ' checked' : ''} /> مفعّل</label><code class="secret" title="سر التوقيع: تحقّق به من ترويسة x-itrack-signature">${H.esc(h.secret.slice(0, 8))}…</code><button type="button" class="btn sm" data-act="hook-copy" data-v="${H.esc(h.secret)}">نسخ السر</button><button type="button" class="btn sm" data-act="hook-test" data-v="${H.esc(h.id)}">اختبار</button><button type="button" class="btn sm warn" data-act="hook-del" data-v="${i}">حذف</button></div></div>`).join('');
  const base = H.apiUrl || location.origin;
  return `<form class="grid2" data-form="ops"><div class="stack">
    <div class="card"><h2>${H.I('gear')}مفاتيح التشغيل</h2><p class="hint">كل ميزة تحتاج قرارًا من تقنية المعلومات لها مفتاح هنا. المعطّل يرفضه الخادم نفسه (لا يُخفى فقط)، ويُسجَّل كل تغيير في سجل التدقيق.</p>
      ${Object.entries(FEAT_INFO).map(([k, [l, d, out]]) => toggle(`f_${k}`, s.feat[k], l, d + (k === 'ai' ? ` <b>الخادم: ${s.ai_server ? `مربوط (${H.esc(s.ai_server)})` : 'غير مربوط — يضبطه الـIT بمتغير AI_URL'}</b>` : ''), out)).join('')}</div>
    <div class="card"><h2>${H.I('bell')}قواعد التنبيه التلقائي</h2><p class="hint">قواعد جاهزة بدل محرك أتمتة: كل حدث يصل لمن يعنيه داخل التطبيق، ولنظامك الخارجي إن فعّلت Webhooks.</p>
      ${Object.entries(RULE_INFO).map(([k, l]) => toggle(`r_${k}`, s.rules[k], l, '', false)).join('')}</div>
    <div class="card"><h2>${H.I('clock')}أيام العمل والتوقيت</h2>
      <div class="fld"><span>أيام العطلة الأسبوعية</span><div class="row">${WD.map((w, i) => `<label class="chk1"><input type="checkbox" name="wk" value="${i}"${s.weekend.includes(i) ? ' checked' : ''} />${w}</label>`).join('')}</div><small class="hint">الواجبات اليومية لا تُطلب فيها، ولا تُحسب في الحِمل.</small></div>
      <div class="form-grid two"><label class="fld"><span>ساعات العمل اليومية</span><select class="in" name="dayMin">${[360, 420, 480, 540].map((x) => `<option value="${x}"${s.dayMin === x ? ' selected' : ''}>${H.mins(x)}</option>`).join('')}</select></label>
      <label class="fld"><span>تذكير التقرير اليومي</span><select class="in" name="reportHour"><option value="-1"${s.reportHour < 0 ? ' selected' : ''}>بلا تذكير</option>${[12, 13, 14, 15, 16, 17, 18, 19, 20].map((h) => `<option value="${h}"${s.reportHour === h ? ' selected' : ''}>بعد الساعة ${h}:00</option>`).join('')}</select></label>
      <label class="fld"><span>المنطقة الزمنية</span><select class="in" name="tz">${[[180, 'اليمن / السعودية (+3)'], [240, 'الإمارات / عُمان (+4)'], [120, 'مصر (+2)'], [0, 'UTC']].map(([v, l]) => `<option value="${v}"${s.tz === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>الاحتفاظ بالصور</span><select class="in" name="photoDays">${[90, 180, 365, 730].map((x) => `<option value="${x}"${s.photoDays === x ? ' selected' : ''}>${H.n(x)} يومًا</option>`).join('')}</select></label></div></div>
    <div class="savebar"><span class="hint">التغيير يُطبَّق فورًا على كل الأعضاء.</span><button class="btn primary" type="submit">${H.I('check')}حفظ الإعدادات</button></div></div>
  <div class="stack">
    <div class="card"><h2>${H.I('share')}Webhooks ${s.feat.webhooks ? '' : '<span class="tag">معطّل</span>'}</h2>
      <p class="hint">لكل حدث طلب POST بصيغة JSON فيه حقل <code>text</code> جاهز لقنوات الدردشة، وترويسة <code dir="ltr">x-itrack-signature: sha256=HMAC(السر، الجسم)</code>.</p>
      ${hooks || '<p class="hint">لا روابط بعد.</p>'}
      <div class="hookrow new"><div class="form-grid two"><label class="fld"><span>اسم جديد</span><input class="in" name="nhname" maxlength="60" placeholder="قناة الإدارة" /></label><label class="fld"><span>رابط Webhook</span><input class="in" name="nhurl" dir="ltr" maxlength="400" placeholder="https://…" /></label></div></div></div>
    <div class="card"><h2>${H.I('doc')}مفاتيح API ${s.feat.api ? '' : '<span class="tag">معطّل</span>'}</h2>
      ${nk ? `<div class="notice ok" role="status"><b>انسخ المفتاح الآن، لن يظهر مرة أخرى:</b><pre class="invite" dir="ltr">${H.esc(nk)}</pre><button type="button" class="btn sm" data-act="key-copy">نسخ</button></div>` : ''}
      ${keys && !keys.error && keys.keys.length ? `<ul class="keys">${keys.keys.map((k) => `<li class="${k.revoked ? 'off' : ''}"><b>${H.esc(k.name)}</b><code dir="ltr">${H.esc(k.prefix)}…</code><small>${k.last_at ? `آخر استخدام ${H.fTime.format(new Date(k.last_at))}` : 'لم يُستخدم'}${k.revoked ? ' · ملغى' : ''}</small>${k.revoked ? '' : `<button type="button" class="btn sm warn" data-act="key-revoke" data-v="${H.esc(k.id)}">إلغاء</button>`}</li>`).join('')}</ul>` : '<p class="hint">لا مفاتيح.</p>'}
      <div class="row"><input class="in grow" name="kname" maxlength="60" placeholder="اسم النظام (مثال: ERPNext)" aria-label="اسم النظام" /><button type="button" class="btn" data-act="key-new"${s.feat.api ? '' : ' disabled'}>${H.I('plus')}مفتاح جديد</button></div>
      <details class="api-doc"><summary>أمثلة للمطوّر</summary><pre dir="ltr">curl -H "Authorization: Bearer itk_…" ${H.esc(base)}/api/metrics?from=2026-11-01&to=2026-11-30

curl -X POST -H "Authorization: Bearer itk_…" -H "content-type: application/json" \\
  -d '{"to":["MEMBER_ID"],"title":"…","due":"2026-11-20","prio":2,"review":true}' \\
  ${H.esc(base)}/api/assign

GET /api/assigned · GET /api/bootstrap · GET /api/export.csv?type=tasks|people
PATCH /api/assign/:member/:task · POST /api/assign/:member/:task/review</pre></details></div></div></form>`;
}

/* ═════════════ لوحة الأوامر Ctrl+K ═════════════ */
const pal = { open: false, q: '', i: 0 };
function commands() {
  const team = H.hasTeam();
  const c = [
    ['يومي: تقريري', '#/day', 'today'], ['مهامي', 'my/', 'note'],
    team && ['المتابعة: اللوحة', '#/track', 'chart'], team && ['المتابعة: المهام', '#/track/tasks', 'list'], team && ['إسناد مهمة جديدة', '#/track/new', 'plus'],
    team && ['المتابعة: التقارير اليومية', '#/team', 'people'],
    H.isAdmin() && ['الهيكل: الأعضاء', '#/org/members', 'people'], H.isAdmin() && ['الهيكل: الوظائف والتوصيف', '#/org/positions', 'doc'], H.isAdmin() && ['التشغيل والتكامل', '#/org/ops', 'gear'], H.isAdmin() && ['سجل التدقيق', '#/audit', 'list'],
    ['الإعدادات', '#/settings', 'gear'],
  ].filter(Boolean);
  if (team) for (const m of canAssignTo()) c.push([`موظف: ${m.name}`, `#/track/m/${encodeURIComponent(m.id)}`, 'user']);
  const q = pal.q.trim();
  return q ? c.filter(([l]) => l.includes(q)) : c;
}
function paintPal() {
  let el = document.getElementById('pal');
  if (!pal.open) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'pal'; el.className = 'pal'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'لوحة الأوامر'); document.body.appendChild(el); el.innerHTML = '<div class="pal-in"><input class="in" id="pal-q" placeholder="اذهب إلى… أو ابحث عن موظف" autocomplete="off" aria-controls="pal-l" /><ul id="pal-l" role="listbox"></ul><p class="hint"><kbd>↑</kbd><kbd>↓</kbd> تنقّل · <kbd>Enter</kbd> فتح · <kbd>Esc</kbd> إغلاق · <kbd>N</kbd> إسناد · <kbd>/</kbd> بحث</p></div>'; el.addEventListener('click', (e) => { if (e.target === el) closePal(); }); setTimeout(() => el.querySelector('#pal-q').focus(), 10); }
  const list = commands().slice(0, 40); pal.i = Math.min(pal.i, Math.max(0, list.length - 1));
  el.querySelector('#pal-l').innerHTML = list.map(([l, h, ic], i) => `<li role="option" aria-selected="${i === pal.i}"><a href="${h}" data-pal>${H.I(ic)}<span>${H.esc(l)}</span></a></li>`).join('') || '<li class="hint">لا نتائج.</li>';
}
const closePal = () => { pal.open = false; pal.q = ''; pal.i = 0; paintPal(); };
document.addEventListener('keydown', (e) => {
  if (!H?.S.boot) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.id !== 'pal-q';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.open = !pal.open; paintPal(); return; }
  if (pal.open) {
    const list = commands();
    if (e.key === 'Escape') { e.preventDefault(); closePal(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); pal.i = Math.min(pal.i + 1, list.length - 1); paintPal(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pal.i = Math.max(pal.i - 1, 0); paintPal(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = list[pal.i]; closePal(); if (c) location.href = c[1]; }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement?.closest('form[data-form="assign"],form[data-form="tcomment"]')) { e.preventDefault(); document.activeElement.closest('form').requestSubmit(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N' || e.code === 'KeyN') { if (H.hasTeam()) { e.preventDefault(); location.hash = '#/track/new'; } }
  else if (e.key === '/') { const s = document.querySelector('[data-tq]'); if (s) { e.preventDefault(); s.focus(); } }
});
document.addEventListener('input', (e) => { if (e.target.id === 'pal-q') { pal.q = e.target.value; pal.i = 0; paintPal(); } });
document.addEventListener('click', (e) => { if (e.target.closest('[data-pal]')) closePal(); });

/* ═════════════ الأحداث (يستدعيها app.js) ═════════════ */
export function click(act, el) {
  const S = H.S;
  switch (act) {
    case 'tp': S.tp = el.dataset.v; H.render(); return true;
    case 'tdep': S.f.tdep = S.f.tdep === el.dataset.v ? '' : el.dataset.v; H.render(); return true;
    case 'tst': S.tf.st = el.dataset.v; if (location.hash.includes('?')) history.replaceState(null, '', '#/track/tasks'); H.render(); return true;
    case 'tkind': S.tf.kind = el.dataset.v; H.render(); return true;
    case 'tv': S.tv = el.dataset.v; H.store.set('it:tv', S.tv); H.render(); return true;
    case 'calm': S.calM = el.dataset.v; H.render(); return true;
    case 'csv': { const r = range(); download(`/api/export.csv?type=${el.dataset.v}&from=${r.from}&to=${r.to}`, `itrack-${el.dataset.v}-${r.from}_${r.to}.csv`).then(() => H.toast('نُزّل الملف. افتحه في Excel.'), (er) => H.toast(er.message)); return true; }
    case 'af-prio': S.af.prio = Number(el.dataset.v); H.render(); return true;
    case 'af-grp': { const ids = el.dataset.v.split(','); ids.forEach((id) => (el.dataset.on === '1' ? S.af.to.add(id) : S.af.to.delete(id))); H.render(); return true; }
    case 'af-ai': {
      if (!S.af.title.trim()) { H.toast('اكتب عنوان المهمة أولًا.'); return true; }
      el.disabled = true; el.textContent = 'يقترح…';
      H.call('POST', '/api/ai/steps', { title: S.af.title, desc: S.af.desc }).then((d) => { S.af.steps = [S.af.steps.trim(), ...d.steps].filter(Boolean).join('\n'); H.toast('أُضيفت خطوات مقترحة؛ عدّلها قبل الإسناد.'); }, (er) => H.toast(er.message)).finally(() => H.render());
      return true;
    }
    case 'tedit': S.edit.task = el.dataset.v || null; H.render(); return true;
    case 'tcancel': {
      if (!confirm('إلغاء المهمة نهائيًا؟ تُحذف من مهام الموظف مع تعليقاتها وصورها، ويبقى أثرها في السجل.')) return true;
      H.call('POST', `/api/assign/${encodeURIComponent(el.dataset.o)}/${encodeURIComponent(el.dataset.t)}/cancel`, {}).then(() => { H.drop('asg', 'met|', 'task|', 'inbox'); S.edit.task = null; location.hash = '#/track/tasks'; H.toast('أُلغيت المهمة.'); }, (er) => H.toast(er.message));
      return true;
    }
    case 'tsum': {
      const k = `sum|${el.dataset.o}|${el.dataset.t}`; el.disabled = true; el.textContent = 'يلخّص…';
      H.call('POST', '/api/ai/summary', { owner: el.dataset.o, task: el.dataset.t }).then((d) => S.cache.set(k, d), (er) => S.cache.set(k, { error: er.message })).finally(() => H.render());
      return true;
    }
    case 'hook-copy': navigator.clipboard?.writeText(el.dataset.v).then(() => H.toast('نُسخ السر.')); return true;
    case 'hook-test': H.call('POST', `/api/settings/hooks/${encodeURIComponent(el.dataset.v)}/test`, {}).then((r) => H.toast(r.ok ? `وصل (HTTP ${r.status}).` : `لم يصل${r.status ? ` (HTTP ${r.status})` : ''}. تحقّق من الرابط.`), (er) => H.toast(er.message)); return true;
    case 'hook-del': { const s = S.cache.get('ops'); if (s) { s.hooks.splice(Number(el.dataset.v), 1); S.opsDirty = true; H.render(); H.toast('احفظ الإعدادات لتطبيق الحذف.'); } return true; }
    case 'key-new': {
      const name = el.closest('form').elements.kname.value.trim(); if (!name) { H.toast('اكتب اسم النظام.'); return true; }
      H.call('POST', '/api/keys', { name }).then((r) => { S.newKey = r.key; H.drop('keys', 'audit'); H.render(); }, (er) => H.toast(er.message)); return true;
    }
    case 'key-copy': navigator.clipboard?.writeText(S.newKey || '').then(() => H.toast('نُسخ المفتاح.')); return true;
    case 'key-revoke': if (confirm('إلغاء المفتاح؟ يتوقف النظام الذي يستخدمه فورًا.')) H.call('POST', `/api/keys/${encodeURIComponent(el.dataset.v)}/revoke`, {}).then(() => { H.drop('keys', 'audit'); H.render(); H.toast('أُلغي المفتاح.'); }, (er) => H.toast(er.message)); return true;
    default: return false;
  }
}
/** حقول النماذج المحفوظة في الحالة (لا تضيع إن أعيد الرسم أثناء الكتابة). */
export function input(el) {
  const S = H.S;
  if (el.dataset.af !== undefined && S.af) {
    const k = el.dataset.af; S.af[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'q' || k === 'title') H.render();
    return true;
  }
  if (el.dataset.afTo !== undefined && S.af) { if (el.checked) S.af.to.add(el.dataset.afTo); else S.af.to.delete(el.dataset.afTo); H.render(); return true; }
  if (el.dataset.tq !== undefined) { S.tf.q = el.value; H.render(); return true; }
  if (el.dataset.tf && ['dep', 'member'].includes(el.dataset.tf)) { S.tf[el.dataset.tf] = el.value; H.render(); return true; }
  return false;
}
export async function submit(form, fd, btn) {
  const S = H.S; const get = (k) => (fd.get(k) || '').toString().trim();
  switch (form.dataset.form) {
    case 'assign': {
      const f = S.af;
      if (!f.title.trim() || !f.to.size) { H.toast('اكتب المهمة واختر من تسندها له.'); return true; }
      if (btn) btn.disabled = true;
      try {
        const r = await H.call('POST', '/api/assign', { to: [...f.to], title: f.title.trim(), desc: f.desc.trim(), due: f.due || null, time: f.time || null, prio: f.prio, est: f.est ? Number(f.est) : null, review: !!f.review, photo: !!f.photo, steps: f.steps.split('\n').map((x) => x.trim()).filter(Boolean) });
        H.drop('asg', 'met|', 'inbox', 'audit'); S.af = null;
        H.toast(`أُسندت إلى ${H.n(r.ids.length)}، ووصلهم التنبيه.`);
        location.hash = r.ids.length === 1 ? `#/track/t/${encodeURIComponent(r.ids[0].member_id)}/${encodeURIComponent(r.ids[0].id)}` : '#/track/tasks';
      } catch (er) { H.toast(er.message); if (btn) btn.disabled = false; }
      return true;
    }
    case 'tdecide': {
      const action = btn?.value; const note = get('note');
      if (action === 'return' && !note) { H.toast('اكتب ما المطلوب تعديله حتى يعرف الموظف.'); form.elements.note.focus(); return true; }
      try {
        await H.call('POST', `/api/assign/${encodeURIComponent(form.dataset.o)}/${encodeURIComponent(form.dataset.t)}/review`, { action, note });
        H.drop('asg', 'met|', `task|${form.dataset.o}|${form.dataset.t}`, 'inbox');
        H.toast(action === 'approve' ? 'اعتُمدت.' : 'أُعيدت للموظف بملاحظتك.');
      } catch (er) { H.toast(er.message); }
      H.render(); return true;
    }
    case 'tcomment': {
      const body = get('body'); if (!body) return true;
      if (btn) btn.disabled = true;
      try { await H.call('POST', `/api/task/${encodeURIComponent(form.dataset.o)}/${encodeURIComponent(form.dataset.t)}/comments`, { body }); form.reset(); H.drop(`task|${form.dataset.o}|${form.dataset.t}`, 'asg'); }
      catch (er) { H.toast(er.message); }
      if (btn) btn.disabled = false; H.render(); return true;
    }
    case 'tedit': {
      const body = { title: get('title'), desc: get('desc'), due: get('due') || null, prio: Number(get('prio')) || 1, review: fd.get('review') === 'on', photo: fd.get('photo') === 'on' };
      try { await H.call('PATCH', `/api/assign/${encodeURIComponent(form.dataset.o)}/${encodeURIComponent(form.dataset.t)}`, body); S.edit.task = null; H.drop('asg', 'met|', `task|${form.dataset.o}|${form.dataset.t}`); H.toast('حُفظ، ووصل التعديل للموظف.'); }
      catch (er) { H.toast(er.message); }
      H.render(); return true;
    }
    case 'ops': {
      const s = S.cache.get('ops'); if (!s) return true;
      const feat = Object.fromEntries(Object.keys(FEAT_INFO).map((k) => [k, fd.get(`f_${k}`) === 'on']));
      const rules = Object.fromEntries(Object.keys(RULE_INFO).map((k) => [k, fd.get(`r_${k}`) === 'on']));
      const hids = fd.getAll('hid'); const hn = fd.getAll('hname'); const hu = fd.getAll('hurl');
      const hooks = hids.map((id, i) => ({ id, name: String(hn[i] || ''), url: String(hu[i] || ''), events: fd.getAll(`hev${i}`), on: fd.get(`hon${i}`) === 'on' }));
      if (get('nhurl')) hooks.push({ name: get('nhname'), url: get('nhurl'), events: [], on: true });
      if (hooks.some((h) => h.events.length === s.events.length)) hooks.forEach((h) => { if (h.events.length === s.events.length) h.events = []; });
      const body = { feat, rules, hooks, weekend: fd.getAll('wk').map(Number), dayMin: Number(get('dayMin')), reportHour: Number(get('reportHour')), tz: Number(get('tz')), photoDays: Number(get('photoDays')) };
      if (feat.ai && !s.feat.ai && !confirm('تفعيل الذكاء الاصطناعي؟ تأكّد أن قسم تقنية المعلومات وافق على المزوّد (محلي أو سحابي).')) return true;
      if (btn) btn.disabled = true;
      try {
        const r = await H.call('PUT', '/api/settings', body);
        if (hooks.some((h) => h.url) && r.hooks.length < hooks.filter((h) => h.url).length) H.toast('رابط غير صالح لم يُحفظ (http أو https فقط).');
        else H.toast('حُفظت الإعدادات.');
        S.cache.set('ops', r); S.opsDirty = false; H.drop('audit', 'keys'); await H.loadBoot(true);
      } catch (er) { H.toast(er.message); }
      if (btn) btn.disabled = false; H.render(); return true;
    }
    default: return false;
  }
}

/* ═════════════ للموظف: التنبيهات، التقويم، ملء التقرير من مهامي ═════════════ */
const NOTE_IC = { assigned: 'plus', edited: 'doc', cancelled: 'x', done: 'check', blocked: 'fire', approved: 'check', returned: 'back', comment: 'note' };
export function notesCard() {
  const ib = H.inbox();
  if (!ib || ib.error) return '';
  const alerts = (ib.alerts || []).filter((a) => a.kind !== 'report');
  const unread = (ib.notes || []).filter((x) => !x.read_at).slice(0, 8);
  if (!unread.length && !alerts.length) return '';
  const AL = { overdue: (a) => `فات موعد «${H.esc(a.title)}» (${H.rel(a.due)})`, soon: (a) => `«${H.esc(a.title)}» موعدها ${H.rel(a.due)}`, returned: (a) => `أُعيدت لك «${H.esc(a.title)}»${a.note ? `: ${H.esc(a.note.slice(0, 60))}` : ''}` };
  return `<div class="card notes"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${H.I('bell')}تنبيهاتك${unread.length ? ` · ${H.n(unread.length)}` : ''}</h2>${unread.length ? '<button class="btn sm" data-act="notes-read">تعليم الكل كمقروء</button>' : ''}</div>
    <ul class="nlist">${alerts.slice(0, 5).map((a) => `<li class="al-${a.kind}"><a href="my/">${H.I(a.kind === 'overdue' ? 'fire' : a.kind === 'returned' ? 'back' : 'clock')}<span>${AL[a.kind]?.(a) || ''}</span></a></li>`).join('')}
    ${unread.map((x) => { const h = x.task_id && x.owner_id && x.owner_id !== H.S.boot.me.id ? `#/track/t/${encodeURIComponent(x.owner_id)}/${encodeURIComponent(x.task_id)}` : 'my/';
      return `<li><a href="${h}">${H.I(NOTE_IC[x.kind] || 'bell')}<span>${H.esc(x.text)}<small>${H.fTime.format(new Date(x.at))}</small></span></a></li>`; }).join('')}</ul></div>`;
}
export function icsCard() {
  if (!feat('ics')) return '';
  const url = H.S.icsUrl;
  return `<div class="card"><h2>${H.I('clock')}مهامي في تقويمي</h2><p class="hint">رابط سري تشترك به من Outlook (إضافة تقويم ← من الإنترنت) أو Google Calendar (من عنوان URL) أو الجوال. يُحدَّث تلقائيًا.</p>
    ${url ? `<pre class="invite" dir="ltr">${H.esc(url)}</pre><div class="row"><button class="btn sm" data-act="ics-copy">نسخ الرابط</button></div><p class="hint">لا تشاركه: من يملكه يرى عناوين مهامك. إنشاء رابط جديد يلغي القديم.</p>` : ''}
    <button class="btn" data-act="ics-new" style="margin-top:8px">${url ? 'رابط جديد (يلغي القديم)' : 'أنشئ الرابط'}</button></div>`;
}
export function clickEmployee(act) {
  const S = H.S;
  if (act === 'notes-read') { H.call('POST', '/api/notes/read', { all: true }).then(() => { H.drop('inbox'); H.render(); }); return true; }
  if (act === 'ics-new') { H.call('POST', '/api/ics', {}).then((r) => { S.icsUrl = (H.apiUrl || location.origin) + r.path; H.render(); }, (er) => H.toast(er.message)); return true; }
  if (act === 'ics-copy') { navigator.clipboard?.writeText(S.icsUrl || '').then(() => H.toast('نُسخ الرابط.')); return true; }
  return false;
}
/** التقرير يكتب نفسه: بنود اليوم من مهامي (المنجز، ما تقدّم فيه، المتعثّر) بدل الكتابة من الصفر. */
export async function draftFromTasks(day) {
  const { docs } = await H.call('GET', '/api/p/tasks');
  const sameDay = (iso) => iso && H.keyOf(new Date(iso)) === day;
  const out = [];
  for (const t of docs) {
    const doneToday = t.status === 'done' && (sameDay(t.completedAt) || (t.doneAt && H.keyOf(new Date(t.doneAt)) === day));
    const touched = t.status !== 'done' && ((t.prog || 0) > 0 || t.blocked) && t.updated_at && H.keyOf(new Date(t.updated_at)) === day;
    const focus = (t.focusLog || []).find(([d]) => d === day);
    if (!doneToday && !touched && !focus) continue;
    const state = doneToday ? 'done' : t.blocked ? 'blocked' : 'progress';
    const text = `${t.title}${t.rpt ? ` — ${t.rpt}` : state === 'progress' && t.prog ? ` (${t.prog}٪)` : ''}`.slice(0, 600);
    out.push({ id: null, text, responsibility_id: t.asg?.kind === 'duty' ? t.asg.rid : null, minutes: focus ? Math.min(960, Math.round(focus[1])) || null : null, state, blocker: state === 'blocked' ? String(t.blocked).slice(0, 400) : '' });
  }
  return out;
}
