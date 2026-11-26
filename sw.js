/* دفتر المهام — عامل الخدمة: يحفظ ملفات التطبيق على الجوال ليفتح بلا إنترنت.
   ملفات التطبيق: من الحفظ أولًا ثم تُحدَّث في الخلفية. طلبات البيانات (Supabase): تمر للشبكة دائمًا.
   الأساسية تُحفظ كلها أو لا شيء؛ الخطوط والأيقونات كلٌّ على حدة، فلا يُفشل ملفٌّ واحد الحفظ كله. */
const VERSION = 'daftar-v17';
const CORE = ['./', 'index.html', 'bridge.js', 'config.js', 'supabase.js'];
const EXTRA = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  ...['arabic', 'latin'].flatMap(s => [400, 500, 600, 700].map(w => `fonts/ibm-plex-sans-arabic-${s}-${w}-normal.woff2`))];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    /* من الخادم مباشرة لا من ذاكرة المتصفح المؤقتة، حتى لا يُحفظ إصدار قديم باسم الجديد */
    const fresh = u => new Request(u, { cache: 'reload' });
    await c.addAll(CORE.map(fresh));
    await Promise.all(EXTRA.map(u => c.add(fresh(u)).catch(() => {})));
    await self.skipWaiting();
  })());
});

/* صفحة مفتوحة من إصدار قديم جدًا (لا تعرف كيف تُحدّث نفسها) تُعاد هنا فورًا،
   فلا يرى المستخدم صفحة قديمة ولا يحتاج فتحة ثانية. الصفحات الحديثة ترد على السؤال
   وتعيد تحميل نفسها في وقت مناسب (لا أثناء الكتابة)، فلا تُمسّ. */
async function reviveOldPages() {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const modern = new Set();
  const onMsg = ev => { if (ev.data === 'daftar-modern' && ev.source) modern.add(ev.source.id); };
  self.addEventListener('message', onMsg);
  wins.forEach(c => c.postMessage('daftar-ping'));
  await new Promise(r => setTimeout(r, 1500));
  self.removeEventListener('message', onMsg);
  await Promise.all(wins.filter(c => !modern.has(c.id)).map(c => c.navigate(c.url).catch(() => {})));
}

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    /* لا يُنتظر داخل التفعيل: إعادة فتح الصفحة تمر بعامل الخدمة نفسه، فانتظارها هنا يعلّقها */
    .then(() => { reviveOldPages().catch(() => {}); }));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // البيانات تذهب للشبكة مباشرة
  const nav = req.mode === 'navigate';
  const net = fetch(nav ? req.url : req, { cache: 'no-cache' }).then(async res => {
    if (res && res.ok) { const c = await caches.open(VERSION); await c.put(nav ? 'index.html' : req, res.clone()); }
    return res;
  }).catch(() => null);
  e.waitUntil(net.then(() => {}));
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = nav ? (await c.match('index.html')) || (await c.match('./'))
                    : await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return (await net) || new Response('غير متصل', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
