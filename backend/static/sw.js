const CACHE_NAME = "labtracker-v27";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=32",
  "/app.js?v=46",
  "/icon.svg",
  "/icon-maskable.svg",
  "/manifest.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Do not intercept non-GET requests or external/API calls
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin) || e.request.url.includes("/api/")) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(e.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // If the resource is not in cache, fallback to index.html for navigation requests
          if (e.request.mode === "navigate") {
            return caches.match("/");
          }
          return Promise.reject("no-match");
        });
      })
  );
});
