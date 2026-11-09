// ITrack — استيراد التوصيف الوظيفي من ملف: Excel (xlsx) وCSV وWord (docx) وPDF ونص ملصوق ← واجبات قابلة للمراجعة.
// يعمل كله في المتصفح: لا يُرفع الملف لأي خادم ولا يحتاج ذكاءً اصطناعيًا. القواعد هنا حتمية ومعلنة:
//  • جدول بعناوين (المهمة/التكرار/الأولوية/المدة/التفاصيل): تُقرأ الأعمدة بأسمائها.
//  • نص حر (قوائم نقطية أو مرقّمة أو أسطر): كل بند واجب، وعناوين مثل «المهام اليومية» تحدد التكرار لما تحتها،
//    ويُقتصر على قسم «المهام/المسؤوليات» إن وُجد ويُتجاهل «المؤهلات/الخبرات».
//  • ما لا يُعرف يبقى فارغًا (لا نخمّن تكرارًا ولا مدة)، والمستخدم يراجع كل شيء قبل الحفظ.
// PDF: يستخدم pdf.js (Apache-2.0) المضمَّنة محليًا في js/ وتُحمَّل عند اختيار PDF فقط. انظر docs/IT-REVIEW.md.
const MAX_FILE = 8 * 1024 * 1024;       // حجم الملف
const MAX_UNZIP = 40 * 1024 * 1024;     // حدّ فك الضغط (حماية من zip bomb)
const MAX_DUTIES = 40;                  // حدّ الخادم لكل وظيفة
const AR = '٠١٢٣٤٥٦٧٨٩', FA = '۰۱۲۳۴۵۶۷۸۹';

/** توحيد النص العربي للمقارنة فقط: تشكيل وتطويل وهمزات وتاء مربوطة وأرقام هندية. */
export const norm = (s = '') => String(s).normalize('NFKC').replace(/[ً-ٰٟـ‎‏‪-‮]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
  .replace(/[٠-٩]/g, (d) => AR.indexOf(d)).replace(/[۰-۹]/g, (d) => FA.indexOf(d)).toLowerCase().replace(/\s+/g, ' ').trim();
const rx = (...w) => new RegExp(w.map(norm).join('|'));
const clean = (s = '') => String(s).normalize('NFKC').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();

/* ═════════════ قراءة الملفات ═════════════ */
async function inflateRaw(u8, cap) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {});
  const r = ds.readable.getReader(); const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await r.read(); if (done) break;
    n += value.length; if (n > cap) { r.cancel().catch(() => {}); throw new Error('محتوى الملف المضغوط أكبر من المسموح.'); }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function openZip(buf) {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  let e = -1; for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('الملف تالف أو ليس بالصيغة المتوقعة.');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  if (n > 5000) throw new Error('الملف يحوي عددًا غير معتاد من المكونات.');
  const files = new Map(); const td = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) break;
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    files.set(td.decode(u8.subarray(p + 46, p + 46 + nl)), { flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true), off: dv.getUint32(p + 42, true) });
    p += 46 + nl + el + cl;
  }
  return {
    has: (name) => files.has(name),
    async text(name) {
      const f = files.get(name); if (!f) throw new Error('جزء ناقص في الملف.');
      if (f.flags & 1) throw new Error('الملف محمي بكلمة مرور؛ أزل الحماية ثم أعد المحاولة.');
      if (f.usize > MAX_UNZIP) throw new Error('محتوى الملف أكبر من المسموح.');
      const ln = dv.getUint16(f.off + 26, true), le = dv.getUint16(f.off + 28, true); const s = f.off + 30 + ln + le;
      const data = u8.subarray(s, s + f.csize);
      const raw = f.method === 0 ? data : f.method === 8 ? await inflateRaw(data, MAX_UNZIP) : null;
      if (!raw) throw new Error('طريقة ضغط غير مدعومة.');
      return new TextDecoder('utf-8').decode(raw);
    },
  };
}
const xml = (s) => { const d = new DOMParser().parseFromString(s, 'application/xml'); if (d.getElementsByTagName('parsererror').length) throw new Error('تعذّر قراءة محتوى الملف.'); return d; };
const ln = (el) => el.localName || el.nodeName.split(':').pop();
const kids = (el, name) => [...el.children].filter((c) => ln(c) === name);

async function readXlsx(buf) {
  const z = await openZip(buf);
  if (!z.has('xl/workbook.xml')) throw new Error('ليس ملف Excel بصيغة xlsx. إن كان xls قديمًا فاحفظه من Excel كـ xlsx أو CSV.');
  const wb = xml(await z.text('xl/workbook.xml'));
  const rels = z.has('xl/_rels/workbook.xml.rels') ? xml(await z.text('xl/_rels/workbook.xml.rels')) : null;
  const target = new Map(rels ? [...rels.getElementsByTagName('Relationship')].map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]) : []);
  const sheets = [...wb.getElementsByTagName('sheet')].map((s, i) => ({ state: s.getAttribute('state'), path: (() => { const t = target.get(s.getAttribute('r:id') || '') || `worksheets/sheet${i + 1}.xml`; return t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`; })() }));
  const sst = [];
  if (z.has('xl/sharedStrings.xml')) for (const si of xml(await z.text('xl/sharedStrings.xml')).getElementsByTagName('si')) sst.push([...si.getElementsByTagName('t')].filter((t) => ln(t.parentNode) !== 'rPh').map((t) => t.textContent).join(''));
  const colIdx = (ref) => { let n = 0; for (const ch of (ref.match(/^[A-Z]+/i) || [''])[0].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const tables = [];
  for (const sh of sheets) {
    if (sh.state === 'hidden' || sh.state === 'veryHidden' || !z.has(sh.path)) continue;
    const rows = [];
    for (const row of xml(await z.text(sh.path)).getElementsByTagName('row')) {
      const cells = []; let k = 0;
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r'); const i = ref ? colIdx(ref) : k; k = i + 1; if (i > 40) continue;
        const t = c.getAttribute('t'); const v = kids(c, 'v')[0]?.textContent ?? '';
        cells[i] = t === 's' ? sst[Number(v)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map((x) => x.textContent).join('') : v;
      }
      const r = Array.from(cells, (x) => clean(x ?? '')); while (r.length && !r[r.length - 1]) r.pop();
      rows.push(r); if (rows.length >= 3000) break;
    }
    if (rows.some((r) => r.some(Boolean))) tables.push(rows);
  }
  if (!tables.length) throw new Error('لا بيانات في الملف.');
  return { tables, lines: tables[0].map(rowLine).filter(Boolean), strict: false };
}
const rowLine = (r) => { const c = r.filter(Boolean); return c.length === 2 ? `${c[0]} : ${c[1]}` : c.join(' | '); };

async function readDocx(buf) {
  const z = await openZip(buf);
  if (!z.has('word/document.xml')) throw new Error('ليس ملف Word بصيغة docx. إن كان doc قديمًا فاحفظه من Word كـ docx.');
  const body = [...xml(await z.text('word/document.xml')).getElementsByTagName('*')].find((e) => ln(e) === 'body');
  const ptext = (p) => { let s = ''; for (const n of p.getElementsByTagName('*')) { const t = ln(n); if (t === 't') s += n.textContent; else if (t === 'tab') s += ' '; else if (t === 'br') s += ' '; } return clean(s); };
  const lines = []; const tables = [];
  for (const el of body ? [...body.children] : []) {
    if (ln(el) === 'p') { const t = ptext(el); if (t) lines.push(t); }
    else if (ln(el) === 'tbl') {
      const rows = kids(el, 'tr').map((tr) => kids(tr, 'tc').map((tc) => clean([...tc.getElementsByTagName('*')].filter((x) => ln(x) === 'p').map(ptext).filter(Boolean).join(' '))));
      if (rows.length) { tables.push(rows); for (const r of rows) { const l = rowLine(r); if (l) lines.push(l); } }
    }
  }
  return { tables, lines, strict: false, wrap: false };
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { try { return new TextDecoder('windows-1256').decode(buf); } catch { return new TextDecoder().decode(buf); } }
}
export function parseCsv(text) {
  const head = text.split(/\r?\n/).slice(0, 8).join('\n');
  const d = [',', ';', '\t'].map((c) => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += ch;
    if (rows.length > 3000) break;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => { const x = r.map(clean); while (x.length && !x[x.length - 1]) x.pop(); return x; });
}

async function readPdf(buf) {
  const pdfjs = await import('./pdfjs.js');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs-worker.js', import.meta.url).href;
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false }).promise; }
  catch (e) { throw new Error(e?.name === 'PasswordException' ? 'الملف محمي بكلمة مرور؛ أزل الحماية ثم أعد المحاولة.' : 'تعذّرت قراءة ملف PDF.'); }
  const lines = []; const tables = []; let chars = 0;
  for (let pn = 1; pn <= Math.min(doc.numPages, 40); pn++) {
    const tc = await (await doc.getPage(pn)).getTextContent();
    const items = tc.items.filter((i) => typeof i.str === 'string' && i.str.trim()).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[0]) || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const grp = []; for (const it of items) { const g = grp[grp.length - 1]; if (g && Math.abs(g.y - it.y) <= Math.max(2.5, it.h * 0.35)) g.items.push(it); else grp.push({ y: it.y, items: [it] }); }
    const rows = [];
    for (const g of grp) {
      const all = g.items.map((x) => x.s).join('').replace(/\s/g, '');
      const rtl = (all.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length * 2 > all.length; // يشمل أشكال الحروف العرضية التي يعيدها pdf.js
      g.items.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
      const cells = []; let cur = '', prev = null;
      for (const it of g.items) {
        if (prev) {
          const gap = rtl ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w);
          if (gap > Math.max(14, it.h * 1.6)) { cells.push(cur); cur = ''; } else if (gap > it.h * 0.12 && !/\s$/.test(cur) && !/^\s/.test(it.s)) cur += ' ';
        }
        cur += it.s; prev = it;
      }
      cells.push(cur);
      const MIR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
      // الأقواس تُعكس في الاتجاه من اليمين
      const r = cells.map((c) => clean(rtl ? c.replace(/[()[\]{}<>]/g, (m) => MIR[m]) : c)).filter(Boolean);
      if (r.length) { rows.push(r); lines.push(r.join(' ')); chars += lines[lines.length - 1].length; }
    }
    if (rows.length) tables.push(rows);
  }
  if (chars < 20) throw new Error('لا نص في ملف PDF (ربما صورة ممسوحة ضوئيًا). الصق النص يدويًا أو ارفع ملف Word/Excel.');
  return { tables: [tables.flat()], lines, strict: true, wrap: true };
}

/** يقرأ ملفًا ويعيد { tables, lines, strict, wrap } للاستخراج. */
export async function readSource(file) {
  if (!file) throw new Error('لم يُختر ملف.');
  if (file.size > MAX_FILE) throw new Error('الملف أكبر من ٨ ميغابايت.');
  const name = (file.name || '').toLowerCase(); const buf = await file.arrayBuffer();
  if (/\.xlsx$|\.xlsm$/.test(name)) return readXlsx(buf);
  if (/\.docx$/.test(name)) return readDocx(buf);
  if (/\.pdf$/.test(name) || file.type === 'application/pdf') return readPdf(buf);
  if (/\.(csv|tsv)$/.test(name)) { const rows = parseCsv(decodeText(buf)); return { tables: [rows], lines: rows.map(rowLine).filter(Boolean), strict: false }; }
  if (/\.txt$/.test(name) || file.type.startsWith('text/')) return fromText(decodeText(buf));
  if (/\.(xls|doc)$/.test(name)) throw new Error('هذه صيغة Office قديمة. افتحها واحفظها بصيغة xlsx أو docx ثم أعد المحاولة.');
  throw new Error('صيغة غير مدعومة. المدعوم: xlsx، csv، docx، pdf، txt.');
}
export function fromText(text) {
  const lines = String(text).split(/\r?\n/).map(clean).filter(Boolean);
  return { tables: [], lines, strict: true, wrap: true };
}

/* ═════════════ الاستخراج ═════════════ */
const freqOf = (s) => {
  const n = norm(s);
  if (/يومي|كل يوم|daily|everyday/.test(n)) return 'daily';
  if (/اسبوعي|كل اسبوع|weekly/.test(n)) return 'weekly';
  if (/شهري|كل شهر|monthly/.test(n)) return 'monthly';
  return '';
};
const OTHER_FREQ = /ربع سنوي|ربعي|نصف سنوي|سنوي|كل سنه|كل عام|quarterly|annual|yearly/;
const prioOf = (s) => { const n = norm(s); if (/حرج|عاجل|critical|urgent/.test(n) || n === '3') return 3; if (/عالي|مهم|high|important/.test(n) || n === '2') return 2; return 1; };
function estOf(s, hours) {
  const n = norm(s); if (!n) return null;
  if (/نصف ساعه/.test(n)) return 30; if (/ربع ساعه/.test(n)) return 15; if (/ساعتين|ساعتان/.test(n)) return 120;
  const m = n.match(/(\d+(?:[.,]\d+)?)\s*(ساع|hour|hr|h\b|دقيق|د\b|min|m\b)?/); if (!m) return null;
  let x = parseFloat(m[1].replace(',', '.')); if (/ساع|hour|hr|^h/.test(m[2] || '') || (!m[2] && hours)) x *= 60;
  x = Math.round(x); return x >= 5 && x <= 960 ? x : null;
}
const CATS = [
  ['detail', rx('تفاصيل', 'وصف', 'ملاحظ', 'معيار', 'شرح', 'detail', 'desc', 'note', 'criteria')],
  ['freq', rx('تكرار', 'دوري', 'تواتر', 'عدد مرات', 'freq', 'period', 'recurr')],
  ['prio', rx('اولوي', 'اهمي', 'priority', 'importance')],
  ['est', rx('مده', 'وقت', 'زمن', 'دقيق', 'ساعه', 'duration', 'time', 'minutes', 'hours', 'est')],
  ['title', rx('مهم', 'مسؤولية', 'مسؤوليات', 'واجب', 'بند', 'نشاط', 'عمل', 'task', 'duty', 'duties', 'responsib', 'title', 'item', 'activity')],
];
const catOf = (cell) => { const n = norm(cell); if (!n || n.length > 40) return ''; return (CATS.find(([, re]) => re.test(n)) || [''])[0]; };
const HEAD_DUTY = rx('المهام', 'المسؤوليات', 'الواجبات', 'الاعمال', 'مهام الوظيفة', 'tasks', 'duties', 'responsibilit');
const HEAD_STOP = rx('موهلات', 'موهل', 'الخبر', 'المهارات', 'الشروط', 'الكفاءات', 'متطلبات', 'بيئه العمل', 'ظروف العمل', 'الصلاحيات', 'qualification', 'skills', 'requirement', 'experience');
const HEAD_SUM = /(?:الغرض من الوظيفه|الهدف العام|الهدف من الوظيفه|ملخص الوظيفه|نبذه عن الوظيفه|purpose|job summary)/;
const HEAD_TITLE = /^(?:المسمي الوظيفي|اسم الوظيفه|المسمي|job title|position title)\s*[:：-]?\s*(.*)$/;
const BULLET = /^\s*(?:[•●▪■◦○·*▫◆◇–—-]+|[\d٠-٩۰-۹]{1,3}\s*[.)\-–]|[(\[][\d٠-٩۰-۹]{1,3}[)\]]|[أ-ي]\s*[.)]\s)\s*/;

function splitTitle(text) {
  let t = clean(text); let detail = '';
  if (t.length > 160) { const cut = t.slice(0, 160); const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('، '), cut.lastIndexOf(' ')); const k = i > 60 ? i : 160; detail = t.slice(k).replace(/^[.،\s]+/, ''); t = t.slice(0, k).replace(/[.،\s]+$/, ''); }
  return { title: t, detail };
}
function dutyFrom(o, notes) {
  const { title, detail: d0 } = splitTitle(o.title);
  let detail = [o.detail, d0].filter(Boolean).join(' — ');
  let freq = o.freq || '';
  if (!freq && o.freqRaw) { if (OTHER_FREQ.test(norm(o.freqRaw))) { notes.other = (notes.other || 0) + 1; detail = [detail, `التكرار في الملف: ${o.freqRaw}`].filter(Boolean).join(' — '); } }
  return { title, detail: detail.slice(0, 800), freq, prio: o.prio || 1, est: o.est || null };
}

function fromTable(rows, strict, notes) {
  let h = -1, cols = {}; const first = rows.findIndex((r) => r.some(Boolean));
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const c = {}; rows[i].forEach((cell, j) => { const k = catOf(cell); if (k && !(k in c)) c[k] = j; });
    const uniq = Object.keys(c).length; if (uniq >= 2 || (!strict && uniq === 1 && c.title !== undefined && (rows[i].filter(Boolean).length >= 2 || i === first))) { h = i; cols = c; break; }
  }
  if (h < 0) {
    if (strict) return [];
    const w = rows[0]?.length || 0; if (w < 1) return [];
    return rows.filter((r) => (r[0] || '').length >= 4 && !(HEAD_DUTY.exec(norm(r[0]))?.index <= 3)).map((r) => dutyFrom({ title: r[0], detail: r.slice(1).filter(Boolean).join(' — ') }, notes));
  }
  if (cols.title === undefined) { if (cols.detail === undefined) return []; cols.title = cols.detail; delete cols.detail; }
  const hours = /ساع|hour/.test(norm(rows[h][cols.est] || ''));
  const out = []; let ctx = '';
  for (const r of rows.slice(h + 1)) {
    const t = r[cols.title] || ''; const others = r.filter(Boolean).length;
    if (!t) { if (others === 1) { const f = freqOf(r.find(Boolean)); if (f || HEAD_DUTY.test(norm(r.find(Boolean)))) ctx = f; } continue; }
    if (others === 1 && t.length <= 40 && HEAD_DUTY.test(norm(t))) { ctx = freqOf(t); continue; }
    const fr = cols.freq !== undefined ? r[cols.freq] || '' : '';
    out.push(dutyFrom({ title: t, detail: cols.detail !== undefined ? r[cols.detail] || '' : '', freq: freqOf(fr) || (fr ? '' : ctx) || freqOf(t), freqRaw: fr, prio: cols.prio !== undefined ? prioOf(r[cols.prio]) : 1, est: cols.est !== undefined ? estOf(r[cols.est], hours) : null }, notes));
  }
  return out;
}

function fromLines(lines, wrap, notes) {
  const items = lines.map((raw) => { const m = raw.match(BULLET); return { raw, bullet: !!m && raw.length > m[0].length, text: m ? raw.slice(m[0].length).trim() : raw }; });
  const lead = (re, n) => { const m = re.exec(n); return !!m && m.index <= 3; }; // العنوان يبدأ بالكلمة المفتاحية (لا جملة عادية تحويها)
  const kind = (it) => { const n = norm(it.raw); if (it.bullet || it.raw.length > 60) return ''; const w = n.split(' ').length, colon = /[:：]$/.test(it.raw);
    if (lead(HEAD_STOP, n) && (colon || w <= 4)) return 'stop';
    if (lead(HEAD_SUM, n) && (colon || w <= 5)) return 'sum';
    if (lead(HEAD_DUTY, n) && (colon || w <= 5)) return 'duty';
    return colon ? 'other' : ''; };
  const isHead = (it) => !!kind(it);
  const SKIP = rx('المسمي الوظيفي', 'اسم الوظيفه', 'الاداره', 'القسم', 'يتبع', 'الفرع', 'الاصدار', 'التاريخ', 'رمز الوظيفه', 'المستوي الوظيفي');
  const hasDutyHead = items.some((it) => kind(it) === 'duty');
  const useBullets = items.filter((it) => it.bullet).length >= 2;
  let inRegion = !hasDutyHead, ctx = '', sum = false; const out = []; let cur = null;
  const push = () => { if (cur) { out.push(dutyFrom({ title: cur.text, freq: cur.freq }, notes)); cur = null; } };
  for (const it of items) {
    if (isHead(it)) {
      push(); const k = kind(it); const n = norm(it.raw);
      if (k === 'stop') { inRegion = false; sum = false; }
      else if (k === 'sum') { inRegion = false; sum = true; }
      else if (k === 'duty') { inRegion = true; ctx = freqOf(n); sum = false; }
      else if (sum) { inRegion = !hasDutyHead; sum = false; }   // عنوان فرعي: يُهمل ويبقى القسم الحالي (تجميع الواجبات تحته)
      continue;
    }
    if (!inRegion) continue;
    if (/^[\d٠-٩]+$/.test(it.text) || it.text.length < 3 || (!it.bullet && /[:：]/.test(it.text.slice(0, 30)) && SKIP.test(norm(it.text.split(/[:：]/)[0])))) continue;
    if (useBullets && !it.bullet && cur && wrap !== false) { cur.text += ` ${it.text}`; continue; }
    push(); cur = { text: it.text, freq: ctx || freqOf(it.text) };
  }
  push(); return out;
}

function metaOf(lines) {
  let title = '', summary = '';
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);
    if (!title) { const m = n.match(HEAD_TITLE); if (m) { const raw = lines[i].replace(/^[^:：-]*[:：-]\s*/, '').trim(); title = (m[1] ? raw : lines[i + 1] || '').slice(0, 100); } }
    if (!summary && HEAD_SUM.test(n) && n.split(' ').length <= 8) { const same = lines[i].split(/[:：]/).slice(1).join(':').trim(); const got = []; if (same) got.push(same); for (let j = i + 1; j < Math.min(i + 4, lines.length) && !/[:：]$/.test(lines[j]) && !HEAD_DUTY.test(norm(lines[j])); j++) got.push(lines[j]); summary = got.join(' ').slice(0, 1000); }
  }
  return { title: clean(title), summary: clean(summary) };
}

/** من المصدر المقروء إلى { title, summary, duties[], notes[] }. */
export function extract(src) {
  const nt = {}; let duties = [];
  const order = [...(src.tables || [])].sort((a, b) => b.length - a.length);
  for (const t of order) { duties = fromTable(t, !!src.strict, nt); if (duties.length) break; }
  if (!duties.length) duties = fromLines(src.lines || [], src.wrap, nt);
  const seen = new Set(); duties = duties.filter((d) => { const k = norm(d.title); if (d.title.length < 3 || /^[\d\s.\-]+$/.test(d.title) || seen.has(k)) return false; seen.add(k); return true; });
  const notes = [];
  if (duties.length > MAX_DUTIES) { notes.push(`وُجد ${duties.length} بندًا، واستُورد أول ${MAX_DUTIES} (حدّ الوظيفة الواحدة). قسّم الباقي على وظيفة أخرى.`); duties = duties.slice(0, MAX_DUTIES); }
  if (nt.other) notes.push(`${nt.other} بند تكراره (ربع سنوي أو سنوي) غير مدعوم كواجب دوري؛ أُبقي في التفاصيل ولم يُجعل دوريًا.`);
  return { ...metaOf(src.lines || []), duties, notes };
}
