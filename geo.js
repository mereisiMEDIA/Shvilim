'use strict';
/* Pure geometry helpers - no DOM, unit-tested directly with node. */

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * For a destination that is a LINE (a trail), the right point to hand to Waze is the point
 * on the line closest to the user - NOT the geometric center of its bounding box, which for a
 * bent trail can land in empty space far from the trail itself.
 * coords: array of [lng, lat] (GeoJSON order). from: {lat, lng} or null.
 * Returns {lat, lng}.
 */
function nearestPointOnLine(coords, from) {
  if (!coords || coords.length === 0) return null;
  if (coords.length === 1 || !from) {
    const [lng, lat] = coords[0];
    return { lat, lng };
  }
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = { lat: coords[i][1], lng: coords[i][0] };
    const b = { lat: coords[i + 1][1], lng: coords[i + 1][0] };
    // local flat projection (good enough at trail scale)
    const kx = Math.cos((from.lat * Math.PI) / 180);
    const ax = (a.lng - from.lng) * kx, ay = a.lat - from.lat;
    const bx = (b.lng - from.lng) * kx, by = b.lat - from.lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.hypot(px, py);
    if (d < bestDist) {
      bestDist = d;
      best = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
  }
  return best;
}

/** Extracts {lat,lng} for ANY GeoJSON geometry type, using the real geometry, not a bbox guess. */
function navPointForGeometry(geometry, from) {
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates;
    return { lat, lng };
  }
  if (geometry.type === 'LineString') {
    return nearestPointOnLine(geometry.coordinates, from);
  }
  if (geometry.type === 'Polygon') {
    return nearestPointOnLine(geometry.coordinates[0], from);
  }
  if (geometry.type === 'MultiLineString') {
    let best = null, bestDist = Infinity;
    for (const line of geometry.coordinates) {
      const p = nearestPointOnLine(line, from);
      if (!p) continue;
      const d = from ? haversineKm(from, p) : 0;
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }
  return null;
}

function dedupeKey(name, coord) {
  return `${name.trim()}@${coord.lat.toFixed(3)},${coord.lng.toFixed(3)}`;
}


if (typeof module !== 'undefined') {
  module.exports = { haversineKm, nearestPointOnLine, navPointForGeometry, dedupeKey };
}

/* =====================================================================================
   Live navigation on a real trail line: GPS filtering, snap-to-line, status machine,
   turn-by-turn-style instructions. Ported from the tested engine used in the full build
   (src/engine/navigator.ts) into plain JS so this app can use it directly.
   ===================================================================================== */

function makeLine(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm({ lat: coords[i - 1][1], lng: coords[i - 1][0] }, { lat: coords[i][1], lng: coords[i][0] }) * 1000);
  return { coords, cum, total: cum[cum.length - 1] };
}

function pointAlongLine(line, d) {
  const { coords, cum, total } = line;
  d = Math.max(0, Math.min(total, d));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= d) lo = m; else hi = m;
  }
  const seg = cum[lo + 1] - cum[lo];
  const t = seg > 0 ? (d - cum[lo]) / seg : 0;
  return [coords[lo][0] + (coords[lo + 1][0] - coords[lo][0]) * t, coords[lo][1] + (coords[lo + 1][1] - coords[lo][1]) * t];
}

function bearingLngLat(a, b) {
  // a, b: [lng, lat]
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function lineBearingAt(line, d, span) {
  span = span || 15;
  const a = pointAlongLine(line, Math.max(0, d - span));
  const b = pointAlongLine(line, Math.min(line.total, d + span));
  const distKm = haversineKm({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });
  if (distKm * 1000 > 0.5) return bearingLngLat(a, b);
  return bearingLngLat(line.coords[0], line.coords[line.coords.length - 1]);
}

function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/** nearest point on the line (optionally restricted to a distance window), in meters */
function projectOnLine(line, p /* {lat,lng} */, fromM, toM) {
  fromM = fromM || 0;
  toM = toM === undefined ? Infinity : toM;
  const coords = line.coords, cum = line.cum;
  let best = null;
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111320, ky = 110540;
  for (let i = 0; i < coords.length - 1; i++) {
    if (cum[i + 1] < fromM || cum[i] > toM) continue;
    const a = coords[i], b = coords[i + 1];
    const ax = (a[0] - p.lng) * kx, ay = (a[1] - p.lat) * ky;
    const bx = (b[0] - p.lng) * kx, by = (b[1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dist = Math.hypot(ax + dx * t, ay + dy * t);
    if (!best || dist < best.dist) {
      const seg = cum[i + 1] - cum[i];
      best = { dist, along: cum[i] + seg * t, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
    }
  }
  if (best && (best.along < fromM || best.along > toM)) best.along = Math.max(fromM, Math.min(toM, best.along));
  return best;
}

const NAV_DEFAULTS = {
  minSnapM: 25, maxSnapM: 80, accuracyFactor: 1.2, returnFactor: 0.7,
  returningMaxM: 250, weakGpsM: 120, maxBackM: 40, reverseFixes: 3, worsenFixes: 2,
};

/**
 * Live route-following engine.
 * new NavEngine(coordsLngLat)  then  engine.update(fix)  where fix = {lat,lng,accuracy,speedKmh,heading,ts}
 * Returns a NavState: { status, alongM, distRemainingM, progressPct, offTrackM, display:[lng,lat],
 *                        bearingForward, travelBearing, wrongWay, speedKmh, instruction:{kind,text} }
 * status: 'on_track' | 'deviated' | 'returning' | 'off_route' | 'wrong_way' | 'arrived' | 'no_fix'
 */
function NavEngine(coords, options) {
  this.line = makeLine(coords);
  this.opt = Object.assign({}, NAV_DEFAULTS, options || {});
  this.along = null;
  this.status = 'on_track';
  this.worse = 0;
  this.reverse = 0;
  this.forward = 0;
  this.wrongWay = false;
  this.arrived = false;
  this.lastPos = null; // for a simple travel-bearing fallback when heading is absent
  this.speedEma = 0;
}

NavEngine.prototype.total = function () { return this.line.total; };

NavEngine.prototype._nextStatus = function (off, R, D) {
  const opt = this.opt;
  const cur = ['off_route', 'returning', 'deviated'].includes(this.status) ? this.status : 'on_track';
  const R_MAX = opt.returningMaxM;
  let target = cur;
  if (cur === 'off_route' && off < R_MAX * 0.8) target = 'returning';
  if ((target === 'returning' || cur === 'returning') && off < D * 0.85) target = 'deviated';
  if ((target === 'deviated' || cur === 'deviated') && off < R * opt.returnFactor) target = 'on_track';
  if (target !== cur) { this.worse = 0; return target; }
  let worse = null, big = false;
  if (cur === 'on_track' && off > R) { worse = off > D ? (off > R_MAX ? 'off_route' : 'returning') : 'deviated'; big = off > R * 2; }
  else if (cur === 'deviated' && off > D) { worse = off > R_MAX ? 'off_route' : 'returning'; big = off > D * 1.5; }
  else if (cur === 'returning' && off > R_MAX) { worse = 'off_route'; big = off > R_MAX * 1.4; }
  if (!worse) { this.worse = 0; return cur; }
  this.worse++;
  if (big || this.worse >= opt.worsenFixes) { this.worse = 0; return worse; }
  return cur;
};

NavEngine.prototype.update = function (fix) {
  const opt = this.opt;
  if (!fix.accuracy || fix.accuracy > opt.weakGpsM) {
    return this._weak(fix);
  }
  const pos = { lat: fix.lat, lng: fix.lng };
  const speedMs = fix.speedKmh != null ? fix.speedKmh / 3.6 : this.lastPos ? haversineKm(this.lastPos, pos) * 1000 / Math.max(1, (fix.ts - (this.lastTs || fix.ts)) / 1000) : 0;
  this.speedEma = this.speedEma === 0 ? speedMs : this.speedEma * 0.6 + speedMs * 0.4;
  const speedKmh = Math.round(this.speedEma * 3.6 * 10) / 10;

  const acc = fix.accuracy;
  const R = Math.max(opt.minSnapM, Math.min(opt.maxSnapM, acc * opt.accuracyFactor));
  const D = Math.max(80, R * 2.5);

  const prev = this.along;
  let proj;
  if (prev == null) {
    proj = projectOnLine(this.line, pos);
  } else {
    const back = this.wrongWay ? 250 : opt.maxBackM + acc;
    const fwd = Math.max(800, speedMs * 15);
    const w = projectOnLine(this.line, pos, prev - back, prev + fwd);
    const g = this.line.total > 1200 ? projectOnLine(this.line, pos) : w;
    proj = w && (!g || w.dist <= g.dist + 30) ? w : g;
  }
  if (!proj) return this._weak(fix);

  let along = proj.along;
  if (prev != null && !this.wrongWay && along < prev - opt.maxBackM) along = prev - opt.maxBackM;
  along = Math.max(0, Math.min(this.line.total, along));
  const off = proj.dist;
  const fwdBearing = lineBearingAt(this.line, along);

  // travel bearing: GPS heading when moving fast enough, else derived from the last fix
  let travel = null;
  if (fix.heading != null && speedMs * 3.6 > 3) travel = fix.heading;
  else if (this.lastPos) {
    const d = haversineKm(this.lastPos, pos) * 1000;
    if (d >= 8) travel = bearingLngLat([this.lastPos.lng, this.lastPos.lat], [pos.lng, pos.lat]);
  }
  if (travel != null && speedMs * 3.6 > 3 && off <= D) {
    const diff = Math.abs(angleDiff(travel, fwdBearing));
    if (diff > 120) { this.reverse++; this.forward = 0; }
    else if (diff < 60) { this.forward++; this.reverse = 0; }
    if (!this.wrongWay && this.reverse >= opt.reverseFixes) this.wrongWay = true;
    if (this.wrongWay && this.forward >= 2) this.wrongWay = false;
  }

  this.status = this._nextStatus(off, R, D);
  this.along = this.status === 'off_route' ? (this.along != null ? this.along : along) : along;
  this.lastPos = pos;
  this.lastTs = fix.ts;

  const remaining = Math.max(0, this.line.total - along);
  if (!this.arrived && remaining <= 25 && off <= D) this.arrived = true;

  const snapped = this.status === 'off_route' ? null : proj.point;
  const display = this.status === 'on_track' && snapped ? snapped : [pos.lng, pos.lat];
  const finalStatus = this.arrived ? 'arrived' : (this.wrongWay && this.status !== 'off_route' ? 'wrong_way' : this.status);

  const state = {
    status: finalStatus,
    display: display,
    offTrackM: Math.round(off),
    alongM: Math.round(along),
    distRemainingM: Math.round(remaining),
    progressPct: this.line.total > 0 ? Math.min(100, (along / this.line.total) * 100) : 0,
    bearingForward: Math.round(fwdBearing),
    travelBearing: travel == null ? null : Math.round(travel),
    wrongWay: this.wrongWay,
    snapRadiusM: Math.round(R),
    accuracyM: Math.round(acc),
    speedKmh: speedKmh,
  };
  state.instruction = this._instruct(state);
  this.lastState = state;
  return state;
};

NavEngine.prototype._instruct = function (s) {
  if (s.status === 'arrived') return { kind: 'arrive', text: 'הגעת ליעד! כל הכבוד' };
  if (s.status === 'wrong_way') return { kind: 'wrong_way', text: 'נסיעה בכיוון הפוך לשביל — פנה פרסה' };
  if (s.status === 'off_route') {
    const km = s.offTrackM >= 950 ? (s.offTrackM / 1000).toFixed(1) + ' ק״מ' : Math.round(s.offTrackM / 10) * 10 + ' מ׳';
    return { kind: 'off_route', text: 'רחוק ' + km + ' מהשביל — חזור לקו הכחול במפה' };
  }
  if (s.status === 'returning') return { kind: 'return', text: 'סטית ' + s.offTrackM + ' מ׳ מהשביל — חזור לקו' };
  if (s.status === 'deviated') return { kind: 'correct', text: 'סטייה קלה: ' + s.offTrackM + ' מ׳ מהשביל' };
  return { kind: 'stay', text: 'הישאר על הקו' };
};

NavEngine.prototype._weak = function (fix) {
  const base = this.lastState || {
    status: 'no_fix', display: [fix.lng, fix.lat], offTrackM: 0, alongM: 0,
    distRemainingM: Math.round(this.line.total), progressPct: 0, bearingForward: 0,
    travelBearing: null, wrongWay: false, snapRadiusM: this.opt.maxSnapM, speedKmh: 0,
  };
  return Object.assign({}, base, {
    status: 'no_fix',
    accuracyM: Math.round(fix.accuracy || 999),
    instruction: { kind: 'weak_gps', text: 'אות GPS חלש (±' + Math.round(fix.accuracy || 0) + ' מ׳)' },
  });
};

/* =====================================================================================
   Simulator: feeds the SAME kind of fixes a phone would, for testing without being outside.
   ===================================================================================== */
function makeSeededRandom(seed) {
  let s = seed >>> 0 || 1;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function NavSimulator(coords, opts) {
  opts = opts || {};
  this.line = makeLine(coords);
  this.along = 0;
  this.offsetM = 0;
  this.multiplier = opts.multiplier || 1;
  this.baseKmh = opts.baseKmh || 25;
  this.t = 0;
  this.ts = opts.startTs || Date.now();
  this.rand = makeSeededRandom(opts.seed || 7);
}
NavSimulator.prototype.finished = function () { return this.along >= this.line.total - 0.5; };
NavSimulator.prototype.setOffset = function (m) { this.offsetM = m; };
NavSimulator.prototype.setMultiplier = function (m) { this.multiplier = m; };
NavSimulator.prototype._gauss = function () {
  const u = Math.max(1e-9, this.rand()), v = this.rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
NavSimulator.prototype.step = function (dtSec) {
  dtSec = dtSec || 1;
  if (this.finished()) return null;
  this.t += dtSec;
  const kmh = this.baseKmh * (0.85 + 0.3 * Math.sin(this.t / 6) * Math.cos(this.t / 17) + 0.05 * this._gauss());
  const v = Math.max(3, kmh) / 3.6;
  this.along = Math.min(this.line.total, this.along + v * dtSec * this.multiplier);
  this.ts += dtSec * 1000;
  const fwd = lineBearingAt(this.line, this.along);
  let p = pointAlongLine(this.line, this.along);
  if (this.offsetM) {
    const brg = (fwd + (this.offsetM > 0 ? 90 : -90) + 360) % 360;
    p = destinationLngLat(p, Math.abs(this.offsetM), brg);
  }
  return { lng: p[0], lat: p[1], accuracy: 8, speedKmh: Math.max(3, kmh) * this.multiplier, heading: fwd, ts: this.ts };
};
function destinationLngLat(p, distM, brgDeg) {
  const R = 6371008.8, rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const d = distM / R, br = rad(brgDeg), lat1 = rad(p[1]), lng1 = rad(p[0]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [deg(lng2), deg(lat2)];
}

if (typeof module !== 'undefined') {
  module.exports.makeLine = makeLine;
  module.exports.pointAlongLine = pointAlongLine;
  module.exports.projectOnLine = projectOnLine;
  module.exports.NavEngine = NavEngine;
  module.exports.NavSimulator = NavSimulator;
}

/* =====================================================================================
   Real off-road tracks from OpenStreetMap: stitches adjacent `highway=track` ways into
   continuous lines wherever exactly two ways meet at a point (a real junction of 3+ stays
   split - we never invent a connection). No fabricated geometry, ever.
   ===================================================================================== */
function ptKey(p) { return p[0].toFixed(6) + ',' + p[1].toFixed(6); }

function stitchTrackWays(ways) {
  const endMap = new Map();
  ways.forEach((w, i) => {
    [w.pts[0], w.pts[w.pts.length - 1]].forEach((p) => {
      const k = ptKey(p);
      if (!endMap.has(k)) endMap.set(k, new Set());
      endMap.get(k).add(i);
    });
  });
  const used = new Array(ways.length).fill(false);
  const nextAt = (k, cur) => {
    const at = endMap.get(k);
    if (!at || at.size !== 2) return -1;
    let other = -1;
    at.forEach((j) => { if (j !== cur) other = j; });
    return other < 0 || used[other] ? -1 : other;
  };
  const chains = [];
  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let pts = ways[i].pts.slice();
    const members = [ways[i]];
    let last = i;
    for (let g = 0; g < 2000; g++) {
      const ek = ptKey(pts[pts.length - 1]);
      const n = nextAt(ek, last);
      if (n < 0) break;
      used[n] = true;
      let wp = ways[n].pts;
      if (ptKey(wp[0]) !== ek) wp = wp.slice().reverse();
      pts = pts.concat(wp.slice(1));
      members.push(ways[n]);
      last = n;
    }
    let first = i;
    for (let g = 0; g < 2000; g++) {
      const sk = ptKey(pts[0]);
      const n = nextAt(sk, first);
      if (n < 0) break;
      used[n] = true;
      let wp = ways[n].pts;
      if (ptKey(wp[wp.length - 1]) !== sk) wp = wp.slice().reverse();
      pts = wp.slice(0, -1).concat(pts);
      members.unshift(ways[n]);
      first = n;
    }
    chains.push({ pts, members });
  }
  return chains;
}

/** Overpass JSON (way elements with tags+geometry) -> real, stitched trail objects. Min length 300m. */
function buildTracksFromOverpass(json, center) {
  const ways = [];
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    if (tags.access === 'no' || tags.access === 'private' || tags.motor_vehicle === 'no') continue;
    ways.push({ id: el.id, tags, pts: el.geometry.map((g) => [g.lon, g.lat]) });
  }
  const chains = stitchTrackWays(ways);
  const out = [];
  chains.forEach((chain, idx) => {
    const line = makeLine(chain.pts);
    if (line.total < 300) return;
    const named = chain.members.find((m) => m.tags['name:he'] || m.tags.name);
    const rawName = named ? named.tags['name:he'] || named.tags.name : '';
    const km = Math.round((line.total / 100)) / 10;
    out.push({
      id: 'track-' + chain.members[0].id + '-' + idx,
      name: rawName || null,
      unnamed: !rawName,
      distanceKm: km,
      coordinates: chain.pts,
      nearestM: center ? projectOnLine(line, center).dist : null,
    });
  });
  out.sort((a, b) => (a.nearestM || 0) - (b.nearestM || 0));
  return out;
}

if (typeof module !== 'undefined') {
  module.exports.stitchTrackWays = stitchTrackWays;
  module.exports.buildTracksFromOverpass = buildTracksFromOverpass;
}
