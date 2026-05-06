const CACHE = "tiberius-phone-v1";
const ASSETS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "tiberius-overlay.js",
  "stockfish-adapter.js",
  "tiberius-memory-lite.json",
  "manifest.webmanifest",
  "icon.svg",
  "LICENSES.md"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(event.request))
  );
});
