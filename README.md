# دفتر المهام

تطبيق ويب يعمل بلا إنترنت (PWA). الواجهة هنا، والبيانات في خزنة Supabase خاصة محمية بتسجيل الدخول؛ لا بيانات شخصية في هذا المستودع.

## البنية

| الملف | دوره |
|---|---|
| `src/notebook.html` | الدفتر نفسه، كما يعمل داخل Claude |
| `tools/build.py` | يبني `index.html` من الدفتر ويطبّق تعديلات التطبيق المستقل، ويتوقف إن لم يجد نصًّا يعدّله |
| `bridge.js` | يقدّم للدفتر واجهة Claude نفسها فوق Supabase: البيانات، والدخول، والتنزيل، والفهم الذكي، وتقويم Google |
| `sw.js` | يحفظ التطبيق على الجوال ليفتح بلا إنترنت |
| `supabase/schema.sql` | الجداول وقواعد الوصول |
| `supabase/functions/ai` | الفهم الذكي: يمرّر الطلب إلى Claude ومفتاح Anthropic في الخادم |
| `supabase/functions/gcal` | تقويم Google: ربط مباشر، ومفتاح التجديد في الخادم وحده |

بعد أي تعديل على `src/notebook.html` شغّل `python3 tools/build.py`، وارفع رقم `VERSION` في `sw.js`.

## العمل بلا إنترنت

- كل تعديل يُحفظ على الجوال ويُرسل عند عودة الاتصال.
- الفهم بلا إنترنت محلي.
- أحداث التقويم تأخذ رقمًا يولّده الجوال، فتنتظر في طابور وتُرسل لاحقًا دون تكرار.

## إعداد المرحلة 3 (مرة واحدة)

1. **الجدول:** شغّل قسم «المرحلة 3» من `supabase/schema.sql` في SQL Editor.
2. **الدالتان:** من Edge Functions أنشئ `ai` و`gcal` والصق محتوى ملف كل منهما. الدالة `gcal` تُنشر مع إيقاف **Verify JWT**، لأن عودة Google لا تحمل جلسة، والتحقق من الجلسة يجري داخل الدالة.
3. **Google Cloud:**
   - فعّل Google Calendar API في مشروع جديد.
   - شاشة الموافقة: External، والنطاق `calendar.events`.
   - انشرها **In production**. في وضع Testing ينتهي الربط كل 7 أيام.
   - أنشئ OAuth Client من نوع Web application، وعنوان الرجوع فيه:
     `https://djbbdajxilpxpgdhcwae.supabase.co/functions/v1/gcal/callback`
4. **الأسرار** في Edge Functions → Secrets، يلصقها صاحب الحساب بنفسه:
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `APP_URL` = `https://alabdmn3m.github.io/daftar/`
   - اختياريًا `AI_MODEL_QUICK` و`AI_MODEL_DEFAULT` لتغيير النموذج.
5. **الربط:** من الدفتر، قسم «بياناتك»، اضغط «اربط تقويم Google».

## نقل البيانات من دفتر Claude

1. من الدفتر القديم في «بياناتك»: «نسخة احتياطية».
2. من الدفتر الجديد: «استيراد نسخة».

أرقام أحداث التقويم تبقى صالحة لأنها في حساب Google نفسه.
