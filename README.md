# ISROAD'S - Leaflet build (v11)

Small, dependency-light rewrite of the Leaflet prototype: fixes the "bounding-box center" navigation
bug, the silent-failure-on-missing-file bug, adds live destinations (OpenStreetMap + Hebrew Wikipedia),
a working PWA (offline shell + tiles, self-updating service worker), and a proper back-button flow.

## Files
- `index.html`, `style.css` - shell + UI (search, category chips, list, details panel, status banner)
- `geo.js` - pure geometry helpers (haversine, nearest-point-on-line, geometry dispatch, dedupe key).
             No DOM. Unit-tested directly with node.
- `app.js` - map, geolocation, data loading (seed + live OSM/Wikipedia), rendering, navigation handoff
- `trails.geojson` - small curated seed of verified real destinations (sources noted per item).
             The app adds more automatically from OpenStreetMap + Wikipedia around the user's GPS fix.
- `manifest.webmanifest`, `icon-*.png`, `favicon.png`, `sw.js` - PWA / offline support
- `tests/geo.test.js` - unit tests, run with: `node tests/geo.test.js`

## What changed from the uploaded version (and why)
1. **Line-trail navigation pointed at the wrong spot.** The old code used
   `layer.getBounds().getCenter()` for a trail (LineString) - the center of its bounding box, which for
   a bent trail can be a point that isn't on the trail at all. Fixed with `nearestPointOnLine()`: the
   point on the trail actually closest to the user (or its first point if there's no GPS fix yet).
   Verified with a synthetic L-shaped trail in `tests/geo.test.js` and with a real Waze-URL-capturing
   browser test.
2. **Missing/failed `trails.geojson` failed silently** (blank map, only a console error). Now shows a
   dismissible, retryable banner, and the app still works (live sources keep loading).
3. **Only 3 hardcoded destinations.** Replaced with: a small verified seed (this file) + live queries to
   OpenStreetMap (springs, waterfalls, viewpoints, camp/picnic sites, historic sites) and Hebrew
   Wikipedia (geosearch, filtered so settlements/institutions aren't shown). Two Overpass mirrors are
   raced with a hedge + hard timeout so a slow/dead server never hangs the UI - the previous project hit
   this exact failure mode and it's covered by a test here.
4. **No way back.** The existing close button still works; added `popstate` handling so the phone/browser
   back button closes the details panel instead of leaving the page (this was the recurring complaint
   in the bigger React build - the same fix, adapted to this simpler app).
5. **PWA scaffolding referenced but not shipped** (manifest, icons, `sw.js` were linked but missing).
   Now included. The service worker deliberately serves the app shell **network-first** and clears any
   older cache on activate, specifically to avoid the "still shows an old version" problem from earlier
   in this project.
6. **`user-scalable=no`** removed from the viewport meta tag (accessibility).
7. Distances are explicitly labeled "ק״מ אווירי" (straight-line) everywhere - this app hands off to Waze
   for the actual drive; it does not do in-app turn-by-turn navigation or road-then-track routing.

## Testing performed
- `node tests/geo.test.js`: 13/13 pass (haversine sanity, the bbox-center bug reproduced and fixed,
  geometry-type dispatch, dedupe stability).
- Headless-browser tests (Leaflet/GPS/Overpass/Wikipedia mocked): seed-then-live merge and sorting,
  missing-seed-file banner + retry, real Waze-URL correctness for a bent trail, back-button closing the
  panel, category/search filtering, and a stalled Overpass mirror not blocking the UI (hedged failover
  in ~3s). Also 3 rounds of randomized click/monkey testing (normal / no-network / no-GPS) with zero
  console errors.
- Not tested: the real Overpass/Wikipedia/Waze servers, and real device GPS.

## v12: live navigation added
Ported the navigation engine (position filtering, snap-to-line, status machine with hysteresis,
wrong-way detection, arrival) and simulator from the bigger React build into plain JS (`geo.js`),
plus real off-road track loading from OpenStreetMap with the same way-stitching logic (`geo.js` /
`drive.js`) - no invented geometry, only real `highway=track` ways joined at shared endpoints.

New in this round:
- **"שבילי שטח" tab**: lists real tracks around you (name if tagged, honestly flagged "ללא שם" if not),
  each with "התחל ניווט חי" (real GPS) and "הדמיית נסיעה" (simulate, with manual deviation and x1/x2/x4
  speed - useful for testing from the couch).
- **Drive screen**: one instruction line + a metrics strip (remaining distance, off-track meters, speed,
  stop button), hides the header/list the same way the bigger build's driving mode did.
- Phone/browser back button stops an active drive instead of leaving the page.

### Testing performed for v12
- `node tests/nav-engine.test.js`: 13/13 - on-track, deviation (~50m), returning (200m) vs. off_route
  (400m), wrong-way detection, arrival, weak-GPS handling, simulator determinism and x4 timing.
- `node tests/tracks.test.js`: 5/5 - way-stitching joins connected ways, a private way and a too-short
  way are correctly excluded, an unnamed track is flagged rather than given a fabricated name.
- Browser end-to-end (Leaflet/GPS/Overpass mocked): tracks tab lists a real mocked track; full
  simulation flow (on_track -> deviated -> banner color change -> x4 speed measurably faster);
  **real `watchPosition`-driven navigation** (moved the mocked device along the track via
  `context.setGeolocation`, confirmed progress and status); arrival auto-stops; back button stops an
  active drive. All passed with zero console errors.
- Not tested: real Overpass servers, real device GPS, real hairpin/fork trails in the field.

## Known scope
No automatic road-to-trailhead routing (drive to a point still hands off to Waze, now to the correct
point). The full road-then-track composite routing engine is the bigger, separately-built React/MapLibre
project (`shvilim-source.zip` from earlier in this conversation) - this Leaflet build now has its own,
independently-implemented live navigation, but not that road-routing piece.


## v13: fixed after real-world testing (junk tracks + broken off-route guidance)
Two concrete bugs reported after trying v12 in the field near Gedera:

1. **Irrelevant "trails".** The tracks list showed a short (~500m), asphalt-surfaced OSM
   `highway=track` fragment right next to a highway interchange - not a real 4x4 trail. Fixed:
   `buildTracksFromOverpass()` now excludes paved-surface tracks and anything under 600m, and lists
   named tracks (far more likely to be a real, known trail) before unnamed ones. Unnamed tracks are
   still available behind a "הצג גם X שבילים ללא שם" toggle - nothing real is hidden, just deprioritized.
   Covered by 3 new tests in `tests/tracks.test.js`, including the exact reported scenario (a short
   paved track near a highway) reproduced and confirmed excluded.

2. **Off-route guidance told you to follow a line that was never drawn.** When far from a trail, the
   instruction said "follow the dashed blue line on the map" - but no such line was ever rendered, only
   the trail itself (in orange). Fixed: `drive.js` now actually draws a dashed blue connector from your
   position to the nearest point on the trail whenever you're off-route, the instruction includes a
   compass direction ("לכיוון דרום-מזרח"), and a "Waze עד השביל" button appears as a fallback. Verified
   end-to-end: reproduced the exact scenario (1.1km from the trail) and confirmed the line is drawn, the
   text matches, and a Waze button appears.

Also fixed while investigating: starting live navigation now immediately uses the position already known
from the main GPS watcher instead of waiting for a second `watchPosition` round-trip, which had caused a
several-second delay before the first status appeared.

## v14: branding restored + full QA pass
- MEREISI GROUP credit restored: header ("מבית MEREISI GROUP"), sheet footer, manifest, meta author.
  Hidden only while driving (the drive screen stays clean). OSM/Wikipedia attribution now visible.
- QA fixes: category chips now cover every type (waterfalls/streams under water, memorials/caves
  under sites, picnic under camp, new "טבע" chip); same place from two sources shown once; "nothing
  nearby" no longer shown as a server error; OSM track names HTML-escaped; back button / close
  buttons keep browser history in sync; a trail is driven from the end nearest to you (before: starting
  at the far end declared "arrived" instantly); arrival stops the drive exactly once; off-route
  directions reworded so the compass direction is clearly the way BACK to the trail.
- Tested: 34 unit tests + browser QA at 390px (layout, branding, chips, dedupe, XSS, history,
  orientation, off-route line, arrival) + monkey tests, all passing. Not tested: real servers, real
  device GPS, real Leaflet rendering (a stub was used in automated tests).
