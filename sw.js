const CACHE = "tiberius-phone-v103-roster-seeds";
const APP_ENTRY = "./?v=roster-seeds-v37";
const NOTIFICATION_STATE_CACHE = "tiberius-notification-state-v1";
const INVITE_COUNT_ENTRY = "/__tiberius_invite_count";
const ASSETS = [
  APP_ENTRY,
  "index.html?v=roster-seeds-v37",
  "style.css",
  "app.js?v=roster-seeds-v37",
  "multiplayer-client.js?v=roster-seeds-v37",
  "tiberius-overlay.js",
  "stockfish-adapter.js?v=roster-seeds-v37",
  "memory-sources.json",
  "tiberius-memory-full.json.gz",
  "vendor/stockfish/stockfish.js",
  "vendor/stockfish/stockfish.wasm",
  "vendor/stockfish/Copying.txt",
  "vendor/stockfish/README.md",
  "vendor/stockfish/UPSTREAM_README.md",
  "tiberius-memory-lite.json",
  "manifest.webmanifest?v=roster-seeds-v37",
  "icon.svg",
  "LICENSES.md",
  "MULTIPLAYER_RELAY.md"
];

function appUrl() {
  return new URL(APP_ENTRY, self.registration.scope).href;
}

function normalizeAppUrl(value) {
  const fallback = appUrl();
  try {
    const url = new URL(value || fallback, self.registration.scope);
    const scope = new URL(self.registration.scope);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return fallback;
    return url.href;
  } catch (_err) {
    return fallback;
  }
}

async function setInviteBadge(count) {
  if ("setAppBadge" in navigator) {
    await navigator.setAppBadge(count).catch(() => {});
  }
}

async function readInviteCount() {
  const cache = await caches.open(NOTIFICATION_STATE_CACHE);
  const response = await cache.match(INVITE_COUNT_ENTRY);
  const state = response ? await response.json().catch(() => ({})) : {};
  const count = Number(state.count || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

async function writeInviteCount(count) {
  const cache = await caches.open(NOTIFICATION_STATE_CACHE);
  await cache.put(INVITE_COUNT_ENTRY, new Response(JSON.stringify({ count }), {
    headers: { "Content-Type": "application/json" },
  }));
}

async function clearInviteBadge() {
  await writeInviteCount(0).catch(() => {});
  if ("clearAppBadge" in navigator) {
    await navigator.clearAppBadge().catch(() => {});
  }
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
  event.waitUntil((async () => {
    const tag = payload.tag || "tiberius-challenge";
    const existing = await self.registration.getNotifications({ tag });
    const notificationCount = existing.reduce((max, notification) => {
      const count = Number(notification.data?.count || 0);
      return Number.isFinite(count) ? Math.max(max, count) : max;
    }, 0);
    const previousCount = Math.max(await readInviteCount(), notificationCount);
    const count = previousCount + 1;
    await writeInviteCount(count);
    await setInviteBadge(count);
    const title = count > 1 ? `Tiberius (${count})` : payload.title || "Tiberius";
    const body = count > 1 ? `${count} challenges waiting.` : payload.body || "New challenge waiting.";
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction: true,
      timestamp: Date.now(),
      icon: "icon.svg",
      badge: "icon.svg",
      data: { url: payload.url || appUrl(), count },
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = normalizeAppUrl(event.notification?.data?.url);
  event.waitUntil((async () => {
    await clearInviteBadge();
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const scope = new URL(self.registration.scope);
    for (const client of windows) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === scope.origin && clientUrl.pathname.startsWith(scope.pathname) && "focus" in client) {
        await client.focus();
        client.postMessage?.({ type: "tiberius-notification-opened" });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type !== "tiberius-clear-notification-count") return;
  const pending = clearInviteBadge();
  if (event.waitUntil) event.waitUntil(pending);
});
