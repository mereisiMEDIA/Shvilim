/* ISROAD'S (Leaflet build) service worker.
 * Design choice that matters here: the app shell (index.html / app.js / style.css / trails.geojson)
 * is served NETWORK-FIRST, so a new deploy is picked up on the very next load instead of being
 * masked by a stale cache - this is what caused "still shows the old version" earlier in this project.
 * Only the immutable stuff (map tiles, the Leaflet library) is cache-first.
 */
const SHELL_CACHE = 'isroads-leaflet-shell-v1';
const TILE_CACHE = 'isroads-leaflet-tiles-v1';
const LIB_CACHE = 'isroads-leaflet-libs-v1';
const MAX_TILES = 2000;

const SHELL_FILES = ['./', './index.html', './app.js', './geo.js', './drive.js', './style.css', './trails.geojson', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, TILE_CACHE, LIB_CACHE]);
      for (const key of await caches.keys()) {
        if (!keep.has(key)) await caches.delete(key); // drop caches from any earlier build at this origin
      }
      await self.clients.claim();
    })()
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) {
    cache.put(req, res.clone());
    if (cap) trimCache(cache, cap);
  }
  return res;
}

let trimming = false;
async function trimCache(cache, cap) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > cap) for (const k of keys.slice(0, keys.length - cap)) await cache.delete(k);
  } finally {
    trimming = false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
    return;
  }
  if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }
  // Overpass / Wikipedia / Waze: always live, never cached
});
