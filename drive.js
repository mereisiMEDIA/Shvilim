'use strict';
/* Live navigation on real OSM trails: loads tracks around the user, lists them, and runs
 * live GPS or a simulator through the SAME NavEngine (geo.js), rendering position + status
 * on the map and in the drive screen. Uses overpassQuery() and showStatus() from app.js. */

let realTracks = [];
let driveEngine = null;
let driveSim = null;
let driveTrack = null;
let driveLine = null;      // Leaflet polyline of the trail
let driveMarker = null;    // Leaflet marker for the live position
let driveWatchId = null;
let driveTickTimer = null;
let simMode = false;

/* ---------- loading real tracks ---------- */
function loadNearbyTracks(center) {
  const radius = 12000;
  const around = `(around:${radius},${center.lat},${center.lng})`;
  const query = `[out:json][timeout:20];way["highway"="track"]${around};out geom;`;
  document.getElementById('tracks-count').textContent = 'טוען שבילים…';
  overpassQuery(query)
    .then((json) => {
      realTracks = buildTracksFromOverpass(json, center).slice(0, 30);
      renderTracksList();
    })
    .catch((err) => {
      console.warn('Track load failed:', err);
      document.getElementById('tracks-count').textContent = '';
      document.getElementById('tracks-list').innerHTML =
        '<li class="empty-note">לא הצלחתי לטעון שבילים (אין אינטרנט או שהשרת עמוס). <button id="retry-tracks" class="status-retry">נסה שוב</button></li>';
      const btn = document.getElementById('retry-tracks');
      if (btn) btn.addEventListener('click', () => loadNearbyTracks(center));
    });
}

let showUnnamedTracks = false;

function renderTracksList() {
  const list = document.getElementById('tracks-list');
  const count = document.getElementById('tracks-count');
  const named = realTracks.filter((t) => !t.unnamed);
  const unnamed = realTracks.filter((t) => t.unnamed);
  const shown = showUnnamedTracks ? realTracks : named;

  count.textContent = realTracks.length ? `${realTracks.length} שבילים נמצאו` : '';
  list.innerHTML = '';
  if (!realTracks.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = userCoord ? 'לא נמצאו שבילי עפר מסומנים ב-OpenStreetMap קרוב אליך.' : 'ממתין למיקום GPS כדי לחפש שבילים קרובים…';
    list.appendChild(li);
    return;
  }
  if (shown.length === 0 && named.length === 0) {
    const note = document.createElement('li');
    note.className = 'empty-note';
    note.textContent = 'נמצאו רק שבילים ללא שם באזור הזה.';
    list.appendChild(note);
  }
  for (const t of shown) appendTrackItem(list, t);
  if (!showUnnamedTracks && unnamed.length > 0) {
    const btnLi = document.createElement('li');
    btnLi.innerHTML = `<button id="toggle-unnamed" class="track-btn secondary" style="width:100%">הצג גם ${unnamed.length} שבילים ללא שם</button>`;
    btnLi.querySelector('button').addEventListener('click', () => { showUnnamedTracks = true; renderTracksList(); });
    list.appendChild(btnLi);
  }
}

function appendTrackItem(list, t) {
  const li = document.createElement('li');
  li.className = 'dest-item track-item';
  const nearText = t.nearestM != null ? (t.nearestM < 950 ? Math.round(t.nearestM) + ' מ׳' : (t.nearestM / 1000).toFixed(1) + ' ק״מ') + ' ממך' : '';
  li.innerHTML =
    `<div class="row1">` +
    `<div class="emoji">🛞</div>` +
    `<div class="info"><div class="name ${t.unnamed ? 'unnamed' : ''}">${escapeHtml(t.name || 'דרך עפר ללא שם')}</div>` +
    `<div class="sub">${t.distanceKm} ק״מ${nearText ? ' · הנקודה הקרובה בשביל: ' + nearText : ''}</div></div>` +
    `</div>` +
    `<div class="track-actions">` +
    `<button class="track-btn primary" data-act="live">🧭 התחל ניווט חי</button>` +
    `<button class="track-btn secondary" data-act="sim">▶ הדמיית נסיעה</button>` +
    `</div>`;
  li.querySelector('[data-act="live"]').addEventListener('click', () => startDrive(t, false));
  li.querySelector('[data-act="sim"]').addEventListener('click', () => startDrive(t, true));
  list.appendChild(li);
}

/* ---------- tabs ---------- */
function wireTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      document.getElementById('dest-tab').classList.toggle('hidden', tab !== 'dest');
      document.getElementById('tracks-tab').classList.toggle('hidden', tab !== 'tracks');
      if (tab === 'tracks' && realTracks.length === 0 && userCoord) loadNearbyTracks(userCoord);
    });
  });
}

/* ---------- starting / stopping a drive ---------- */
/* A trail has no built-in direction. Drive it from the end nearest to where you are now,
 * otherwise starting at the "far" end would immediately be flagged as wrong-way driving. */
function orientTrack(coords, from) {
  if (!from || coords.length < 2) return coords;
  const first = { lat: coords[0][1], lng: coords[0][0] };
  const last = { lat: coords[coords.length - 1][1], lng: coords[coords.length - 1][0] };
  return haversineKm(from, last) < haversineKm(from, first) ? coords.slice().reverse() : coords;
}

let driveHistoryPushed = false;
let driveStopping = false;

function startDrive(track, sim) {
  simMode = sim;
  driveStopping = false;
  const coords = sim ? track.coordinates : orientTrack(track.coordinates, userCoord);
  driveTrack = Object.assign({}, track, { coordinates: coords });
  track = driveTrack;
  driveEngine = new NavEngine(track.coordinates);
  if (userMarker) userMarker.setOpacity && userMarker.setOpacity(0); // one position marker while driving
  document.body.classList.add('driving');
  document.getElementById('drive-screen').classList.remove('hidden');
  document.getElementById('sim-controls').classList.toggle('hidden', !sim);

  driveLine = L.polyline(track.coordinates.map((c) => [c[1], c[0]]), { color: '#f5a524', weight: 4, opacity: 0.85 }).addTo(map);
  driveMarker = L.marker([track.coordinates[0][1], track.coordinates[0][0]], {
    icon: L.divIcon({ className: '', html: '<div class="user-dot" style="background:#f5a524"></div>', iconSize: [18, 18] }),
  }).addTo(map);

  if (sim) {
    driveSim = new NavSimulator(track.coordinates, { baseKmh: 25 });
    map.setView([track.coordinates[0][1], track.coordinates[0][0]], 15);
    driveTickTimer = setInterval(() => {
      const f = driveSim.step(1);
      if (!f) { if (!driveStopping) { driveStopping = true; setTimeout(endDrive, 3000); } clearInterval(driveTickTimer); driveTickTimer = null; return; }
      applyDriveFix(f);
    }, 1000);
  } else {
    if (!navigator.geolocation) { showStatus('הדפדפן לא תומך ב-GPS.', { error: true }); stopDrive(); return; }
    // We already have a live position from the main GPS watcher (app.js) - use it immediately
    // instead of waiting for this new watcher's first callback, which can lag by a few seconds.
    if (userCoord) applyDriveFix({ lng: userCoord.lng, lat: userCoord.lat, accuracy: lastKnownAccuracy || 20, speedKmh: null, heading: null, ts: Date.now() });
    driveWatchId = navigator.geolocation.watchPosition(
      (pos) => applyDriveFix({
        lng: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy,
        speedKmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : null,
        heading: pos.coords.heading != null ? pos.coords.heading : null, ts: pos.timestamp || Date.now(),
      }),
      (err) => { if (err.code === 1) { showStatus('הרשאת מיקום נדרשת לניווט חי.', { error: true }); endDrive(); } },
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
  }
  if (!driveHistoryPushed) {
    history.pushState({ isroadsDrive: true }, '');
    driveHistoryPushed = true;
  }
}

function applyDriveFix(fix) {
  if (!driveEngine) return;
  const s = driveEngine.update(fix);
  driveMarker.setLatLng([s.display[1], s.display[0]]);
  map.panTo([s.display[1], s.display[0]]);
  updateAccessLine(s);
  renderDriveHud(s);
}

/* Dashed BLUE line from the current position back to the nearest point on the trail - drawn
 * whenever you are far enough that the instruction text tells you to "follow the dashed line".
 * Without this the earlier version told people to follow a line that was never actually drawn. */
let accessLine = null;
function updateAccessLine(s) {
  const needed = s.status === 'off_route' || s.status === 'returning';
  if (!needed) {
    if (accessLine) { map.removeLayer(accessLine); accessLine = null; }
    return;
  }
  const latlngs = [[s.display[1], s.display[0]], [s.nearestOnLine[1], s.nearestOnLine[0]]];
  if (!accessLine) {
    accessLine = L.polyline(latlngs, { color: '#3b82f6', weight: 4, dashArray: '2 10', opacity: 0.9 }).addTo(map);
  } else {
    accessLine.setLatLngs(latlngs);
  }
}

const TONE = { on_track: '', deviated: 'tone-warn', returning: 'tone-bad', off_route: 'tone-bad', wrong_way: 'tone-bad', arrived: '', no_fix: 'tone-warn' };
const ICON = { on_track: '↑', deviated: '⚠', returning: '↩', off_route: '✕', wrong_way: '↩', arrived: '🏁', no_fix: '…' };
function renderDriveHud(s) {
  const banner = document.getElementById('drive-banner');
  banner.className = 'drive-banner ' + (TONE[s.status] || '');
  document.getElementById('drive-icon').textContent = ICON[s.status] || '↑';
  document.getElementById('drive-instruction').textContent = s.instruction.text;
  document.getElementById('drive-sub').textContent = driveTrack.name || 'דרך עפר ללא שם';
  document.getElementById('m-remain').textContent = s.distRemainingM < 950 ? Math.round(s.distRemainingM) + ' מ׳' : (s.distRemainingM / 1000).toFixed(1) + ' ק״מ';
  document.getElementById('m-off').textContent = s.offTrackM;
  document.getElementById('m-speed').textContent = Math.round(s.speedKmh);

  // far off-route: offer a quick escape hatch to real turn-by-turn driving directions
  const wazeBtn = document.getElementById('btn-waze-to-track');
  if (s.status === 'off_route' || s.status === 'returning') {
    wazeBtn.classList.remove('hidden');
    wazeBtn.onclick = () => window.open(`https://waze.com/ul?ll=${s.nearestOnLine[1]},${s.nearestOnLine[0]}&navigate=yes`, '_blank');
  } else {
    wazeBtn.classList.add('hidden');
  }
  if (s.status === 'arrived' && !driveStopping) {
    driveStopping = true;
    setTimeout(endDrive, 3000);
  }
}

// user-initiated end (button / arrival): stop AND consume our history entry
function endDrive() {
  stopDrive();
  if (driveHistoryPushed) {
    driveHistoryPushed = false;
    history.back();
  }
}

function stopDrive() {
  if (userMarker && userMarker.setOpacity) userMarker.setOpacity(1);
  if (driveTickTimer) clearInterval(driveTickTimer);
  if (driveWatchId != null && navigator.geolocation) navigator.geolocation.clearWatch(driveWatchId);
  driveTickTimer = null; driveWatchId = null; driveEngine = null; driveSim = null;
  if (driveLine) { map.removeLayer(driveLine); driveLine = null; }
  if (driveMarker) { map.removeLayer(driveMarker); driveMarker = null; }
  if (accessLine) { map.removeLayer(accessLine); accessLine = null; }
  document.body.classList.remove('driving');
  document.getElementById('drive-screen').classList.add('hidden');
}

function wireDriveControls() {
  document.getElementById('btn-stop-drive').addEventListener('click', endDrive);
  document.getElementById('sim-controls').addEventListener('click', (e) => {
    const off = e.target.closest('.sim-btn');
    if (off && driveSim) {
      driveSim.setOffset(Number(off.dataset.offset));
      document.querySelectorAll('.sim-btn').forEach((b) => b.classList.toggle('active', b === off));
    }
    const spd = e.target.closest('.sim-speed');
    if (spd && driveSim) {
      driveSim.setMultiplier(Number(spd.dataset.mult));
      document.querySelectorAll('.sim-speed').forEach((b) => b.classList.toggle('active', b === spd));
    }
  });
}

// back button during a drive stops it instead of leaving the app
window.addEventListener('popstate', () => {
  if (driveHistoryPushed) {
    driveHistoryPushed = false;
    stopDrive();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  wireTabs();
  wireDriveControls();
});
