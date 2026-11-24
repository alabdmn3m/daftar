/* دفتر المهام — عامل الخدمة: يحفظ ملفات التطبيق على الجوال ليفتح بلا إنترنت.
   ملفات التطبيق: من الحفظ أولًا ثم تُحدَّث في الخلفية. طلبات البيانات (Supabase): تمر للشبكة دائمًا. */
const VERSION = 'daftar-v3';
const SHELL = ['./', 'index.html', 'bridge.js', 'config.js', 'supabase.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  ...['arabic', 'latin'].flatMap(s => [400, 500, 600, 700].map(w => `fonts/ibm-plex-sans-arabic-${s}-${w}-normal.woff2`))];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(req).then(res => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('غير متصل', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
