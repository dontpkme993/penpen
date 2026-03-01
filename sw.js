/* ═══════════════════════════════════════════
   PENPEN  —  Service Worker (PWA)
   版本號自動從 changelog.js 讀取，無須手動維護
   ═══════════════════════════════════════════ */
importScripts('./js/changelog.js');

const CACHE_NAME  = 'penpen-v' + CHANGELOG[0].version;
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

/* Fetch: network-first，有網路就拿最新版，離線才用快取 */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (!response || response.status !== 200 || response.type === 'opaque') return response;
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
