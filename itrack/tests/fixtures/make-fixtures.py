# يولّد ملفات الاختبار (نص تجريبي عام، ليس بيانات الجهة): python3 make-fixtures.py ثم node make-pdf.js
import openpyxl, docx
from openpyxl.styles import Font
D = [('استلام الشحنات ومطابقتها مع أوامر الشراء', 'يومي', 'حرجة', 30, 'مطابقة الكميات والأصناف'),
     ('تسجيل حركة الصرف والإدخال في النظام', 'يومي', 'مهمة', 45, ''),
     ('جرد عينة من الأصناف', 'أسبوعي', 'مهمة', 60, ''),
     ('إعداد تقرير الأصناف الراكدة', 'أسبوعي', 'عادية', 90, ''),
     ('إغلاق الجرد الشهري ورفعه للإدارة', 'شهري', 'حرجة', 120, 'قبل اليوم الخامس من الشهر')]
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'التوصيف'; ws.sheet_view.rightToLeft = True
ws.append(['المسمى الوظيفي', 'أمين مستودع (نموذج اختبار)']); ws.append([])
ws.append(['المهمة', 'التكرار', 'الأولوية', 'المدة (دقيقة)', 'التفاصيل'])
for c in ws[3]: c.font = Font(bold=True)
for r in D: ws.append(list(r))
wb.create_sheet('ملاحظات').append(['ورقة ثانية لا علاقة لها'])
wb.save('jd.xlsx')
d = docx.Document()
d.add_paragraph('المسمى الوظيفي: أمين مستودع (نموذج اختبار)')
d.add_paragraph('الغرض من الوظيفة:'); d.add_paragraph('ضمان دقة المخزون وسلامة حركة البضائع.')
d.add_paragraph('المهام والمسؤوليات:')
d.add_paragraph('المهام اليومية:')
for t in (D[0][0], D[1][0]): d.add_paragraph(t, style='List Bullet')
d.add_paragraph('المهام الأسبوعية:')
for t in (D[2][0], D[3][0]): d.add_paragraph(t, style='List Bullet')
d.add_paragraph('المهام الشهرية:'); d.add_paragraph(D[4][0], style='List Bullet')
d.add_paragraph('المؤهلات والخبرات:'); d.add_paragraph('بكالوريوس في المحاسبة', style='List Bullet'); d.add_paragraph('خبرة سنتين', style='List Bullet')
d.save('jd.docx')
d2 = docx.Document(); t = d2.add_table(rows=1, cols=4); t.style = 'Table Grid'
for i, h in enumerate(['المهمة', 'التكرار', 'الأولوية', 'المدة']): t.rows[0].cells[i].text = h
for r in D:
    row = t.add_row().cells
    for i, v in enumerate([r[0], r[1], r[2], f'{r[3]} دقيقة']): row[i].text = v
d2.save('jd-table.docx')
open('jd.csv', 'w', encoding='utf-8-sig').write('المهمة;التكرار;الأولوية;المدة;التفاصيل\n' + '\n'.join(';'.join(map(str, r)) for r in D) + '\n')
open('jd-1256.csv', 'wb').write(('المهمة,التكرار\n' + '\n'.join(f'{r[0]},{r[1]}' for r in D) + '\n').encode('cp1256'))
print('ok')
