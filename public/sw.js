// Service Worker — Mode hors-ligne (Section 7)
// Stratégies :
//   - Fichiers statiques (même origine + unpkg) : cache-first
//   - Tuiles OpenStreetMap : cache-first (fallback tuile grise)
//   - API Open Food Facts : network-first (fallback cache, puis JSON "hors-ligne")
// ⬇ Version incrémentée pour forcer la mise à jour des clients
const CACHE_NAME = 'monapp-v16';
const TILES_CACHE_NAME = 'monapp-tiles-v8';
const API_CACHE_NAME = 'monapp-api-v8';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/src/style.css',
  '/src/main.js',
  '/src/db.js',
  '/favicon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
];

// ---------- INSTALL ----------
self.addEventListener('install', (event) => {
  // Mise en cache individuelle et tolérante : en production, les sources
  // (/src/main.js, /src/db.js, /src/style.css) sont bundlées et n'existent
  // plus à ces URLs. Un cache.addAll() global ferait échouer l'installation.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        STATIC_ASSETS.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((response) => (response && response.ok ? cache.put(url, response) : null))
            .catch(() => null)
        )
      ))
      .then(() => self.skipWaiting())
  );
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', (event) => {
  const keep = [CACHE_NAME, TILES_CACHE_NAME, API_CACHE_NAME];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (keep.includes(k) ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

// ---------- Helpers ----------
const isOsmTile = (url) =>
  /^[abc]\.tile\.openstreetmap\.org$/.test(url.hostname) && url.pathname.endsWith('.png');

const isOpenFoodFacts = (url) => url.hostname === 'world.openfoodfacts.org';

// ---------- FETCH ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) Tuiles OSM : cache-first, fallback tuile grise hors-ligne
  if (isOsmTile(url)) {
    event.respondWith(
      caches.open(TILES_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req, { mode: 'no-cors' });
          if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
          return resp;
        } catch (e) {
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dddddd"/></svg>',
            { headers: { 'Content-Type': 'image/svg+xml' } }
          );
        }
      })
    );
    return;
  }

  // 2) Open Food Facts : network-first, fallback cache puis JSON "hors-ligne"
  if (isOpenFoodFacts(url)) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(API_CACHE_NAME).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() =>
          caches.match(req).then((cached) =>
            cached ||
            new Response(JSON.stringify({ status: 0, status_text: 'hors-ligne', product: null }), {
              headers: { 'Content-Type': 'application/json' }
            })
          )
        )
    );
    return;
  }

  // 3) Navigation (pages) : network-first, fallback sur /index.html en cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches
          .match('/index.html')
          .then((cached) => cached || new Response('Hors ligne', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
      )
    );
    return;
  }

  // 4) Statiques (même origine + unpkg) : cache-first, mise en cache au premier passage
  if (url.origin === self.location.origin || url.hostname === 'unpkg.com') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req);
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        } catch (e) {
          return Response.error();
        }
      })
    );
  }
});

// ---------- CACHE_ZONE / refresh-tiles ----------
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'CACHE_ZONE' || data.type === 'refresh-tiles') {
    const lat = data.lat;
    const lng = data.lng !== undefined ? data.lng : data.lon;
    const radius = data.radius || 5;

    const respond = (payload) => {
      if (event.ports && event.ports[0]) {
        try { event.ports[0].postMessage(payload); } catch (e) { /* ignore */ }
      }
      // Diffuse aussi à tous les clients (pour le bandeau / toast)
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => client.postMessage(payload));
      });
    };

    event.waitUntil(
      cacheZoneTiles(lat, lng, radius)
        .then((count) => respond({ type: 'tiles-cached', count }))
        .catch((err) => respond({ type: 'tiles-cached', count: 0, error: String(err) }))
    );
  }
});

// Télécharge les tuiles d'une zone de radiusKm autour de (lat, lng) pour les zooms 13→15
async function cacheZoneTiles(lat, lng, radiusKm = 5) {
  const cache = await caches.open(TILES_CACHE_NAME);
  let count = 0;
  const degLat = radiusKm / 111.32;
  const degLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));

  for (const zoom of [13, 14, 15]) {
    const n = Math.pow(2, zoom);
    const lonToTile = (lon) => Math.floor(((lon + 180) / 360) * n);
    const latToTile = (l) => {
      const rad = (l * Math.PI) / 180;
      return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
    };

    const x0 = Math.max(0, lonToTile(lng - degLng));
    const x1 = Math.min(n - 1, lonToTile(lng + degLng));
    const y0 = Math.max(0, latToTile(lat + degLat));
    const y1 = Math.min(n - 1, latToTile(lat - degLat));

    const jobs = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const tileUrl = `https://a.tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
        jobs.push(
          cache.match(tileUrl).then((hit) => {
            if (hit) { count++; return; }
            return fetch(tileUrl)
              .then((resp) => {
                if (resp.ok) return cache.put(tileUrl, resp.clone()).then(() => { count++; });
              })
              .catch(() => { /* tuile ignorée */ });
          })
        );
      }
    }
    await Promise.all(jobs);
  }
  return count;
}
