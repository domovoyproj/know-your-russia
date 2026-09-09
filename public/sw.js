// KYR Service Worker — Stale-While-Revalidate + Offline Map & Tile Cache
const CACHE_NAME = "kyr-shell-v1.1.0";
const TILE_CACHE_NAME = "kyr-tiles-v1";
const MAX_CACHED_TILES = 800;

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/geo/adm1.min.json",
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"
];

// Helper: Trim cache to max items
async function trimCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      for (let i = 0; i < keys.length - maxItems; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (err) {
    // Ignore cache trim errors
  }
}

// Install: pre-cache app shell and vector map
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Use individual promises so one non-critical failure doesn't abort everything
      await Promise.all(
        CORE_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { mode: url.startsWith("http") ? "cors" : "same-origin" });
            if (res && res.status === 200) {
              await cache.put(url, res);
            }
          } catch (e) {
            console.warn("[SW] Cache preload skipped for:", url, e);
          }
        })
      );
    })
  );
  self.skipWaiting();
});

// Activate: clean up obsolete caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== TILE_CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch dispatcher
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Non-GET requests (uploads, auth, mutations) always bypass SW
  if (req.method !== "GET") {
    return;
  }

  // 1. Map Tiles (OpenStreetMap)
  if (url.hostname.includes("tile.openstreetmap.org")) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const networkRes = await fetch(req);
          if (networkRes && networkRes.status === 200) {
            cache.put(req, networkRes.clone());
            trimCache(TILE_CACHE_NAME, MAX_CACHED_TILES);
          }
          return networkRes;
        } catch (err) {
          return new Response("", { status: 504, statusText: "Offline Tile" });
        }
      })
    );
    return;
  }

  // 2. API Endpoints
  if (url.pathname.startsWith("/api/")) {
    // Network-First for read-only data, cache fallback for offline
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response(JSON.stringify({ error: "offline", offline: true }), {
            headers: { "Content-Type": "application/json" }
          });
        })
    );
    return;
  }

  // 3. User Uploads (/uploads/*)
  if (url.pathname.startsWith("/uploads/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return new Response("", { status: 404 });
        }
      })
    );
    return;
  }

  // 4. App Shell & Static Assets (Stale-While-Revalidate)
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes.clone()));
          }
          return networkRes;
        })
        .catch(() => cached);

      // Return cached immediately if found, or wait for network
      return cached || fetchPromise;
    })
  );
});
