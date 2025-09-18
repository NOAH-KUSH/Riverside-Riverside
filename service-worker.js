/* upgraded service-worker.js
   - safe core asset caching (won't fail install on missing files)
   - cache-first for static assets with background update
   - network-first for navigation (fallback to cached index.html)
   - runtime caching for dynamic requests, with cache size limit
*/

const CACHE_NAME = "pwa-demo-v4";        // bump this when you release breaking changes
const RUNTIME = "pwa-runtime-v1";
const CORE_ASSETS = [
  "./",             // root - important for SPA-style apps
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./images/riverside-logo.png",
   "./church-service.jpg" 
 
];

// Utility: trim a cache to `maxItems` by deleting oldest entries
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxItems) return;
  await cache.delete(keys[0]);
  // recursive until trimmed
  await trimCache(cacheName, maxItems);
}

// INSTALL: cache core assets but be tolerant of individual failures
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache each asset individually so a single missing file doesn't fail the whole install
    await Promise.all(CORE_ASSETS.map(async (url) => {
      try {
        const response = await fetch(url, {cache: "no-cache"});
        if (!response || !response.ok) throw new Error("bad response");
        await cache.put(url, response.clone());
      } catch (err) {
        // log but don't fail install
        console.warn("Failed to cache (will continue):", url, err);
      }
    }));
    // activate new SW immediately
    await self.skipWaiting();
  })());
});

// ACTIVATE: remove old caches
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => (k !== CACHE_NAME && k !== RUNTIME)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// FETCH: smart routing
self.addEventListener("fetch", event => {
  const req = event.request;

  // Only handle GET requests in the SW caching logic
  if (req.method !== "GET") {
    return; // let the browser handle non-GETs normally
  }

  event.respondWith((async () => {
    const url = new URL(req.url);

    // 1) Navigation requests (HTML/pages) -> network-first, fallback to cached index.html
    if (req.mode === "navigate" || req.destination === "document") {
      try {
        const networkResponse = await fetch(req);
        // update the cache with the fresh HTML (helps when user goes offline shortly after)
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, networkResponse.clone()).catch(() => {});
        return networkResponse;
      } catch (err) {
        // offline or network error -> serve cached index.html as fallback
        const cache = await caches.open(CACHE_NAME);
        const cachedIndex = await cache.match("./index.html") || await cache.match("./");
        if (cachedIndex) return cachedIndex;
        // last resort: simple offline response
        return new Response("<!doctype html><meta charset='utf-8'><title>Offline</title><body><h1>Offline</h1><p>Please check your connection.</p></body>", {
          headers: { "Content-Type": "text/html" }
        });
      }
    }

    // 2) Static assets (scripts, styles, images, fonts, JSON) -> cache-first with background update
    const isStaticAsset = (
      req.destination === "script" ||
      req.destination === "style" ||
      req.destination === "image" ||
      req.destination === "font" ||
      req.url.endsWith(".json")
    );

    if (isStaticAsset || url.origin === location.origin) {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      // start network fetch in background to update cache
      const networkFetch = fetch(req).then(async response => {
        if (response && response.ok) {
          try { await cache.put(req, response.clone()); } catch(e) { /* ignore */ }
        }
        return response;
      }).catch(() => { /* ignore network errors */ });

      if (cached) {
        // serve cached quickly, update cache in background
        event.waitUntil(networkFetch);
        return cached;
      }

      // nothing cached -> try network, then fallback to runtime cache
      const netResp = await networkFetch;
      if (netResp) return netResp;

      // last resort: try runtime cache
      const runtimeCache = await caches.open(RUNTIME);
      const runtimeCached = await runtimeCache.match(req);
      if (runtimeCached) return runtimeCached;

      // and finally give a generic response for images (optional)
      if (req.destination === "image") {
        return new Response(null, { status: 503 }); // blank image response
      }
      return new Response("", { status: 503 });
    }

    // 3) API / dynamic requests -> network-first with runtime cache fallback
    try {
      const networkResponse = await fetch(req);
      // store API responses in runtime cache for offline usage
      const runtimeCache = await caches.open(RUNTIME);
      if (networkResponse && networkResponse.ok) {
        runtimeCache.put(req, networkResponse.clone()).catch(() => {});
        // limit runtime cache size (e.g. 50 entries)
        trimCache(RUNTIME, 50).catch(() => {});
      }
      return networkResponse;
    } catch (err) {
      // network failed -> try runtime cache
      const runtimeCache = await caches.open(RUNTIME);
      const cached = await runtimeCache.match(req);
      if (cached) return cached;
      // fallback to cached static if appropriate
      const staticCache = await caches.open(CACHE_NAME);
      const staticCached = await staticCache.match(req);
      if (staticCached) return staticCached;
      return new Response("", { status: 503 });
    }
  })());
});
