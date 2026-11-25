/* دفتر المهام — عامل الخدمة: يحفظ ملفات التطبيق على الجوال ليفتح بلا إنترنت.
   ملفات التطبيق: من الحفظ أولًا ثم تُحدَّث في الخلفية. طلبات البيانات (Supabase): تمر للشبكة دائمًا.
   الأساسية تُحفظ كلها أو لا شيء؛ الخطوط والأيقونات كلٌّ على حدة، فلا يُفشل ملفٌّ واحد الحفظ كله. */
const VERSION = 'daftar-v5';
const CORE = ['./', 'index.html', 'bridge.js', 'config.js', 'supabase.js'];
const EXTRA = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  ...['arabic', 'latin'].flatMap(s => [400, 500, 600, 700].map(w => `fonts/ibm-plex-sans-arabic-${s}-${w}-normal.woff2`))];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE);
    await Promise.all(EXTRA.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // البيانات تذهب للشبكة مباشرة
  const nav = req.mode === 'navigate';
  const net = fetch(req).then(async res => {
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
