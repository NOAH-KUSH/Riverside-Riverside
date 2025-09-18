/* upgraded service-worker.js
   - CacheStorage for static files & media
   - IndexedDB for API (JSON) responses + pins for media
   - cache-first for media, network-first for navigation/API with offline fallbacks
   - Range support for cached full video files (returns 206 slices)
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

/* --------------------------
   Message handler (pin / unpin / delete)
   - page can postMessage({action:'pin', url})
   - page can postMessage({action:'unpin', url})
   - page can postMessage({action:'delete', url})  // optional immediate delete from cache
-----------------------------*/
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (!msg || !msg.action) return;

  if (msg.action === 'pin' && msg.url) {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        // check if we already have a full cached copy
        let existing = await cache.match(msg.url) || await cache.match(new Request(msg.url));
        if (!existing) {
          // fetch full resource without Range (ensure full 200 when possible)
          try {
            const net = await fetch(msg.url, { mode: 'cors' });
            if (net && net.ok && net.status === 200) {
              await cache.put(msg.url, net.clone());
            } else {
              // if server returns 206 for a normal fetch, we do not cache partial
              console.warn('Pin fetch returned non-200, skipping cache for', msg.url, net && net.status);
            }
          } catch (e) {
            console.warn('Pin fetch failed', e);
          }
        }
        await idbPut(PIN_STORE, { url: msg.url, pinned: true, timestamp: Date.now() });
        const pinnedKeys = (await idbGetAllKeys(PIN_STORE)) || [];
        await trimCache(CACHE_NAME, 200, new Set(pinnedKeys));
      } catch (err) {
        console.warn('Pin failed', err);
      }
    })());
    return;
  }

  if (msg.action === 'unpin' && msg.url) {
    event.waitUntil((async () => {
      try {
        await idbDelete(PIN_STORE, msg.url);
        // do not immediately delete from cache here; trimming will remove it later unless you want immediate removal
      } catch (err) {
        console.warn('Unpin failed', err);
      }
    })());
    return;
  }

  if (msg.action === 'delete' && msg.url) {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.delete(msg.url);
        await idbDelete(PIN_STORE, msg.url);
      } catch (err) {
        console.warn('Delete cached resource failed', err);
      }
    })());
    return;
  }
});

/* --------------------------
   Helper: serve byte range from a full Response
   - NOTE: this loads the response into memory via arrayBuffer().
     For very large files you may want a streaming approach.
-----------------------------*/
async function serveRangeFromFullResponse(fullResponse, request) {
  // If no range request, return the full cloned response
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) {
    return fullResponse.clone();
  }

  // parse the range header "bytes=start-end"
  const matches = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
  if (!matches) {
    return new Response(null, { status: 416 });
  }

  const start = Number(matches[1]);
  const end = matches[2] ? Number(matches[2]) : undefined;

  // pull bytes from full response (arrayBuffer)
  const buf = await fullResponse.clone().arrayBuffer();
  const size = buf.byteLength;
  const realEnd = (typeof end === 'number' && end < size) ? end : size - 1;

  if (start >= size || start > realEnd) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` }
    });
  }

  const chunk = buf.slice(start, realEnd + 1);
  const headers = new Headers();
  headers.set('Content-Range', `bytes ${start}-${realEnd}/${size}`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(chunk.byteLength));
  headers.set('Content-Type', fullResponse.headers.get('Content-Type') || 'video/mp4');

  return new Response(chunk, { status: 206, headers });
}

/* --------------------------
   FETCH: main routing
-----------------------------*/
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith((async () => {
    const url = new URL(req.url);

    // 1) Navigation -> network-first, fallback to cached index
    if (req.mode === "navigate" || req.destination === "document") {
      try {
        const netResp = await fetch(req);
        // update cache copy for navigation requests (cache the index)
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

    // 2) Video requests -> Range-aware, cache-first; network fallback; mark as pinned in IDB when appropriate
    if (isVideoRequest(req, url)) {
      const cache = await caches.open(CACHE_NAME);

      // Try to find a cached full response (lookup both Request and url)
      let cached = await cache.match(req) || await cache.match(req.url);

      if (cached) {
        // Serve requested range or full from cached full copy
        // Start a background refresh to update the cached copy if online
        event.waitUntil((async () => {
          try {
            // Fetch without special headers to get full resource (server may return 200)
            const net = await fetch(req);
            if (net && net.ok && net.status === 200) {
              await cache.put(req.url, net.clone());
              await idbPut(PIN_STORE, { url: req.url, pinned: true, timestamp: Date.now() });
            }
          } catch (e) { /* ignore background update errors */ }
        })());

        // return cached with range support
        return serveRangeFromFullResponse(cached, req);
      }

      // Not cached -> try network
      try {
        const netResp = await fetch(req);
        if (netResp && (netResp.status === 206)) {
          // server returned a partial response for this Range request.
          // Do not cache the partial response (we need full copy).
          return netResp;
        }

        if (netResp && netResp.ok && netResp.status === 200) {
          // We got a full response from network.
          // Cache it, mark pinned, then if client requested a range, serve a 206 slice.
          event.waitUntil((async () => {
            try {
              await cache.put(req.url, netResp.clone());
              await idbPut(PIN_STORE, { url: req.url, pinned: true, timestamp: Date.now() });
              const pinnedKeys = (await idbGetAllKeys(PIN_STORE)) || [];
              const exclude = new Set(pinnedKeys);
              await trimCache(CACHE_NAME, 200, exclude);
            } catch (e) { /* ignore */ }
          })());

          // If request is a Range request, slice and return 206; otherwise return full
          if (req.headers.get('range')) {
            return serveRangeFromFullResponse(netResp, req);
          }
          return netResp;
        }

        // other network status: try to serve cache (unlikely at this point), otherwise fail
      } catch (e) {
        // network failed -> try to serve from cache if any (in case of race)
        const cachedAgain = await cache.match(req) || await cache.match(req.url);
        if (cachedAgain) return serveRangeFromFullResponse(cachedAgain, req);
        return new Response("", { status: 503 });
      }

      // fallback no video
      return new Response("", { status: 503 });
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
