# يملأ النموذج الرسمي (templates/jd-template.xlsx) بنص تجريبي عام ليختبر الاستيراد نموذجَ الإنتاج نفسه: python3 make-template-filled.py
import os
from openpyxl import load_workbook
here = os.path.dirname(os.path.abspath(__file__))
wb = load_workbook(os.path.join(here, '..', '..', 'templates', 'jd-template.xlsx')); ws = wb['التوصيف']
ws['C1'] = 'أمين مستودع'; ws['C2'] = 'المخازن'; ws['C3'] = 'ضمان دقة المخزون وسلامة حركة البضائع.'
rows = [('استلام الشحنات ومطابقتها مع أوامر الشراء','يومي','حرجة',30,'مطابقة الكميات والأصناف'),('تسجيل حركة الصرف والإدخال في النظام','يومي','مهمة',45,'كل حركة اليوم مسجّلة'),
  ('جرد عينة من الأصناف','أسبوعي','مهمة',60,'عينة ١٠ أصناف'),('إعداد تقرير الأصناف الراكدة','أسبوعي','عادية',90,'مرفوع قبل اجتماع الأحد'),('إغلاق الجرد الشهري ورفعه للإدارة','شهري','حرجة',120,'معتمد قبل اليوم الخامس')]
for i, r in enumerate(rows):
    for c, v in enumerate(r, 2): ws.cell(6 + i, c, v)
wb.save(os.path.join(here, 'jd-template-filled.xlsx'))
