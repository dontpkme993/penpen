/* ═══════════════════════════════════════════
   PENPEN  —  Service Worker (PWA)
   ═══════════════════════════════════════════ */
const CACHE_NAME  = 'webpainter-v1';
const CACHE_URLS  = [
  './',
  './index.html',
  './css/app.css',
  './js/core.js',
  './js/engine.js',
  './js/tools.js',
  './js/filters.js',
  './js/ui.js',
  './js/app.js',
  './manifest.json'
];

/* Install: pre-cache all app shell files */
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
});

/* Activate: remove old caches */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Fetch: serve from cache, fallback to network */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
