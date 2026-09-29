/*
 * sw.js — offline shell + catalog cache.
 *
 * Strategy:
 *   - App shell (HTML, CSS, JS, vendored libs): network-first, falling back to
 *     the cache when offline. Shell entries are code, so a stale copy is a
 *     running bug rather than a stale pixel; offline still gets the full UI
 *     from the last good copy.
 *   - catalog.json and shows.json: network-first, falling back to the cache when
 *     offline. Both are hand-edited on disk — the catalog when clips are added,
 *     shows.json when a venue or date is corrected — so the copy on the server is
 *     the current one and there is nothing to gain from serving a stale version
 *     first. That just means one reload shows nothing that was just filled in.
 *     Offline still works, from the last good copy.
 *   - Album art: cache-first with a capped runtime cache.
 *   - Video media: never intercepted. Range requests and multi-GB files are the
 *     one thing a naive cache does worse than the network.
 */

const VERSION = "pittv-v21";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const ART_CACHE = `${VERSION}-art`;
const MAX_ART_ENTRIES = 300;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  // Home Screen / Dock icons. Safari reads apple-touch-icon.png straight off
  // the network during Add-to-Home-Screen, so it must not depend on a cache
  // warm-up that has not happened yet on a first visit.
  "./apple-touch-icon.png",
  "./assets/icons/icon-152.png",
  "./assets/icons/icon-167.png",
  "./assets/icons/icon-180.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon.svg",
  "./assets/css/variables.css",
  "./assets/css/reset.css",
  "./assets/css/layout.css",
  "./assets/css/components.css",
  "./assets/css/player.css",
  "./assets/css/animations.css",
  "./assets/css/edit.css",
  "./assets/css/upload.css",
  "./assets/js/app.js",
  "./assets/js/store.js",
  "./assets/js/ui.js",
  "./assets/js/catalog.js",
  "./assets/js/search.js",
  "./assets/js/player.js",
  "./assets/js/theme.js",
  "./assets/js/anime-helpers.js",
  "./assets/js/edit.js",
  "./assets/js/grouping.js",
  "./assets/js/upload.js",
  "./assets/js/sync.js",
  "./assets/js/pwa.js",
  "./lib/anime.min.js",
  "./lib/hls.min.js",
  "./data/catalog.json",
  "./data/shows.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic — one 404 would leave the app with no cache at all, so
      // add individually and tolerate partial coverage.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) =>
            console.warn("[sw] could not precache", url, err.message)
          )
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // third-party art/CDN: let it go to the network

  if (request.headers.has("range")) return; // media streaming: never touch

  if (/\.(?:mp4|webm|m4v|mov|mkv|m3u8|mpd|ts)$/i.test(url.pathname)) return;

  // The catalog is the one file that changes on disk while the app is running
  // (clips added, titles edited), so it is network-first: a refresh shows the
  // current list rather than a cached one. shows.json is a static join table
  // that only changes when the catalog does, so it is served from the shell
  // cache below — no network round-trip on every load.
  if (/(?:^|\/)(?:data\/)?catalog(?:\.demo)?\.json$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (/\/covers\/|\.(?:jpe?g|png|webp|avif|gif)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ART_CACHE, MAX_ART_ENTRIES));
    return;
  }

  if (SHELL_ASSETS.some((a) => url.pathname.endsWith(a.replace("./", ""))) || url.pathname === "/" || url.pathname.endsWith(".html")) {
    // Network-first, not cache-first. The shell is code, and code is the one
    // thing a returning visitor must never be served a stale copy of: a fix
    // pushed to ui.js would otherwise be unreachable until VERSION was bumped
    // by hand, so the browser kept running the bug it was supposed to have
    // lost. Offline still works — networkFirst falls back to the cache — and
    // the round trip is one small request against a local/static origin.
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;

  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok || response.type === "opaque") {
      await cache.put(request, response.clone());
      if (maxEntries) trimCache(cache, maxEntries);
    }
    return response;
  } catch (err) {
    const fallback = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (fallback) return fallback;
    throw err;
  }
}

/**
 * Always try the network, fall back to the last good copy when it is
 * unreachable. Used for the catalog, which changes on disk whenever the
 * data tools are run.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // cache: "no-store" is essential: without it the browser's own HTTP cache
    // answers with a 304 (no body) and the app cannot parse an empty response.
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });

  const network = fetch(request, { cache: "no-store" })
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (hit) return hit;
  const response = await network;
  if (response) return response;

  return new Response("Offline and not cached.", {
    status: 503,
    headers: { "Content-Type": "text/plain" },
  });
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
}
