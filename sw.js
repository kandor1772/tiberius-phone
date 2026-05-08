const CACHE = "tiberius-phone-v99-notifications";
const APP_ENTRY = "./?v=notifications-v33";
const ASSETS = [
  APP_ENTRY,
  "index.html?v=notifications-v33",
  "style.css",
  "app.js?v=notifications-v33",
  "multiplayer-client.js?v=notifications-v33",
  "tiberius-overlay.js",
  "stockfish-adapter.js?v=notifications-v33",
  "memory-sources.json",
  "tiberius-memory-full.json.gz",
  "vendor/stockfish/stockfish.js",
  "vendor/stockfish/stockfish.wasm",
  "vendor/stockfish/Copying.txt",
  "vendor/stockfish/README.md",
  "vendor/stockfish/UPSTREAM_README.md",
  "tiberius-memory-lite.json",
  "manifest.webmanifest?v=notifications-v33",
  "icon.svg",
  "LICENSES.md",
  "MULTIPLAYER_RELAY.md"
];

function appUrl() {
  return new URL(APP_ENTRY, self.location.origin).href;
}

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

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_err) {
    payload = {};
  }
  const title = payload.title || "Tiberius";
  const body = payload.body || "New challenge waiting.";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: payload.tag || "tiberius-challenge",
    renotify: true,
    icon: "icon.svg",
    badge: "icon.svg",
    data: { url: payload.url || appUrl() },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || appUrl();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && "focus" in client) {
        await client.focus();
        client.postMessage?.({ type: "tiberius-notification-opened" });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
