# اختبارات المتصفح (Playwright + axe)

بلا بناء: شغّل خادمًا ثابتًا من جذر المشروع ثم الاختبارات.

```bash
python3 -m http.server 8790            # في جذر المشروع
npm i playwright axe-core               # مرة واحدة (خارج المشروع أو محليًا)
BASE=http://localhost:8790 node tests/pyr.js        # هرم الأهداف، القيم، الخطوات المؤجلة، تفاصيل المهمة الهادئة
BASE=http://localhost:8790 node tests/pomo2.js      # بومودورو: جلسة ← استراحة ← جلسة (بساعة مزيفة)
BASE=http://localhost:8790 node tests/pyr_axe.js dark   # axe (WCAG AA) على الهرم والمهمة والتركيز؛ light أو dark
BASE=http://localhost:8790 node tests/micperf.js    # موضع زر الصوت وزمن فتح مهمة مع ٤٠٠ مهمة
```
متغيّر `CHROME=/path/to/chromium` اختياري. الاختبارات تعمل بوضع التخزين المحلي (بلا Firebase). مسار الصوت الكامل يحتاج Firebase وهميًا وخادم ذكاء وهميًا ولم يُحفظ هنا.

## قسم الفريق (`team.js`)
- `node tests/team.js` (يحتاج خادمًا على `localhost:8790` وaxe-core عبر `AXE=/path/axe.min.js`).
- يستبدل Firebase بنسخة وهمية في `tests/fakefb2/` فيها **مرآة JS لقواعد `firestore.rules`**: تكشف أي استعلام أو كتابة من التطبيق سترفضها القواعد.
- المرآة ليست القواعد نفسها: محاكي Firestore الرسمي لم يُشغَّل هنا (تنزيله محجوب في بيئة البناء). جرّب القواعد بعد نشرها من Firebase Console ← Firestore ← Rules ← Rules Playground، أو بحسابين حقيقيين.
- السيناريو: المسؤول يفعّل ويضيف مديرًا وموظفة ويوثّق التوصيف ← الموظفة ترفع تقريرها (ولا ترى القسم الشخصي) ← المدير يعلّق ويعيد للتعديل ← الموظفة تعدّل وترفع ← المسؤول يرى الجميع. مع axe في الثيمات الثلاثة.
