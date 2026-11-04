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
