/* ISROAD'S service worker: app shell + libraries + map tiles work offline after the first visit. */
const SHELL = 'shvil-shell-2b4a122c7b'; // new build -> new cache, old one deleted on activate
const LIBS = 'shvil-libs-v1';
const TILES = 'shvil-tiles-v1'; // shared with src/ui/offline.ts
const MAX_TILE_ENTRIES = 3000;

const SHELL_FILES = ['./', './index.html', './app.2b4a122c7b.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './favicon.png', './trails.geojson'];
const LIB_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_HOSTS = [
  'server.arcgisonline.com', 'tile.openstreetmap.org', 'tile.opentopomap.org', 'israelhiking.osm.org.il',
  'tile.waymarkedtrails.org', 'tile-cyclosm.openstreetmap.fr',
];
const hostIn = (url, list) => list.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(SHELL);
      // cache: 'reload' = bypass the browser HTTP cache, so we never precache a stale copy
      await Promise.allSettled(SHELL_FILES.map((f) => c.add(new Request(f, { cache: 'reload' }))));
      // also warm the CDN libraries the page asks for (best effort; they are cached on first use anyway)
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keep = new Set([SHELL, LIBS, TILES]);
      for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k); // also clears caches of older builds
      await self.clients.claim();
    })()
  );
});

async function networkFirst(req, cacheName, timeoutMs = 4000) {
  const cache = await caches.open(cacheName);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    // 'no-cache' = always revalidate with the server, so a fresh deploy shows up immediately
    const res = await fetch(req.mode === 'navigate' ? req.url : req, { signal: ctrl.signal, cache: 'no-cache' });
    clearTimeout(t);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const hit = (await cache.match(req)) || (await cache.match('./index.html'));
    if (hit) return hit;
    throw _;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

async function tileFetch(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type !== 'opaque') {
      cache.put(req, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILE_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_TILE_ENTRIES)) await cache.delete(k);
  } finally {
    trimming = false;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // Overpass POST etc. are never cached here
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate' || url.pathname.endsWith('/trails.geojson')) {
      e.respondWith(networkFirst(req, SHELL));
    } else {
      e.respondWith(staleWhileRevalidate(req, SHELL));
    }
    return;
  }
  e.respondWith(
    (async () => {
      // an offline-area tile (or any tile we saved) wins over the network, whatever host it comes from
      const tiles = await caches.open(TILES);
      const saved = await tiles.match(req);
      if (saved) return saved;
      // any cross-origin script / stylesheet / font (MapLibre, Turf, Tailwind, web fonts): cached on first use
      if (hostIn(url, LIB_HOSTS) || ['script', 'style', 'font'].includes(req.destination)) return cacheFirst(req, LIBS);
      if (hostIn(url, TILE_HOSTS)) return tileFetch(req);
      // routing / search / overpass GET: straight to the network (the app has its own timeouts, retries and caches)
      return fetch(req);
    })()
  );
});
