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
