const CACHE_NAME = "pwa-demo-v2"; // bump version when you update
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json"
];

// Install: cache files
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  console.log("Service Worker installed and assets cached");
  self.skipWaiting(); // 👉 activate new SW immediately
});

// Activate: remove old caches
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  console.log("Service Worker activated, old caches cleared");
  self.clients.claim(); // 👉 start controlling all open pages
});

// Fetch: serve cached files first, then network
self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
