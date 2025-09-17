// Fetch: Cache-first with network fallback + runtime caching
self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse; // ✅ Serve from cache if available
      }

      // Otherwise, try network
      return fetch(event.request).then(networkResponse => {
        // ✅ Cache successful network responses for next time
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // 🔴 If offline and not cached, provide fallback
        if (event.request.destination === "document") {
          return caches.match("/index.html"); // fallback to app shell
        }
        if (event.request.destination === "image") {
          return new Response(
            "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='150'>" +
            "<rect width='100%' height='100%' fill='lightgray'/>" +
            "<text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='black'>Offline</text></svg>",
            { headers: { "Content-Type": "image/svg+xml" } }
          );
        }
        return new Response("Offline content not available", { status: 503, statusText: "Service Unavailable" });
      });
    })
  );
});
