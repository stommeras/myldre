# Spikes

## Entur vehicle positions from a browser (2026-10-25)

Headless Chromium 155 on Vite subscribed to `wss://api.entur.io/realtime/v2/vehicles/subscriptions` with `graphql-ws` and default `bufferSize`/`bufferTime`. Two 10-minute captures ran at the same time on a Sunday afternoon: one with a Bergen bounding box (lat 60.25 to 60.55, lon 5.15 to 5.50) and one with no box. Every received frame was saved. Raw captures and scripts (`capture.mjs`, `analyze.mjs`) live in `~/scratch/entur-vehicles-spike/`, outside the repo.

| Finding | Bergen | Norway | How measured | Decision |
|---|---|---|---|---|
| Client name | accepted | accepted | 30 s probe each with query param, `connectionParams`, and nothing: all got 101, `connection_ack` and data, with identical response headers. HTTP endpoint returns 200 without the header. | Send `?ET-Client-Name=steff-myldre` on the URL. Entur's docs want it on the connection request, and the query param is the only part of that request a browser controls. |
| Distinct `vehicleId` | 146 | 1219 | Unique ids over 10 min | Scale is small. No clustering needed. |
| Messages per minute | 97 | 359 | `next` frames / capture minutes | Browser handles all of Norway directly until the relay. |
| Vehicles per message | mean 6, max 20 | mean 18, median 20 | Array length per `next` frame | Batches cap at 20 (likely default `bufferSize`). Upsert each batch by `vehicleId`. |
| Raw volume | 2.5 MB | 26 MB | JSON file size for 10 min | About 43 KB/s for Norway. The relay's compact payload is worth it. |
| Update gap per vehicle | p50 10 s, p90 31 s | p50 4 s, p90 21 s | Difference between consecutive `lastUpdated` of one vehicle | Tween over the observed gap, not a fixed duration. |
| Null `bearing` | 4.1% | 1.6% | Share of all records | Keep the previous bearing when null. |
| Null `speed` | 100% | 92.5% | Share of all records | Derive speed from consecutive positions. |
| `lastUpdated` over 2 min old | 4.1% | 1.4% | Record time vs receive time. Local clock matched the server `Date` header within 1 s. | All stale records arrived in the first 5 s after subscribe (59% and 35% of that burst), none after. Keep the 2-minute rule. |
| COMPLETED or CANCELLED | 4.9% | 0.9% | Share of all records. Norway had 3 CANCELLED. | Keep hiding them. |
| Null `vehicleStatus` | 1.4% | 18.2% | Share of all records | Treat null status as alive, or a fifth of Norway disappears. |
| Modes (distinct vehicles) | BUS 138, RAIL 4, COACH 2, FERRY 2 | BUS 835, FERRY 179, COACH 115, RAIL 89, TRAM 1 | `mode` of each vehicle's last record | Matches the plan. No METRO, AIR or TAXI. |
| Ruter (`RUT`) | n/a | absent | Codespaces of distinct vehicles (22 present) | Still open. Re-run the Norway capture on a weekday. |

## glTF models on MapLibre terrain (2026-10-25)

Headless Chromium 156 with SwiftShader (software WebGL) on Vite, deck.gl 9.4.0. MapLibre had the OpenFreeMap dark style and Terrarium terrain at 1.5x exaggeration. One `ScenegraphLayer` drew a 48 m wide, 120 m tall box with its base at the model origin, at three points: Fløyen slope (about 400 m with exaggeration), Ulriken slope (about 730 m) and the harbour (0 m). A MapLibre `Marker` sat at each point as ground truth, because MapLibre places markers on its own terrain and dims them when terrain hides them. Each variant was screenshotted at five camera poses, pitch 0 to 75 and bearing -120 to 140, two of them zoomed in on Fløyen's west slope. Camera moves used `jumpTo`, not mouse drags. Code and 48 screenshots live in `~/scratch/terrain-gltf-spike/`, outside the repo.

| Finding | How measured | Decision |
|---|---|---|
| `TerrainExtension` alone leaves models at sea level | Fløyen box drawn about 95 px below its marker at pitch 65, or hidden inside the hill, on both overlay packages and in both modes. In deck.gl's source, `TerrainEffect.preRender` returns early when no deck layer has `operation: 'terrain'`, so it never reads MapLibre's terrain. | Don't use `TerrainExtension` for now. Upstream RFC [visgl/deck.gl#10758](https://github.com/visgl/deck.gl/issues/10758) proposes feeding MapLibre terrain to it, using a custom layer API added in MapLibre 6.13. Revisit when that lands. |
| `map.queryTerrainElevation()` as each model's z puts it on the slope | Box base on its marker at all five poses, on MapLibre 5 and 6, in both modes. The value already includes the exaggeration. It sharpens as finer DEM tiles load, so the prototype refreshed z on `idle`. | Set z from `queryTerrainElevation`. Re-query when terrain tiles load and when a vehicle gets a new position. |
| Interleaved mode hides models behind ridges, overlaid mode doesn't | Pitch 75, bearing -120: both markers dimmed behind a ridge. Interleaved showed only the box tip above the ridge. Overlaid drew both boxes in full on top. | Interleaved. |
| An invisible deck `TerrainLayer` (`operation: 'terrain'`) also works with `TerrainExtension` | Box base on its marker, same as the elevation query. Every DEM tile is fetched twice and meshed twice. At pitch 70 and above the map did not go idle within 30 s. | Not worth the second terrain. |
| `@deck.gl/mapbox` `MapboxOverlay` breaks on maplibre-gl 6.16.0 with terrain | Page throws `Cannot read properties of undefined (reading 'elevation')`. It reads `map.transform`, which MapLibre 6 no longer exposes. Works on maplibre-gl 5.24.0. | Use `@deck.gl/maplibre` `MapLibreOverlay` instead. Its peer range covers maplibre-gl 4.5.1 to 6, and it syncs the camera through the public `map.getCenterElevation()`. Results matched MapLibre 5 on 6.16.0. |
| Basemap labels survive a deck layer drawn below them on MapLibre 6 | Same screenshots with the box layer above and below the first symbol layer (`beforeId`). Labels had the same text and size. | Bug [visgl/deck.gl#10700](https://github.com/visgl/deck.gl/issues/10700) did not show with this layer and style. Still draw vehicles above labels, since that path avoids it entirely. |
| A flat-bottomed model on a steep slope sinks on the uphill side | At pitch 50 the slope cuts the uphill corner of the 48 m box. | Expected. Keep vehicle footprints small, or lift models slightly if it looks wrong at real size. |
| deck.gl 9.4.0 exports the extension as `_TerrainExtension` | Import of `TerrainExtension` failed. | Note for when #10758 lands. |
