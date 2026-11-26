#!/usr/bin/env python3
"""يبني index.html للتطبيق المستقل من src/notebook.html (نسخة الدفتر في Claude).
كل تعديل خاص بالتطبيق المستقل مكتوب هنا، ويتوقف البناء إن لم يجد النص الذي يعدّله،
فلا يضيع تعديل بصمت حين يتغير الدفتر الأصلي."""
import pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / 'src' / 'notebook.html').read_text(encoding='utf-8')

WIDGET_FEED = r'''window.DaftarWidgetFeed=function(){
  if (!S.ready) return null;
  const t = today(), days = {};
  for (let i = 0; i < 7; i++) {
    const k = addDays(t, i), list = [];
    for (const it of S.items.values()) {
      if (it.type === 'meeting' || it.type === 'vacation' || it.status === 'done') continue;
      const rep = repF(it) && repAnchor(it) && k > repAnchor(it) && occIn(it, k, k).length;
      const hit = (it.days || []).includes(k) || it.due === k || it.remindDate === k || (isWaiting(it) && it.followUp === k) || rep;
      if (!hit) continue;
      let tm = null, kind = 'task';
      if (it.remindTime && (it.remindDate === k || (rep && !it.due))) { tm = it.remindTime; kind = 'rem'; }
      else if (it.due === k && it.dueTime) { tm = it.dueTime; kind = 'due'; }
      if (tm && tzOf(it) !== DEV_TZ) { const r = toTz(k, tm, tzOf(it), DEV_TZ); if (r[0] === k) tm = r[1]; }
      list.push({ t: it.title, e: ENT[it.entity] ? it.entity : 'personal', k: kind, tm });
    }
    if (list.length) days[k] = list.sort((a, b) => (a.tm || '99') < (b.tm || '99') ? -1 : 1);
  }
  return { v: 1, days };
};'''

# تاريخ آخر تحديث يُكتب عند البناء (بتوقيت الرياض) مع رقم الإصدار، بدل تاريخ الدفتر القديم الثابت
import datetime, re
_now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=3)))
_MON = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر']
_h = _now.hour % 12 or 12
_ver = re.search(r"daftar-(v\d+)", (ROOT / 'sw.js').read_text(encoding='utf-8')).group(1)
STAMP = f"{_now.day} {_MON[_now.month-1]} {_now.year}، {_h}:{_now.minute:02d} {'ص' if _now.hour < 12 else 'م'} · الإصدار {_ver}"

PATCHES = [
  ("15 نوفمبر، 3:35 م</p>", STAMP + "</p>"),
  # بلا إنترنت: الفهم المحلي فورًا بدل انتظار خطأ الشبكة
  ("if(!S.sample){S.pending=localParse(text)",
   "if(!S.sample||navigator.onLine===false){S.pending=localParse(text)"),
  # رسائل الأخطاء بلغة التطبيق المستقل
  ("  return c==='not_granted'?",
   "  if(c==='offline')return 'لا يوجد إنترنت الآن. رتّبها بدون انتظار أو أعد المحاولة لاحقًا.';\n"
   "  if(c==='not_configured')return 'الفهم الذكي لم يُجهَّز في الخادم بعد. رتّبها بدون انتظار.';\n"
   "  return c==='not_granted'?"),
  ("'أضف موصل Google Calendar من إعدادات Claude ثم الموصلات.'",
   "'اربط تقويم Google من قسم «بياناتك» أسفل الصفحة.'"),
  ("'أعد ربط Google Calendar من إعدادات Claude ثم الموصلات.'",
   "'أعد ربط تقويم Google من قسم «بياناتك» أسفل الصفحة.'"),
  ("'التجهيز بـClaude غير متاح في هذا العرض.'", "'التجهيز يحتاج الإنترنت.'"),
  # شاشة الدخول تتولى الدخول، فلا رسالة عن Claude خلفها
  ("note('سجّل الدخول إلى Claude ليُحفظ دفترك في حسابك.')", "0"),
  # زر ربط التقويم في «بياناتك»
  ("<p style=\"margin:10px 0 0;font-size:12px;color:var(--faint)\">تحديث الصفحة:",
   "${window.DaftarCalHTML?window.DaftarCalHTML():''}${window.DaftarWidgetHTML?window.DaftarWidgetHTML():''}<p style=\"margin:10px 0 0;font-size:12px;color:var(--faint)\">تحديث الصفحة:"),
  # ودجت الآيفون: تُحدَّث قائمة مهامه بعد كل رسم
  ("watchRun()}", "watchRun();window.DaftarWidgetSync&&window.DaftarWidgetSync()}"),
  # يعيد الجسر رسم الدفتر حين تتغير حالة الربط
  ("\nboot();\n", "\nwindow.addEventListener('daftar-rerender',()=>{try{render()}catch(_){}});\nboot();\n"),
  # ودجت الآيفون: مهام الأيام السبعة القادمة بوقتها (التذكير أو التسليم)
  ("\nboot();\n", "\n"+WIDGET_FEED+"\nboot();\n"),
  ("const n=OB.map.size,off=S.net==='off'||navigator.onLine===false;let t='',k='';",
   "const n=OB.map.size,off=S.net==='off'||navigator.onLine===false;let t='',k='';if(!off)S.offShown=0;"),
  ("""  if(off&&n)t=`غير متصل · ${n===1?'تعديل واحد محفوظ':n===2?'تعديلان محفوظان':n+' تعديلات محفوظة'} على جوالك ويُرسل تلقائيًا`,k='off';
  else if(off&&S.fromCache)t=`غير متصل · تعرض آخر نسخة (${agoT})`,k='off';
  else if(off)t='غير متصل · أي تعديل يُحفظ على جوالك ويُرسل لاحقًا',k='off';""",
   """  if(off&&n)t=`بلا إنترنت · ${n===1?'تعديل واحد محفوظ':n===2?'تعديلان محفوظان':n+' تعديلات محفوظة'} على جوالك ويُرسل تلقائيًا`,k='calm';
  else if(off){if(!S.offShown){S.offShown=1;t='بلا إنترنت · الدفتر يعمل وتعديلاتك تُحفظ على جوالك',k='calm brief'}}"""),
  # الفهم الذكي غير مجهّز أو بلا إنترنت: يرتّب محليًا مباشرة بدل رسالة خطأ
  ("    S.phase='error';S.parseErr=sampleErr(e);",
   "    if(e&&(e.code==='not_configured'||e.code==='offline')){S.ctl=null;clearTimeout(S.slowT);fallbackNow();return}\n    S.phase='error';S.parseErr=sampleErr(e);"),
  ("if(k==='ok')netUI.h=setTimeout(", "if(k==='ok'||k==='calm brief')netUI.h=setTimeout("),
  ("},2600)}", "},k==='ok'?2600:3000)}"),
]
for old, new in PATCHES:
    n = src.count(old)
    if n != 1:
        sys.exit(f'البناء توقف: النص المطلوب تعديله ظهر {n} مرة:\n{old[:90]}')
    src = src.replace(old, new)

lines = src.split('\n')
assert lines[0].startswith('<title>') and 'fonts.googleapis' in lines[3], 'بداية الدفتر تغيّرت'
end_style = lines.index('</style>', 4)
head_css, body = lines[4:end_style + 1], lines[end_style + 1:]

LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
faces = [f"@font-face{{font-family:'IBM Plex Sans Arabic';font-style:normal;font-weight:{w};font-display:swap"
         + (f";unicode-range:{LATIN}" if s == 'latin' else '')
         + f";src:url(fonts/ibm-plex-sans-arabic-{s}-{w}-normal.woff2) format('woff2')}}"
         for s in ('arabic', 'latin') for w in (400, 500, 600, 700)]
top = '''<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>دفتر المهام</title>
<meta name="theme-color" content="#F5F4F8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121017" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="الدفتر">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>
''' + '\n'.join(faces) + '''
</style>
<script src="config.js"></script>
<script src="supabase.js"></script>
<script src="bridge.js"></script>'''
tail = '''<style>
/* التطبيق المستقل: لا يوجد رأس Claude يزيح الصفحة، فيستقر الشريط فوق حافة الشاشة مباشرة */
:root{--navgap:calc(env(safe-area-inset-bottom,0px) + 10px)!important}
#netbar.calm{color:var(--muted)}
</style>
</body>
</html>
'''
out = top + '\n' + '\n'.join(head_css) + '\n</head>\n<body>\n' + '\n'.join(body) + '\n' + tail
(ROOT / 'index.html').write_text(out, encoding='utf-8')
print('index.html', len(out))
