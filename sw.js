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
  './js/changelog.js',
  './js/core.js',
  './js/engine.js',
  './js/tools.js',
  './js/filters.js',
  './js/ui.js',
  './js/app.js',
  './js/ai.js',
  './manifest.json'
];

/* Install: pre-cache all app shell files */
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
});

/* Activate: remove old caches
   只清理舊版的 app shell 快取（penpen-v*）。AI 模型快取（penpen-ai-models-*）
   存的是數百 MB 的 ONNX 權重，不可隨版本更新一起刪除，否則使用者每次改版
   都要重新下載模型。 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k.startsWith('penpen-v') && k !== CACHE_NAME)
        .map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Fetch: network-first，有網路就拿最新版，離線才用快取。
   只快取同源資源（app shell）。跨來源請求一律放行不攔截：AI 模型權重動輒
   200 MB 以上，若也寫進這裡會與 Transformers.js 自己的快取、以及
   penpen-ai-models-* 重複存放，而且每次改版都被清掉重新下載。 */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (!response || response.status !== 200 || response.type === 'opaque') return response;
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
