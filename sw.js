/* Obez Bilişim · Service Worker (yavaş internet için önbellek)
 * - Sayfa (HTML): önce ağ (3 sn zaman aşımı) → olmazsa önbellek. Güncellemeler hemen görünür.
 * - Aynı alan adındaki diğer dosyalar (intro/obez-intro.js, laptop.glb, favicon...): önbellekten anında gelir,
 *   arka planda güncellenir (stale-while-revalidate). Güncelleme yayınlarken index.html'deki ?v=2 numarasını artır.
 * - Üçüncü taraf (CDN) isteklerine dokunmaz; tarayıcı kendi önbelleğini kullanır.
 * Kaldırmak için: repodan sw.js'i sil (tarayıcılar sonraki ziyarette kendiliğinden temizler: aşağıdaki activate).
 */
const CACHE = 'obez-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function cacheable(res) { return res && res.ok && res.type === 'basic'; }

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    if (cacheable(res)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return fetch(req);            // önbellekte yoksa normal ağ isteği (zaman aşımı olmadan)
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((res) => { if (cacheable(res)) cache.put(req, res.clone()); return res; }).catch(() => null);
  if (hit) return hit;
  const res = await refresh;
  return res || fetch(req);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;
  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  e.respondWith(isPage ? networkFirst(req) : staleWhileRevalidate(req));
});
