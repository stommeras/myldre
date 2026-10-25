# Myldre plan

A tilted 3D night map of Norway with live public transport vehicles moving on real terrain. Data comes from the Entur Vehicle Positions API. Terms are defined in [GLOSSARY.md](GLOSSARY.md). Measurements behind the data decisions are in [SPIKES.md](SPIKES.md).

## Settled decisions

- Look: stylized toy diorama. Low-poly, flat-shaded vehicles scaled up about 3x, muted dark base, glowing accents.
- Frontend: SolidJS + Vite + TypeScript SPA. Map and deck.gl state live outside Solid's reactivity.
- Map: MapLibre GL JS, OpenFreeMap base tiles with a dark style, AWS Terrarium terrain with 1.5x exaggeration (tunable).
- Vehicles: deck.gl `ScenegraphLayer` with `TerrainExtension`, mounted via `MapboxOverlay`. Models at every zoom, crossfading to glowing dots when zoomed out. No clustering.
- Data: one subscription to `wss://api.entur.io/realtime/v2/vehicles/subscriptions` (graphql-ws). Each message is a batch of full vehicle states, upserted by `vehicleId`. The browser sends the client name as a query param, `?ET-Client-Name=steff-myldre`, because it can't set headers on a WebSocket.
- Stale vehicles are hidden: `lastUpdated` older than 2 minutes, or status COMPLETED or CANCELLED. A null status counts as alive.
- `speed` is almost always null. Speed comes from consecutive positions of the same vehicle. A null `bearing` keeps the previous bearing.
- A trail belongs to the vehicle and fades over time. It does not reset when the vehicle starts a new journey.
- Modes with their own model: bus, coach (tinted bus), ferry, train. Everything else uses the generic model. Metro and tram have almost no data.
- Until the relay exists, the browser talks to Entur directly. The relay then streams all of Norway to every client, with no viewport filtering.
- Hosting is decided at the deploy milestone.

## Milestones

### M1: Bergen moving, night mood (one weekend)

- [ ] Vite + SolidJS + TS scaffold with a full-screen MapLibre map
- [ ] OpenFreeMap style tuned dark, Terrarium terrain at 1.5x, tilted camera over Bergen
- [ ] Browser subscribes to Entur with a Bergen bounding box, stale vehicles hidden
- [ ] One generic low-poly glTF per vehicle, sitting on terrain, rotated by bearing
- [ ] Linear tween from previous to latest position, lasting about the vehicle's own update gap

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

### M5: Better motion

- [ ] Dead reckoning along bearing with speed derived from recent positions, easing toward each new position
- [ ] Snap to route shapes from Journey Planner `pointsOnLink`

### M6: Follow-vehicle camera

- [ ] Lock the camera onto a selected vehicle and ride along

### M7: Moods

- [ ] Day and night toggle
- [ ] Day cycle
- [ ] Weather

## For later

- Realistic visuals
- Kartverket elevation data for sharper fjords
- Self-hosted Protomaps Norway extract
- Dim or gray COMPLETED vehicles instead of hiding them
- Check on a weekday whether Ruter (Oslo) vehicles appear in the API. They were absent on Sunday 2026-10-25.
