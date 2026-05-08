const CACHE = "tiberius-phone-v96-surface-routed-relay";
const APP_ENTRY = "./?v=surface-routed-relay-v30";
const ASSETS = [
  APP_ENTRY,
  "index.html?v=surface-routed-relay-v30",
  "style.css",
  "app.js?v=surface-routed-relay-v30",
  "multiplayer-client.js?v=surface-routed-relay-v30",
  "tiberius-overlay.js",
  "stockfish-adapter.js",
  "memory-sources.json",
  "tiberius-memory-full.json.gz",
  "vendor/stockfish/stockfish.js",
  "vendor/stockfish/stockfish.wasm",
  "vendor/stockfish/Copying.txt",
  "vendor/stockfish/README.md",
  "vendor/stockfish/UPSTREAM_README.md",
  "tiberius-memory-lite.json",
  "manifest.webmanifest?v=surface-routed-relay-v30",
  "icon.svg",
  "LICENSES.md",
  "MULTIPLAYER_RELAY.md"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key.startsWith("tiberius-phone-") && key !== CACHE)
      .map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: "reload" }).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(event.request).then(match => {
      if (match) return match;
      if (event.request.mode === "navigate") return caches.match(APP_ENTRY);
      return undefined;
    }))
  );
});
