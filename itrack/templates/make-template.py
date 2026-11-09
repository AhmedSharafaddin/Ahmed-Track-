# يولّد نموذج التوصيف الوظيفي (jd-template.xlsx) الذي يقرؤه استيراد ITrack: python3 make-template.py
# الأوراق: «التوصيف» (تُعبَّأ وتُستورد) · «مثال» · «تعليمات». أوراق «مثال» و«تعليمات» لا تُستورد أبدًا (انظر SKIP_SHEET في js/import.js).
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.properties import PageSetupProperties

F = 'Tahoma'
HEAD = PatternFill('solid', fgColor='1F4E5F'); KEY = PatternFill('solid', fgColor='E6EEF1'); IN = PatternFill('solid', fgColor='FFFFFF'); NOTE = PatternFill('solid', fgColor='FFF4D6')
thin = Side(style='thin', color='B8C4CA'); BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
WRAP = Alignment(wrap_text=True, vertical='center', horizontal='right'); CENTER = Alignment(wrap_text=True, vertical='center', horizontal='center')
COLS = ['م', 'المهمة / المسؤولية', 'التكرار', 'الأولوية', 'المدة (دقيقة)', 'معيار الإنجاز (كيف نعرف أنها تمّت؟)']
WIDTH = [5, 46, 14, 12, 14, 52]
ROWS = 40  # حدّ الوظيفة الواحدة في النظام

def sheet_base(ws):
    ws.sheet_view.rightToLeft = True; ws.sheet_view.showGridLines = False
    ws.page_setup.orientation = 'landscape'; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    for i, w in enumerate(WIDTH): ws.column_dimensions[chr(65 + i)].width = w

def build(ws, meta, rows, example=False):
    sheet_base(ws)
    for r, (k, v) in enumerate(meta, 1):
        a = ws.cell(r, 1, k); ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
        a.font = Font(name=F, bold=True); a.fill = KEY; a.alignment = WRAP; a.border = BOX; ws.cell(r, 2).border = BOX
        b = ws.cell(r, 3, v); ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=6)
        b.font = Font(name=F); b.alignment = WRAP; b.fill = NOTE if example else IN
        for c in range(3, 7): ws.cell(r, c).border = BOX
        ws.row_dimensions[r].height = 22 if r < len(meta) else 44
    h = len(meta) + 2
    for c, t in enumerate(COLS, 1):
        x = ws.cell(h, c, t); x.font = Font(name=F, bold=True, color='FFFFFF'); x.fill = HEAD; x.alignment = CENTER; x.border = BOX
    ws.row_dimensions[h].height = 34
    for i in range(ROWS):
        r = h + 1 + i; d = rows[i] if i < len(rows) else None
        ws.cell(r, 1, i + 1).alignment = CENTER
        for c in range(1, 7):
            x = ws.cell(r, c); x.border = BOX; x.font = Font(name=F, color='6B7780' if c == 1 else '000000')
            if c > 1: x.alignment = WRAP if c in (2, 6) else CENTER
            if example and d is None: x.fill = PatternFill('solid', fgColor='F7F7F7')
        if d:
            for c, v in enumerate(d, 2): ws.cell(r, c, v)
        ws.row_dimensions[r].height = 30
    first, last = h + 1, h + ROWS
    dv1 = DataValidation(type='list', formula1='"يومي,أسبوعي,شهري,بلا تكرار"', allow_blank=True, showErrorMessage=True, errorTitle='التكرار', error='اختر: يومي أو أسبوعي أو شهري أو بلا تكرار.')
    dv2 = DataValidation(type='list', formula1='"عادية,مهمة,حرجة"', allow_blank=True, showErrorMessage=True, errorTitle='الأولوية', error='اختر: عادية أو مهمة أو حرجة.')
    dv3 = DataValidation(type='whole', operator='between', formula1='5', formula2='960', allow_blank=True, showErrorMessage=True, errorTitle='المدة', error='أدخل عددًا صحيحًا بالدقائق بين ٥ و٩٦٠ (أو اتركه فارغًا).')
    for dv, col in ((dv1, 'C'), (dv2, 'D'), (dv3, 'E')):
        ws.add_data_validation(dv); dv.add(f'{col}{first}:{col}{last}')
    ws.freeze_panes = ws.cell(h + 1, 3)
    return h

wb = Workbook()
ws = wb.active; ws.title = 'التوصيف'
build(ws, [('المسمى الوظيفي', None), ('الإدارة', None), ('الغرض من الوظيفة (جملة واحدة)', None)], [])

ex = wb.create_sheet('مثال')
build(ex, [('المسمى الوظيفي', 'أمين مستودع  [مثال للتوضيح فقط، لا يُستورد]'), ('الإدارة', 'المخازن'), ('الغرض من الوظيفة (جملة واحدة)', 'ضمان دقة المخزون وسلامة حركة البضائع.')], [
    ('استلام الشحنات ومطابقتها مع أوامر الشراء', 'يومي', 'حرجة', 30, 'لا شحنة تُدخل قبل مطابقة الكميات والأصناف؛ الفروقات تُسجَّل في اليوم نفسه'),
    ('تسجيل حركة الصرف والإدخال في النظام', 'يومي', 'مهمة', 45, 'كل حركة اليوم مسجّلة قبل نهاية الدوام، وبلا حركة معلّقة'),
    ('جرد عينة من الأصناف', 'أسبوعي', 'مهمة', 60, 'عينة من ١٠ أصناف على الأقل، ونسبة الفرق أقل من ٢٪'),
    ('إعداد تقرير الأصناف الراكدة', 'أسبوعي', 'عادية', 90, 'ملف التقرير مرفوع للمدير قبل اجتماع الأحد'),
    ('إغلاق الجرد الشهري ورفعه للإدارة', 'شهري', 'حرجة', 120, 'الجرد مغلق ومعتمد قبل اليوم الخامس من الشهر'),
    ('تجهيز طلبات الصرف الطارئة', 'بلا تكرار', 'مهمة', 20, 'تُجهَّز خلال ساعة من وصول الطلب')], example=True)

g = wb.create_sheet('تعليمات'); g.sheet_view.rightToLeft = True; g.sheet_view.showGridLines = False
g.column_dimensions['A'].width = 28; g.column_dimensions['B'].width = 95
def put(r, a, b='', bold=False, fill=None):
    x = g.cell(r, 1, a); y = g.cell(r, 2, b)
    for c in (x, y): c.alignment = Alignment(wrap_text=True, vertical='top', horizontal='right'); c.font = Font(name=F, bold=bold or c is x and bool(b)); c.border = BOX if b else Border()
    if fill: x.fill = fill; y.fill = fill
    g.row_dimensions[r].height = max(22, 18 * (1 + len(b) // 95))
put(1, 'كيف تعبّئ النموذج', '', True)
g.cell(1, 1).font = Font(name=F, bold=True, size=14)
rows = [
    ('١. الخطوات', 'عبّئ ورقة «التوصيف» فقط (أوراق «مثال» و«تعليمات» لا تُستورد). ثم في ITrack: الهيكل ← الوظائف والتوصيف ← وظيفة جديدة ← «استيراد من ملف». سيعبّئ النظام الخانات لتراجعها ثم تحفظ.'),
    ('المسمى والإدارة والغرض', 'المسمى يُنقل تلقائيًا. الإدارة تُختار تلقائيًا إن طابق اسمها إدارة موجودة في النظام، وإلا اخترها يدويًا. الغرض جملة واحدة تقول لماذا توجد هذه الوظيفة.'),
    ('المهمة / المسؤولية', 'ابدأ بفعل وحدّد الناتج: «أعدّ تقرير الأصناف الراكدة» لا «متابعة المخزون». حتى ١٦٠ حرفًا. ما زاد ينتقل لمعيار الإنجاز.'),
    ('التكرار', 'يومي أو أسبوعي أو شهري: تظهر المهمة تلقائيًا في مهام كل من يشغل الوظيفة ويُحاسَب عليها. «بلا تكرار» لما يُطلب عند الحاجة (يُسند يدويًا). التكرار الربع سنوي والسنوي غير مدعوم كواجب دوري؛ اكتبه في معيار الإنجاز.'),
    ('الأولوية', 'حرجة = مهمة وعاجلة وضررها كبير إن تأخرت · مهمة = مهمة غير عاجلة · عادية = ما سواهما. الأولوية تحدد وزن المهمة في نسبة الإنجاز (حرجة ٣، مهمة ٢، عادية ١) ومكانها في مصفوفة الموظف.'),
    ('المدة (دقيقة)', 'تقدير واقعي لمرة واحدة. يُحسب منه حمل الأسبوع على الموظف (هل هو فوق طاقته؟) ويُقارَن لاحقًا بالزمن الفعلي. اتركه فارغًا إن لم تعرفه؛ لا تخمّن.'),
    ('معيار الإنجاز', 'أهم عمود للتتبع. اكتب كيف يعرف الموظف والمدير أن المهمة تمّت: رقم، أو ملف، أو موعد، أو اعتماد. «تمّت المراجعة» لا تكفي؛ «تمّت المطابقة وسُجّلت الفروقات في اليوم نفسه» تكفي.'),
    ('الحدود', 'حتى ٤٠ مسؤولية للوظيفة الواحدة. ننصح بأن تبقى الواجبات الدورية أقل من ١٥ لتبقى قابلة للمتابعة اليومية؛ وزّع ما زاد على أسبوعي وشهري.'),
    ('ما لا يُكتب هنا', 'لا تكتب «أي مهام أخرى يكلّف بها المدير»: لا تُقاس ولا تُتتبَّع. المهام الطارئة يُسندها المدير من التطبيق وقت حدوثها.'),
    ('الملفات المدعومة', 'يقرأ النظام أيضًا Word وPDF وCSV ونصًا ملصوقًا، لكن هذا النموذج أدقها لأن أعمدته مسمّاة وقوائمه محدّدة.'),
]
for i, (a, b) in enumerate(rows, 3): put(i, a, b)
wb.save('jd-template.xlsx'); print('ok')
