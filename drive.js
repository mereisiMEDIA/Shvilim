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

function renderTracksList() {
  const list = document.getElementById('tracks-list');
  const count = document.getElementById('tracks-count');
  count.textContent = realTracks.length ? `${realTracks.length} שבילים נמצאו` : '';
  list.innerHTML = '';
  if (!realTracks.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = userCoord ? 'לא נמצאו שבילי עפר מסומנים ב-OpenStreetMap קרוב אליך.' : 'ממתין למיקום GPS כדי לחפש שבילים קרובים…';
    list.appendChild(li);
    return;
  }
  for (const t of realTracks) {
    const li = document.createElement('li');
    li.className = 'dest-item track-item';
    const nearText = t.nearestM != null ? (t.nearestM < 950 ? Math.round(t.nearestM) + ' מ׳' : (t.nearestM / 1000).toFixed(1) + ' ק״מ') + ' ממך' : '';
    li.innerHTML =
      `<div class="row1">` +
      `<div class="emoji">🛞</div>` +
      `<div class="info"><div class="name ${t.unnamed ? 'unnamed' : ''}">${t.name || 'דרך עפר ללא שם'}</div>` +
      `<div class="sub">${t.distanceKm} ק״מ${nearText ? ' · השביל מתחיל ' + nearText : ''}</div></div>` +
      `</div>` +
      `<div class="track-actions">` +
      `<button class="track-btn primary" data-act="live">🧭 התחל ניווט חי</button>` +
      `<button class="track-btn secondary" data-act="sim">▶ הדמיית נסיעה</button>` +
      `</div>`;
    li.querySelector('[data-act="live"]').addEventListener('click', () => startDrive(t, false));
    li.querySelector('[data-act="sim"]').addEventListener('click', () => startDrive(t, true));
    list.appendChild(li);
  }
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
function startDrive(track, sim) {
  simMode = sim;
  driveTrack = track;
  driveEngine = new NavEngine(track.coordinates);
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
      if (!f) { stopDrive(); return; }
      applyDriveFix(f);
    }, 1000);
  } else {
    if (!navigator.geolocation) { showStatus('הדפדפן לא תומך ב-GPS.', { error: true }); stopDrive(); return; }
    driveWatchId = navigator.geolocation.watchPosition(
      (pos) => applyDriveFix({
        lng: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy,
        speedKmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : null,
        heading: pos.coords.heading != null ? pos.coords.heading : null, ts: pos.timestamp || Date.now(),
      }),
      (err) => { if (err.code === 1) { showStatus('הרשאת מיקום נדרשת לניווט חי.', { error: true }); stopDrive(); } },
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
  }
  history.pushState({ isroadsDrive: true }, '');
}

function applyDriveFix(fix) {
  if (!driveEngine) return;
  const s = driveEngine.update(fix);
  driveMarker.setLatLng([s.display[1], s.display[0]]);
  map.panTo([s.display[1], s.display[0]]);
  renderDriveHud(s);
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
  if (s.status === 'arrived') setTimeout(stopDrive, 3000);
}

function stopDrive() {
  if (driveTickTimer) clearInterval(driveTickTimer);
  if (driveWatchId != null && navigator.geolocation) navigator.geolocation.clearWatch(driveWatchId);
  driveTickTimer = null; driveWatchId = null; driveEngine = null; driveSim = null;
  if (driveLine) { map.removeLayer(driveLine); driveLine = null; }
  if (driveMarker) { map.removeLayer(driveMarker); driveMarker = null; }
  document.body.classList.remove('driving');
  document.getElementById('drive-screen').classList.add('hidden');
}

function wireDriveControls() {
  document.getElementById('btn-stop-drive').addEventListener('click', () => { stopDrive(); history.back(); });
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
  if (driveEngine || driveSim) stopDrive();
});

document.addEventListener('DOMContentLoaded', () => {
  wireTabs();
  wireDriveControls();
});
