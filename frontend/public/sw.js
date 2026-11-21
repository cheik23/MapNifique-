const CACHE_NAME = 'mapnifique-shell-v1'

const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/mapnifique-180.png',
  '/icons/mapnifique-192.png',
  '/icons/mapnifique-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('mapnifique-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // Navigation : toujours privilégier la version réseau.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE_NAME).then((cache) => cache.put('/', copy))
          }
          return response
        })
        .catch(async () => {
          return (await caches.match('/')) || Response.error()
        })
    )
    return
  }

  // Ressources statiques locales uniquement.
  const isStaticAsset =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/manifest.webmanifest'

  if (!isStaticAsset) return

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached

      try {
        const response = await fetch(request)
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      } catch {
        return Response.error()
      }
    })
  )
})
