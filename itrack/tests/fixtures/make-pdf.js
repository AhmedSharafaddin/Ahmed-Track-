// يولّد PDF عربيًا حقيقيًا (خط مدمج وتشكيل) بمتصفح Chromium: node make-pdf.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
const D = ['استلام الشحنات ومطابقتها مع أوامر الشراء', 'تسجيل حركة الصرف والإدخال في النظام', 'جرد عينة من الأصناف', 'إعداد تقرير الأصناف الراكدة', 'إغلاق الجرد الشهري ورفعه للإدارة'];
const list = `<div dir="rtl" style="font:16px 'DejaVu Sans',Arial;padding:30px;line-height:1.9">
<h2>المسمى الوظيفي: أمين مستودع (نموذج اختبار)</h2><p><b>الغرض من الوظيفة:</b></p><p>ضمان دقة المخزون وسلامة حركة البضائع.</p>
<p><b>المهام والمسؤوليات:</b></p><p><b>المهام اليومية:</b></p><ul><li>${D[0]}</li><li>${D[1]}</li></ul>
<p><b>المهام الأسبوعية:</b></p><ul><li>${D[2]}</li><li>${D[3]}</li></ul><p><b>المهام الشهرية:</b></p><ul><li>${D[4]}</li></ul>
<p><b>المؤهلات والخبرات:</b></p><ul><li>بكالوريوس في المحاسبة</li><li>خبرة سنتين</li></ul></div>`;
const rows = [['المهمة', 'التكرار', 'الأولوية', 'المدة'], [D[0], 'يومي', 'حرجة', '30 دقيقة'], [D[1], 'يومي', 'مهمة', '45 دقيقة'], [D[2], 'أسبوعي', 'مهمة', '60 دقيقة'], [D[3], 'أسبوعي', 'عادية', '90 دقيقة'], [D[4], 'شهري', 'حرجة', '120 دقيقة']];
const table = `<div dir="rtl" style="font:15px 'DejaVu Sans',Arial;padding:30px"><h3>التوصيف (نموذج اختبار)</h3><table style="border-collapse:collapse;width:100%">${rows.map((r, i) => `<tr>${r.map((c) => `<${i ? 'td' : 'th'} style="border:1px solid #444;padding:8px">${c}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></div>`;
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined }); const p = await b.newPage();
  for (const [f, h] of [['jd.pdf', list], ['jd-table.pdf', table]]) { await p.setContent(`<html lang="ar"><body>${h}</body></html>`); await p.pdf({ path: f, format: 'A4' }); }
  await b.close(); console.log('pdf ok');
})();
