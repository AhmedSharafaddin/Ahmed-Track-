// يولّد itrack/my/index.html من index.html (واجهة مركز القيادة) بمسارات معدّلة وبمحوّل بيانات ITrack.
// شغّله بعد أي تعديل على index.html:  node itrack/tools/make-my.mjs
// الاختبار (tests/e2e.js) يتحقق أن الملف المولّد محدَّث.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function build() {
  let h = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const must = (a, b) => { if (!h.includes(a)) throw new Error('make-my: لم يُعثر على: ' + a); h = h.split(a).join(b); };
  must('<title>مركز القيادة</title>', '<title>مهامي — ITrack</title>');
  must('<meta name="apple-mobile-web-app-title" content="مركز القيادة" />', '<meta name="apple-mobile-web-app-title" content="ITrack" />');
  for (const d of ['icons/', 'fonts/', 'js/']) { h = h.split(`href="${d}`).join(`href="../../${d}`).split(`src="${d}`).join(`src="../../${d}`); }
  must('<span>مركز القيادة<small>إدارة المهام والأولويات</small></span>', '<span>مهامي<small>مساحتي الشخصية في ITrack</small></span>');
  must('href="styles.css"', 'href="../../styles.css"');
  must('href="manifest.webmanifest"', 'href="../manifest.webmanifest"');
  must('<script type="module" src="../../js/app.js"></script>', `<script type="module">
    // داخل ITrack: البيانات في خادم ITrack (وثائق خاصة بصاحبها)، والدخول بنفس جلسة ITrack.
    import { apiUrl } from '../config.js';
    import { session } from '../js/session.js';
    const org = () => { try { return JSON.parse(localStorage.getItem('it:org')); } catch (e) { return null; } };
    if (!org() || !session()) location.replace('../'); // الدخول واختيار الجهة من ITrack أولًا
    // الذكاء الاصطناعي (الصوت والمحضر) يُفعَّل تلقائيًا إن وفّره خادم الجهة
    const info = await fetch(apiUrl + '/api/health').then((r) => r.json()).catch(() => ({}));
    globalThis.CC_BACKEND = { api: apiUrl, ai: !!info.ai, org };
    await import('../../js/app.js');
  </script>`);
  must('<nav id="nav" class="nav"></nav>', '<a class="ni itrack-back" href="../" data-nosync><svg class="ic" aria-hidden="true"><use href="#d-people"/></svg><span>العمل: تقريري والفريق</span></a>\n      <nav id="nav" class="nav"></nav>');
  must('  </nav>\n\n  <button class="mic-fab"', '    <a href="../" class="itrack-back"><svg class="ic" aria-hidden="true"><use href="#d-people"/></svg><span>العمل</span></a>\n  </nav>\n\n  <button class="mic-fab"');
  return h;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { fs.writeFileSync(path.join(root, 'itrack/my/index.html'), build()); console.log('itrack/my/index.html'); }
