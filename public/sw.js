// App-shell service worker.
//
// Strategy: NETWORK-FIRST for same-origin GETs, with the cache as an offline
// fallback only. This means an online phone always gets the latest deploy — no
// more "stuck on an old cached build" after we ship changes. The cache is
// refreshed on every successful fetch so the app still opens offline.
//
// /api/* is never touched — financial data must never be served from disk cache.

const CACHE = 'keuangan-shell-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept the API or cross-origin requests — always hit the network.
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)), // offline: fall back to the last cached copy
  );
});
