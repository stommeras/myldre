# Myldre plan

A tilted 3D night map of Norway with live public transport vehicles moving on real terrain. Data comes from the Entur Vehicle Positions API. Terms are defined in [GLOSSARY.md](GLOSSARY.md). Measurements behind the data and rendering decisions are in [SPIKES.md](SPIKES.md).

## Settled decisions

- Look: stylized toy diorama. Low-poly, flat-shaded vehicles scaled up about 3x, muted dark base, glowing accents.
- Frontend: SolidJS + Vite + TypeScript SPA. Map and deck.gl state live outside Solid's reactivity.
- Map: MapLibre GL JS 6, OpenFreeMap base tiles with a dark style, AWS Terrarium terrain with 1.5x exaggeration (tunable).
- Camera: the map opens tilted at zoom 15 over Bergen centre. The shape glide only shows from about zoom 15 up (SPIKES.md, route-shape glide).
- Vehicles: deck.gl `ScenegraphLayer`, mounted via `MapLibreOverlay` from `@deck.gl/maplibre` in interleaved mode, drawn above the basemap labels. Each vehicle's z comes from `map.queryTerrainElevation()`, because `TerrainExtension` doesn't read MapLibre's terrain. Models at every zoom, crossfading to glowing dots when zoomed out. No clustering.
- Data: one subscription to `wss://api.entur.io/realtime/v2/vehicles/subscriptions` (graphql-ws). Each message is a batch of full vehicle states, upserted by `vehicleId`. The browser sends the client name as a query param, `?ET-Client-Name=steff-myldre`, because it can't set headers on a WebSocket.
- Motion: each vehicle has a playback clock 35 s behind real time. The clock waits at the newest report and catches up at 1.25x. Between two reports the vehicle glides along its service journey's shape at constant speed. It falls back to a straight line when a report is over 40 m off the shape or projects backwards. Text such as "now at" in the info card comes from the newest report, not the drawn position. See SPIKES.md, route-shape glide.
- Shapes: the subscription also asks for `serviceJourney { id }`. Journey Planner v3 resolves it to its journey pattern's `pointsOnLink`, cached per pattern. The browser fetches shapes until the relay exists, and then the relay takes it over.
- Stale vehicles are hidden: `lastUpdated` older than 2 minutes, or status COMPLETED or CANCELLED. A null status counts as alive.
- `speed` is almost always null. Speed comes from consecutive positions of the same vehicle. A null `bearing` keeps the previous bearing.
- A trail belongs to the vehicle and fades over time. It does not reset when the vehicle starts a new journey.
- Modes with their own model: bus, coach (tinted bus), ferry, train. Everything else uses the generic model. Metro and tram have almost no data.
- Until the relay exists, the browser talks to Entur directly. The relay then streams all of Norway to every client, with no viewport filtering.
- Hosting is decided at the deploy milestone.

## Milestones

Build order: M1, then M5, then M2 to M4. Motion was the go/no-go question. Bergen is the cheap place to build it.

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

- [ ] Delayed playback clock per vehicle: 35 s behind, waits at the newest report, catches up at 1.25x
- [ ] Parse `serviceJourney.id`, fetch and cache its pattern's `pointsOnLink`
- [ ] Glide along the shape between two reports, with a straight fallback when a report is off the shape or runs backwards
- [ ] Projection that searches forward from the last known distance, so out-and-back spurs and terminal loops don't snap to the wrong pass
- [ ] Tunnel freezes: an exactly repeated location counts as no fix, and the vehicle glides across the whole freeze. A speed cap lets it arrive late after a freeze instead of a longer playback delay.

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
