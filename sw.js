/* Obez Bilişim · Service Worker (yavaş internet için önbellek)
 * - Sayfa (HTML): önce ağ (1,2 sn; gelmezse önbellek, ağ arkada önbelleği günceller) → olmazsa önbellek. Güncellemeler hemen görünür.
 * - Aynı alan adındaki diğer dosyalar (intro/obez-intro.js, laptop.glb, favicon...): önbellekten anında gelir,
 *   arka planda güncellenir (stale-while-revalidate). Güncelleme yayınlarken index.html'deki ?v=2 numarasını artır.
 * - Üçüncü taraf (CDN) isteklerine dokunmaz; tarayıcı kendi önbelleğini kullanır.
 * Kaldırmak için: repodan sw.js'i sil (tarayıcılar sonraki ziyarette kendiliğinden temizler: aşağıdaki activate).
 */
const CACHE = 'obez-v5';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function cacheable(res) { return res && res.ok && res.type === 'basic'; }

async function networkFirst(e) {
  const req = e.request, cache = await caches.open(CACHE), hit = await cache.match(req);
  // Ağ isteği her durumda sürer ve önbelleği günceller; önbellek varsa 1,2 sn içinde ağ gelmezse önbellek hemen gösterilir.
  const net = fetch(req).then((res) => { if (cacheable(res)) cache.put(req, res.clone()); return res; });
  e.waitUntil(net.catch(() => {}));
  if (!hit) return net;
  return Promise.race([net.catch(() => hit), new Promise((r) => setTimeout(() => r(hit), 1200))]);
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
  e.respondWith(isPage ? networkFirst(e) : staleWhileRevalidate(req));
});
