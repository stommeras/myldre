# Myldre plan

A tilted 3D night map of Norway with live public transport vehicles moving on real terrain. Data comes from the Entur Vehicle Positions API. Terms are defined in [GLOSSARY.md](GLOSSARY.md). Measurements behind the data and rendering decisions are in [SPIKES.md](SPIKES.md).

## Settled decisions

- Look: blue-black base with water, faint roads and city names only. Vehicles are glowing dots with fading trails, colored by mode and drawn with additive blending, so moving things are the only light on the map. Standing vehicles dim. Close up, dots crossfade to low-poly, flat-shaded models scaled up about 3x.
- Replay: the main view plays recorded history sped up, with speed toggles (1x, 10x, 30x, 60x, 120x). The live feed is too sparse to look busy at 1x. The swarm prototype settled this (branch `prototype/swarm`, 2026-11-03): all of Norway at 60x and a tilted city view at 30x both looked busy, and the street-level live view did not.
- Frontend: SolidJS + Vite + TypeScript SPA. Map and deck.gl state live outside Solid's reactivity.
- Map: MapLibre GL JS 6, OpenFreeMap base tiles with a dark style, AWS Terrarium terrain with 1.5x exaggeration (tunable).
- Camera: the map opens on all of Norway, flat, at about zoom 4.7. Zooming into a city gives the tilted view. The shape glide only shows from about zoom 15 up (SPIKES.md, route-shape glide), but rail needs shapes when zoomed out too: the prototype's straight lines between sparse train reports cut visibly across terrain.
- Vehicles: deck.gl `ScenegraphLayer`, mounted via `MapLibreOverlay` from `@deck.gl/maplibre` in interleaved mode, drawn above the basemap labels. Each vehicle's z comes from `map.queryTerrainElevation()`, because `TerrainExtension` doesn't read MapLibre's terrain. Models at every zoom, crossfading to glowing dots when zoomed out. No clustering.
- Data: one subscription to `wss://api.entur.io/realtime/v2/vehicles/subscriptions` (graphql-ws). Each message is a batch of full vehicle states, upserted by `vehicleId`. The browser sends the client name as a query param, `?ET-Client-Name=steff-myldre`, because it can't set headers on a WebSocket.
- Motion: each vehicle has a playback clock 35 s behind real time. The clock waits at the newest report and catches up at 1.25x. Between two reports the vehicle glides along its service journey's shape at constant speed. It falls back to a straight line when a report is over 40 m off the shape or projects backwards. Text such as "now at" in the info card comes from the newest report, not the drawn position. See SPIKES.md, route-shape glide.
- Shapes: the subscription also asks for `serviceJourney { id }`. Journey Planner v3 resolves it to its journey pattern's `pointsOnLink`, cached per pattern. The browser fetches shapes until the relay exists, and then the relay takes it over.
- Stale vehicles are hidden: `lastUpdated` older than 3 minutes, or status COMPLETED or CANCELLED. A null status counts as alive.
- `speed` is almost always null. Speed comes from consecutive positions of the same vehicle. A null `bearing` keeps the previous bearing.
- A trail belongs to the vehicle and fades over time. It does not reset when the vehicle starts a new journey.
- Modes with their own model: bus, coach (tinted bus), ferry, train. Everything else uses the generic model. Metro and tram have almost no data.
- Until the relay exists, the browser talks to Entur directly. The relay then streams all of Norway to every client, with no viewport filtering.
- Hosting is decided at the deploy milestone.

## Milestones

Build order: M1, then M5, then M8, then M2 to M4. Motion was the go/no-go question. Bergen is the cheap place to build it. The swarm prototype answered a second go/no-go: the project works zoomed out and sped up.

### M8: Swarm replay (next)

Decisions:

- Replay is the default view. The existing live path stays reachable behind `?live`, untouched, until M4. M4's relay keeps a rolling buffer, and live becomes replay at 1x pinned to the buffer's newest report. The separate live path goes then.
- Recordings are static files until M4. A Node recorder subscribes with `source.ts`'s query, without the bounding box, and writes each received vehicle as `[arrivalMs, wireVehicle]` to gzipped NDJSON. Raw wire records keep one parser, and `serviceJourney.id` comes along for shapes. The prototype's recorder dropped it. Files go in `public/recordings/`, gitignored. Whether to commit them is decided at deploy. Size: 15 minutes of all-Norway was 7.7 MB in the prototype's compact format.
- One sim clock replaces `Date.now()` at its four call sites: `App.tsx` (info and ingest) and `vehicleLayers.ts` (`T0` and the tick). Replay hands each report to `store.ingest` when the sim clock passes its `arrivalMs`. The store doesn't change. Its 35 s delay and catch-up run in sim time.
- `TRAIL_MS` is sim time, so 5 minutes lasts 5 s on screen at 60x. The prototype used 15 minutes for the Norway view. Trail length scales with the speed toggle, tuned by eye.

Tasks:

- [ ] Recorder, then a weekday morning rush recording (07:00 to 09:00). Evening recordings are fine for development.
- [x] Sim clock and replay source with speed toggles (1x, 10x, 30x, 60x, 120x), looping over the recording
- [x] Opening view on all of Norway, blue-black base, additive glowing dots and fading trails per mode
- [x] Shapes at Norway scale: about 1000 journeys on load. Measure fetch count and time. If too slow, fetch rail and in-view vehicles first.
  - Measured on the evening recording at 1x: about 1420 journeys asked within 1 s of load, 54 POSTs, 50% answered by 3.2 s and 90% by 4.6 s. No ordering needed. A loop of the 30-minute recording names about 2290 journeys. `journeyShapes` caches one answer per journey, so a later loop and the store's sim-time retries cost no requests.
- [x] Rail stays on its shape when zoomed out. The 40 m off-shape fallback was tuned on Bergen buses, so check it on trains.
  - Raw train reports within 40 m of their journey's shape: Go-Ahead 98%, SJ 96%, Vy 89.5% (5% at 40 to 100 m, 5% over 200 m). Flytoget's `pointsOnLink` runs stop to stop, 9 vertices over 82 km, so 71% of its reports fall back to straight lines. That's the data, not the threshold. The 40 m fallback stays.

### M1: Bergen moving, night mood (one weekend)

- [x] Vite + SolidJS + TS scaffold with a full-screen MapLibre map
- [x] OpenFreeMap style tuned to a sodium-lit night, Terrarium terrain at 1.5x, tilted camera at zoom 15 over Bergen centre
- [x] Browser subscribes to Entur with a Bergen bounding box, stale vehicles hidden
- [x] One generic low-poly glTF per vehicle, z from `queryTerrainElevation` (re-queried as terrain tiles load), rotated by bearing
- [x] Linear tween from previous to latest position, lasting about the vehicle's own update gap (replaced in M5)

### M2: All of Norway, readable

- [ ] Subscription without a bounding box
- [ ] Models crossfade to glowing dots when zoomed out
- [ ] Fading trails (`TripsLayer`), built from positions seen since page load
- [ ] Info card on click: line, destination, delay, mode

### M3: Models per mode

- [ ] Ferry
- [ ] Train
- [ ] Bus, with coach as a tinted bus

### M4: Rust relay and deploy

- [ ] Axum + Tokio relay with one upstream subscription to Entur
- [ ] Relay filters stale vehicles and sends a compact payload
- [ ] Relay keeps about 5 minutes of trail history and sends it with the snapshot
- [ ] Deploy the relay, and the frontend on static hosting

### M5: Motion along the road (Bergen, before M2)

- [x] Delayed playback clock per vehicle: 35 s behind, waits at the newest report, catches up at 1.25x
- [x] Parse `serviceJourney.id`, fetch and cache its pattern's `pointsOnLink`
- [x] Glide along the shape between two reports, with a straight fallback when a report is off the shape or runs backwards
- [x] Projection that searches forward from the last known distance, so out-and-back spurs and terminal loops don't snap to the wrong pass
- [x] Tunnel freezes: an exactly repeated location counts as no fix, and the vehicle glides across the whole freeze. A speed cap lets it arrive late after a freeze instead of a longer playback delay.

### M6: Follow-vehicle camera

- [ ] Lock the camera onto a selected vehicle and ride along

### M7: Moods

- [ ] Day and night toggle
- [ ] Day cycle
- [ ] Weather

## For later

- Dead-reckon a frozen vehicle along its shape into a tunnel, instead of standing at the mouth for freezes over about 33 s (30% of Bergen's exact-repeat freezes). See docs/vehicle-store.md, sign-off.
- Realistic visuals
- Kartverket elevation data for sharper fjords
- Self-hosted Protomaps Norway extract
- Dim or gray COMPLETED vehicles instead of hiding them
- Swap the elevation query for `TerrainExtension` once [visgl/deck.gl#10758](https://github.com/visgl/deck.gl/issues/10758) lets it follow MapLibre terrain
- Check on a weekday whether Ruter (Oslo) vehicles appear in the API. They were absent on Sunday 2026-10-25.
