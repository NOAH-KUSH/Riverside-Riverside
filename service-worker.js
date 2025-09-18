/* upgraded service-worker.js
   - CacheStorage for static files & media
   - IndexedDB for API (JSON) responses + pins for media
   - cache-first for media, network-first for navigation/API with offline fallbacks
*/

const CACHE_NAME = "pwa-demo-v4";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./maskable_icon_x192.png",
  "./maskable_icon_x512.png",
  "./images/riverside-logo.png",
  "./church-service.jpg",
  "./first-video.mp4" // you can remove large media from CORE_ASSETS if you don't want to prefetch
];

// IndexedDB settings
const DB_NAME = "pwa-idb-v1";
const DB_VERSION = 1;
const API_STORE = "api";
const PIN_STORE = "pins";

let dbPromise = null;
function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(API_STORE)) db.createObjectStore(API_STORE, { keyPath: "url" });
      if (!db.objectStoreNames.contains(PIN_STORE)) db.createObjectStore(PIN_STORE, { keyPath: "url" });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

async function idbPut(storeName, obj) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const r = store.put(obj);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGetAll(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGetAllKeys(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const r = store.getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const r = store.delete(key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

// Trim entries from an IDB store by timestamp (keep newest `maxEntries`)
async function trimIDBStore(storeName, maxEntries = 50) {
  try {
    const all = await idbGetAll(storeName);
    if (!all || all.length <= maxEntries) return;
    all.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)); // oldest first
    const toDelete = all.slice(0, all.length - maxEntries);
    await Promise.all(toDelete.map(item => idbDelete(storeName, item.url)));
  } catch (e) {
    // non-fatal
    console.warn("trimIDBStore error", e);
  }
}

// Trim CacheStorage but don't drop pinned URLs
async function trimCache(cacheName, maxItems, excludeUrls = new Set()) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys(); // ordered by insertion
  if (keys.length <= maxItems) return;
  // delete oldest non-excluded entries until under limit
  const nonExcluded = keys.filter(k => !excludeUrls.has(k.url));
  let toDeleteCount = keys.length - maxItems;
  for (let i = 0; i < nonExcluded.length && toDeleteCount > 0; i++) {
    await cache.delete(nonExcluded[i]);
    toDeleteCount--;
  }
}

// INSTALL: cache core assets tolerant to failures (single missing file won't fail install)
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(CORE_ASSETS.map(async (url) => {
      try {
        const resp = await fetch(url, { cache: "no-cache" });
        if (!resp || !resp.ok) throw new Error("bad response");
        await cache.put(url, resp.clone());
      } catch (err) {
        console.warn("Failed to cache (will continue):", url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

// ACTIVATE: cleanup old caches
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => (k !== CACHE_NAME)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Helpers to detect request type
function isAPIRequest(req, url) {
  // treat explicit JSON accept header, common '/api/' patterns or .json as API
  return (req.headers.get("accept") || "").includes("application/json")
    || url.pathname.includes("/api/")
    || url.pathname.endsWith(".json");
}
function isStaticAsset(req) {
  return req.destination === "script" ||
         req.destination === "style" ||
         req.destination === "image" ||
         req.destination === "font" ||
         req.url.endsWith(".json");
}
function isVideoRequest(req, url) {
  return req.destination === "video" || /\.(mp4|webm|ogg|m3u8)$/i.test(url.pathname);
}

// FETCH: main routing
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith((async () => {
    const url = new URL(req.url);

    // 1) Navigation -> network-first, fallback to cached index
    if (req.mode === "navigate" || req.destination === "document") {
      try {
        const netResp = await fetch(req);
        // update cache copy for navigation requests
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, netResp.clone()).catch(() => {});
        return netResp;
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        const cachedIndex = await cache.match("./index.html") || await cache.match("./");
        if (cachedIndex) return cachedIndex;
        return new Response("<!doctype html><meta charset='utf-8'><title>Offline</title><body><h1>Offline</h1><p>Please check your connection.</p></body>", {
          headers: { "Content-Type": "text/html" }
        });
      }
    }

    // 2) Video requests -> cache-first, network fallback; mark as pinned in IDB
    if (isVideoRequest(req, url)) {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) {
        // update in background (don't block returning cached video)
        event.waitUntil((async () => {
          try {
            const net = await fetch(req);
            if (net && net.ok) {
              await cache.put(req, net.clone());
              await idbPut(PIN_STORE, { url: req.url, pinned: true, timestamp: Date.now() });
            }
          } catch (e) { /* ignore background update errors */ }
        })());
        return cached;
      }

      // not cached -> try network and save & pin
      try {
        const netResp = await fetch(req);
        if (netResp && netResp.ok) {
          event.waitUntil((async () => {
            try {
              await cache.put(req, netResp.clone());
              await idbPut(PIN_STORE, { url: req.url, pinned: true, timestamp: Date.now() });
              // keep cache trimmed but exclude pinned entries
              const pinnedKeys = (await idbGetAllKeys(PIN_STORE)) || [];
              const exclude = new Set(pinnedKeys);
              await trimCache(CACHE_NAME, 200, exclude); // tweak max items as desired
            } catch (e) { /* ignore */ }
          })());
          return netResp;
        }
      } catch (e) {
        // network failed -> serve cache if available
        const cachedAgain = await cache.match(req);
        if (cachedAgain) return cachedAgain;
        // no video available
        return new Response("", { status: 503 });
      }
    }

    // 3) Static assets -> cache-first with background update (scripts/styles/images)
    if (isStaticAsset(req) || url.origin === location.origin) {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const networkFetch = fetch(req).then(async response => {
        if (response && response.ok) {
          try { await cache.put(req, response.clone()); } catch (e) { /* ignore */ }
        }
        return response;
      }).catch(() => null);

      if (cached) {
        event.waitUntil(networkFetch); // update in background
        return cached;
      }

      const netResp = await networkFetch;
      if (netResp) return netResp;

      // fallback to runtime (if any)
      const runtimeCache = await caches.open(CACHE_NAME);
      const runtimeCached = await runtimeCache.match(req);
      if (runtimeCached) return runtimeCached;

      if (req.destination === "image") return new Response(null, { status: 503 }); // optional blank
      return new Response("", { status: 503 });
    }

    // 4) API / dynamic JSON -> network-first; store JSON in IndexedDB for offline
    if (isAPIRequest(req, url)) {
      try {
        const networkResponse = await fetch(req);
        if (networkResponse && networkResponse.ok) {
          try {
            const cloned = networkResponse.clone();
            const data = await cloned.json().catch(() => null);
            if (data !== null) {
              // store JSON result keyed by url
              await idbPut(API_STORE, { url: req.url, data, timestamp: Date.now() });
              event.waitUntil(trimIDBStore(API_STORE, 100)); // cap number of stored API entries
            }
          } catch (e) { /* ignore save errors */ }
        }
        return networkResponse;
      } catch (err) {
        // offline -> return cached JSON from IDB
        try {
          const cachedObj = await idbGet(API_STORE, req.url);
          if (cachedObj && cachedObj.data !== undefined) {
            return new Response(JSON.stringify(cachedObj.data), {
              headers: { "Content-Type": "application/json" }
            });
          }
        } catch (e) { /* ignore */ }

        // fallback to static cache if present
        const staticCache = await caches.open(CACHE_NAME);
        const staticCached = await staticCache.match(req);
        if (staticCached) return staticCached;

        return new Response("", { status: 503 });
      }
    }

    // 5) Other requests: try network, cache copy if OK, fallback to cache
    try {
      const networkResponse = await fetch(req);
      // optionally store some dynamic assets into runtime cache (if desired)
      return networkResponse;
    } catch (err) {
      // network failed: try cache
      const staticCache = await caches.open(CACHE_NAME);
      const staticCached = await staticCache.match(req);
      if (staticCached) return staticCached;
      return new Response("", { status: 503 });
    }
  })());
});
