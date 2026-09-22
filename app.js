'use strict';

/* geo.js (loaded before this file) provides: haversineKm, nearestPointOnLine, navPointForGeometry, dedupeKey */

/* =====================================================================================
   State
   ===================================================================================== */
let map;
let userMarker = null;
let userAccuracyCircle = null;
let userCoord = null; // {lat, lng} - null until a real GPS fix arrives
let watchId = null;

let currentDestination = null; // for the details panel + Waze
let allDestinations = [];      // merged list: seed + live OSM + live Wikipedia, deduped
const destMarkers = new Map(); // id -> Leaflet layer

let activeCategory = 'all';
let searchText = '';

/* =====================================================================================
   Status banner - every failure is visible, every failure is retryable
   ===================================================================================== */
let statusRetryHandler = null;
function showStatus(text, opts = {}) {
  const banner = document.getElementById('status-banner');
  const textEl = document.getElementById('status-text');
  const retryBtn = document.getElementById('status-retry');
  textEl.textContent = text;
  banner.classList.remove('hidden');
  banner.classList.toggle('error', !!opts.error);
  if (opts.onRetry) {
    statusRetryHandler = opts.onRetry;
    retryBtn.classList.remove('hidden');
  } else {
    statusRetryHandler = null;
    retryBtn.classList.add('hidden');
  }
  if (opts.autoHideMs) {
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => hideStatus(), opts.autoHideMs);
  }
}
function hideStatus() {
  document.getElementById('status-banner').classList.add('hidden');
}

/* =====================================================================================
   Map + geolocation
   ===================================================================================== */
function initMap() {
  map = L.map('map-container', { zoomControl: false }).setView([31.5, 34.8], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors, ISROAD\'S',
  }).addTo(map);

  document.getElementById('locate-btn').addEventListener('click', () => {
    if (userCoord) map.flyTo([userCoord.lat, userCoord.lng], 13);
    else startGeolocation(true);
  });

  loadSeedThenLive();
  wireBrowseSheet();
  wireStatusBanner();
  startGeolocation(false);
}

function wireStatusBanner() {
  document.getElementById('status-dismiss').addEventListener('click', hideStatus);
  document.getElementById('status-retry').addEventListener('click', () => {
    if (statusRetryHandler) statusRetryHandler();
  });
}

function startGeolocation(showDeniedMessage) {
  if (!navigator.geolocation) {
    showStatus('הדפדפן הזה לא תומך במיקום GPS.', { error: true });
    return;
  }
  const onFix = (pos) => {
    const first = !userCoord;
    userCoord = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    updateUserMarker(pos.coords.accuracy);
    document.getElementById('locate-btn').classList.add('active');
    if (first) {
      map.flyTo([userCoord.lat, userCoord.lng], 12);
      loadLiveDestinations(userCoord); // now that we know where "near you" is
      if (typeof loadNearbyTracks === 'function') loadNearbyTracks(userCoord);
    }
    renderDestList(); // distances change as you move
  };
  const onErr = (err) => {
    if (err.code === 1 && showDeniedMessage) {
      showStatus('הרשאת המיקום נחסמה. אפשר מיקום בהגדרות הדפדפן כדי לראות מרחקים ולמקם את עצמך.', { error: true });
    } else if (err.code === 2) {
      showStatus('אין קליטת GPS כרגע.', { error: true, autoHideMs: 5000 });
    }
  };
  navigator.geolocation.getCurrentPosition(onFix, onErr, { enableHighAccuracy: true, timeout: 10000 });
  watchId = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 5000 });
}

function updateUserMarker(accuracyM) {
  const ll = [userCoord.lat, userCoord.lng];
  if (!userMarker) {
    userMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18, 18] }) }).addTo(map);
    userAccuracyCircle = L.circle(ll, { radius: accuracyM || 20, color: '#3b82f6', weight: 1, fillOpacity: 0.1 }).addTo(map);
  } else {
    userMarker.setLatLng(ll);
    userAccuracyCircle.setLatLng(ll).setRadius(accuracyM || 20);
  }
}

/* =====================================================================================
   Loading destinations: seed file first (instant), then live sources (progressive)
   ===================================================================================== */
function addFeaturesToDestinations(features, sourceLabel) {
  let added = 0;
  for (const f of features) {
    const p = f.properties || {};
    const name = p.name || p['name:he'];
    if (!name) continue;
    const point = navPointForGeometry(f.geometry, userCoord);
    if (!point) continue;
    const key = dedupeKey(name, point);
    if (allDestinations.some((d) => d.key === key)) continue;
    allDestinations.push({
      key,
      name,
      type: p.type || 'שטח',
      description: p.description || 'אין תיאור זמין.',
      lat: point.lat,
      lng: point.lng,
      geometry: f.geometry,
      source: sourceLabel,
    });
    added++;
  }
  return added;
}

function loadSeedThenLive() {
  fetch('trails.geojson')
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((data) => {
      const n = addFeaturesToDestinations(data.features || [], 'seed');
      if (n === 0) showStatus('קובץ היעדים המקומי ריק.', { autoHideMs: 4000 });
      renderMarkers();
      renderDestList();
    })
    .catch((err) => {
      console.error('שגיאה בטעינת trails.geojson:', err);
      showStatus('לא הצלחתי לטעון את קובץ היעדים המקומי (trails.geojson). ממשיכים עם יעדים חיים בלבד אם יש GPS.', {
        error: true,
        onRetry: loadSeedThenLive,
        autoHideMs: 7000,
      });
    });
}

/* ---- Overpass: hedged across two mirrors, hard timeout, never hangs the UI ---- */
const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
function overpassQuery(query, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ctrls = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ctrls.forEach((c) => c.abort());
      reject(new Error('overpass timeout'));
    }, timeoutMs);
    let launched = 0, failed = 0;
    const launch = () => {
      if (settled || launched >= OVERPASS_MIRRORS.length) return;
      const url = OVERPASS_MIRRORS[launched++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then((json) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctrls.forEach((c) => c.abort());
          resolve(json);
        })
        .catch(() => {
          if (settled) return;
          failed++;
          if (launched < OVERPASS_MIRRORS.length) launch();
          else if (failed >= launched) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('overpass failed'));
          }
        });
      if (launched < OVERPASS_MIRRORS.length) setTimeout(launch, 3000); // hedge: ask the 2nd mirror if the 1st is slow
    };
    launch();
  });
}

function loadLiveDestinations(center) {
  const radius = 15000;
  const around = `(around:${radius},${center.lat},${center.lng})`;
  const query =
    `[out:json][timeout:20];(` +
    `nwr["natural"="spring"]${around};` +
    `nwr["waterway"="waterfall"]${around};` +
    `nwr["tourism"="viewpoint"]${around};` +
    `nwr["tourism"="camp_site"]${around};` +
    `nwr["tourism"="picnic_site"]${around};` +
    `nwr["historic"~"^(memorial|monument|ruins|archaeological_site|castle|fort)$"]["name"]${around};` +
    `);out tags center;`;

  const OSM_TYPE = {
    spring: 'מעיין', waterfall: 'מפל', viewpoint: 'תצפית', camp_site: 'חניון לילה',
    picnic_site: 'פינת שהייה', memorial: 'אנדרטה', monument: 'אנדרטה', ruins: 'אתר מורשת',
    archaeological_site: 'אתר מורשת', castle: 'אתר מורשת', fort: 'אתר מורשת',
  };

  showStatus('טוען עוד יעדים מ-OpenStreetMap וויקיפדיה…', { autoHideMs: 9000 });

  const osmPromise = overpassQuery(query)
    .then((json) => {
      const feats = [];
      for (const el of json.elements || []) {
        const tags = el.tags || {};
        const name = tags['name:he'] || tags.name;
        if (!name) continue;
        const kind = tags.natural === 'spring' ? 'spring'
          : tags.waterway === 'waterfall' ? 'waterfall'
          : tags.tourism || tags.historic;
        const type = OSM_TYPE[kind] || 'שטח';
        const c = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center;
        if (!c) continue;
        feats.push({
          type: 'Feature',
          properties: { name, type, description: `${type} מתוך OpenStreetMap. ודא בשטח שהמקום נגיש ובטוח.` },
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        });
      }
      const n = addFeaturesToDestinations(feats, 'osm');
      renderMarkers();
      renderDestList();
      return n;
    })
    .catch((err) => {
      console.warn('OSM (Overpass) load failed:', err);
      return 0;
    });

  const wikiPromise = fetch(
    `https://he.wikipedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${center.lat}%7C${center.lng}` +
      `&ggsradius=10000&ggslimit=60&prop=coordinates%7Cdescription&colimit=60&format=json&formatversion=2&origin=*`
  )
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((json) => {
      const SKIP = /(עיר|ישוב|יישוב|קיבוץ|מושב|כפר |שכונה|מועצה|מחוז|אוניברסיט|בית ספר|בית חולים|תחנת|חברה|תאגיד|מפלגה|בסיס|מחנה צבאי)/;
      const RULES = [
        [/מפל/, 'מפל'], [/מעיין|מעיינות/, 'מעיין'], [/שמורת טבע|גן לאומי|שמורה/, 'שמורת טבע'],
        [/מערה|מערת/, 'מערה'], [/אנדרטה|מצבת|אתר הנצחה/, 'אנדרטה'], [/מצפה|תצפית/, 'תצפית'],
        [/נחל|ואדי/, 'נחל'], [/חורבה|חורבת|תל |ארכאולוגי|מבצר|מצודה|עתיק/, 'אתר מורשת'],
      ];
      const feats = [];
      for (const pg of json.query?.pages || []) {
        const c = pg.coordinates && pg.coordinates[0];
        const desc = pg.description || '';
        if (!c || !pg.title || SKIP.test(desc)) continue;
        const rule = RULES.find(([re]) => re.test(desc) || re.test(pg.title));
        if (!rule) continue;
        feats.push({
          type: 'Feature',
          properties: { name: pg.title, type: rule[1], description: `${desc ? desc + '. ' : ''}מקור: ויקיפדיה.` },
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        });
      }
      const n = addFeaturesToDestinations(feats, 'wikipedia');
      renderMarkers();
      renderDestList();
      return n;
    })
    .catch((err) => {
      console.warn('Wikipedia load failed:', err);
      return 0;
    });

  Promise.allSettled([osmPromise, wikiPromise]).then((results) => {
    const total = results.reduce((a, r) => a + (r.status === 'fulfilled' ? r.value : 0), 0);
    const bothFailed = results.every((r) => r.status === 'rejected' || r.value === 0) && total === 0;
    if (bothFailed) {
      showStatus('לא הצלחתי לטעון יעדים חיים (אין אינטרנט או שהשרת עמוס). מוצגים היעדים המקומיים בלבד.', {
        error: true,
        onRetry: () => loadLiveDestinations(center),
      });
    } else {
      showStatus(`נטענו ${total} יעדים נוספים.`, { autoHideMs: 3000 });
    }
  });
}

/* =====================================================================================
   Markers + list rendering
   ===================================================================================== */
function matchesFilter(d) {
  if (activeCategory !== 'all' && d.type !== activeCategory) return false;
  if (searchText && !d.name.includes(searchText) && !d.type.includes(searchText)) return false;
  return true;
}

function emojiFor(type) {
  if (type === 'מעיין' || type === 'מפל' || type === 'נחל') return '💧';
  if (type === 'תצפית') return '🔭';
  if (type === 'אתר מורשת') return '🏛️';
  if (type === 'חניון לילה') return '⛺';
  if (type === 'פינת שהייה') return '🌳';
  if (type === 'מערה') return '🕳️';
  if (type === 'שמורת טבע') return '🌿';
  return '📍';
}

function renderMarkers() {
  const visible = new Set();
  for (const d of allDestinations) {
    if (!matchesFilter(d)) continue;
    visible.add(d.key);
    if (destMarkers.has(d.key)) continue;
    let layer;
    if (d.geometry.type === 'Point') {
      layer = L.marker([d.lat, d.lng]);
    } else if (d.geometry.type === 'LineString') {
      layer = L.polyline(d.geometry.coordinates.map((c) => [c[1], c[0]]), { color: '#ff7800', weight: 5, opacity: 0.75 });
    } else {
      continue;
    }
    layer.on('click', () => openLocationDetails(d));
    layer.addTo(map);
    destMarkers.set(d.key, layer);
  }
  for (const [key, layer] of destMarkers) {
    if (!visible.has(key)) {
      map.removeLayer(layer);
      destMarkers.delete(key);
    }
  }
}

function renderDestList() {
  const list = document.getElementById('dest-list');
  const countEl = document.getElementById('dest-count');
  const items = allDestinations
    .filter(matchesFilter)
    .map((d) => ({ ...d, distKm: userCoord ? haversineKm(userCoord, { lat: d.lat, lng: d.lng }) : null }))
    .sort((a, b) => (a.distKm ?? 1e9) - (b.distKm ?? 1e9));

  countEl.textContent = items.length ? `${items.length} יעדים` : '';
  list.innerHTML = '';

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = allDestinations.length === 0
      ? 'טוען יעדים…'
      : 'אין יעדים תואמים לסינון. נסה קטגוריה אחרת או נקה את החיפוש.';
    list.appendChild(li);
    return;
  }

  for (const d of items) {
    const li = document.createElement('li');
    li.className = 'dest-item';
    const distText = d.distKm != null ? `${d.distKm < 10 ? d.distKm.toFixed(1) : Math.round(d.distKm)} ק״מ אווירי` : '';
    li.innerHTML =
      `<div class="emoji">${emojiFor(d.type)}</div>` +
      `<div class="info"><div class="name"></div><div class="sub"></div></div>` +
      `<div class="dist"></div>`;
    li.querySelector('.name').textContent = d.name;
    li.querySelector('.sub').textContent = d.type;
    li.querySelector('.dist').textContent = distText;
    li.addEventListener('click', () => openLocationDetails(d));
    list.appendChild(li);
  }
}

function wireBrowseSheet() {
  const sheet = document.getElementById('browse-sheet');
  document.querySelector('.sheet-handle').addEventListener('click', () => sheet.classList.toggle('collapsed'));
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchText = e.target.value.trim();
    renderMarkers();
    renderDestList();
  });
  document.getElementById('category-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    activeCategory = btn.dataset.cat;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === btn));
    renderMarkers();
    renderDestList();
  });
}

/* =====================================================================================
   Details panel + navigation handoff (Waze)
   ===================================================================================== */
function openLocationDetails(d) {
  currentDestination = d;
  document.getElementById('loc-title').innerText = d.name;
  document.getElementById('loc-desc').innerText = d.description;
  document.getElementById('loc-type').innerText = d.type;
  const distEl = document.getElementById('loc-dist');
  if (userCoord) {
    const km = haversineKm(userCoord, { lat: d.lat, lng: d.lng });
    distEl.innerText = `${km < 10 ? km.toFixed(1) : Math.round(km)} ק״מ אווירי`;
    distEl.classList.remove('hidden');
  } else {
    distEl.classList.add('hidden');
  }
  document.getElementById('location-details').classList.remove('hidden');
  document.getElementById('browse-sheet').classList.add('collapsed');
  map.flyTo([d.lat, d.lng], 14);
  history.pushState({ isroadsDetail: true }, '');
}

function closeLocationDetails() {
  document.getElementById('location-details').classList.add('hidden');
  document.getElementById('browse-sheet').classList.remove('collapsed');
  currentDestination = null;
}

// phone/browser back closes the details panel instead of leaving the app
window.addEventListener('popstate', () => {
  if (!document.getElementById('location-details').classList.contains('hidden')) {
    closeLocationDetails();
  }
});

function startNavigation() {
  if (!currentDestination) return;
  const { lat, lng } = currentDestination;
  window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, '_blank');
}

/* הפעלה כשהעמוד נטען */
window.onload = initMap;
