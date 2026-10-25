# Vehicle store design

Sketch for the vehicle store, its source seam, and how it feeds deck.gl. The code under `src/` has signatures, types, doc comments and `not implemented` bodies. `src/vehicles/store.test.ts` is the executable spec. Terms are in [GLOSSARY.md](../GLOSSARY.md).

## Problem

About 1200 vehicles arrive as unordered batches of full states: up to 20 per message, about 6 messages a second for all of Norway, with a burst of stale records after every subscribe. In M4 the relay replaces Entur-direct, sends a compact payload, and adds about 5 minutes of trail history to the first snapshot. The app keeps per-vehicle state (latest report, resolved bearing, trail, tween, terrain z) and derives visibility, a per-frame pose, trail geometry and info-card data from it.

Constraints from PLAN.md and SPIKES.md:

- Upsert by `vehicleId`. A vehicle is stale when `lastUpdated` is older than 2 minutes or its status is COMPLETED or CANCELLED. A null status counts as alive, because 18% of Norway's records have one.
- A null bearing keeps the previous bearing. Speed is derived, because `speed` is null in 92 to 100% of records.
- A trail belongs to the vehicle and survives journey changes.
- A tween lasts about the vehicle's own update gap (p50 4 s, p90 21 s in Norway).
- z comes from `map.queryTerrainElevation()`. It sharpens as DEM tiles load, so the store re-samples it.
- Map and deck state live outside Solid's reactivity.

## Usage (caller's view)

The app uses one source function, one store class and one attach function.

```ts
// App.tsx is the composition root, and the only place Solid meets plain state.
const store = new VehicleStore((p) => map?.queryTerrainElevation([p[0], p[1]]) ?? null);
const [version, setVersion] = createSignal(store.version);
const [selected, setSelected] = createSignal<VehicleId | null>(null);
const info = createMemo(() => (version(), selected() ? store.info(selected()!, Date.now()) : null));

onMount(() => {
  map = createMap(container);
  const detach = attachVehicleLayers(map, store, setSelected); // overlay, rAF loop, picking, terrain hook
  const stop = vehicleSource((reports) => {
    store.ingest(reports, Date.now());
    setVersion(store.version);
  });
  onCleanup(() => { stop(); detach(); map?.remove(); });
});
```

```ts
// map/vehicleLayers.ts, every animation frame:
const now = Date.now();
overlay.setProps({ layers: vehicleLayers(store.frame(now), map.getZoom(), now) });

// and when DEM tiles arrive:
map.on("sourcedata", (e) => e.tile && e.sourceId === map.getTerrain()?.source && store.terrainChanged());
```

```ts
// M4: rewrite src/vehicles/source.ts for the relay. It still exports
// `vehicleSource: VehicleSource`, and its snapshot sends trail history as ordinary
// VehicleReports in one batch. No other file changes.
```

## Shape

Module map:

| File | Owns | Public surface |
|---|---|---|
| `vehicles/types.ts` | Domain vocabulary and the seam type | `VehicleId`, `LngLat`, `Position3`, `Mode`, `Journey`, `VehicleReport`, `VehicleSource` |
| `vehicles/source.ts` | graphql-ws and the wire-to-domain parse. M4 rewrites it. | `vehicleSource` |
| `vehicles/motion.ts` | Pure motion math. M5 replaces it. | `Tween`, `startTween`, `drawnAt`, `bearingBetween`, `speedMps` |
| `vehicles/store.ts` | All per-vehicle state and its rules | `VehicleStore { ingest, terrainChanged, frame, info, version }`, `STALE_MS`, `TRAIL_MS`, `VehiclePose`, `TrailPath`, `Frame`, `VehicleInfo` |
| `map/vehicleLayers.ts` | Everything deck.gl | `attachVehicleLayers(map, store, onPick)` |
| `App.tsx`, `ui/InfoCard.tsx` | Solid UI and wiring | |

**Data structure.** The store holds a private `Map<VehicleId, VehicleState>`, with `VehicleState = { latest, bearing, trail, tween, zEpoch }`. An upsert is a map lookup. A frame is one pass over about 1200 entries. A pick is a lookup by id. The trail is a field on the vehicle with no journey key, so a journey change has nothing to reset (per encode-lessons-in-structure). The tween target is never stored, because it is always the last trail point. Speed is never stored either, and `VehicleReport` has no speed field. `speedMps` is the only way to get it, and M5 is its first caller.

**Clock.** Every time is epoch ms on `Date.now()`'s clock, because the stale rule compares `lastUpdated` with local time. The spike found the local clock within 1 s of the server. Every read takes `now` as a parameter, so the rules are pure and testable. TripsLayer timestamps are float32 on the GPU, so `vehicleLayers.ts` converts them to seconds since page load. That conversion exists nowhere else.

**Ingest.** `ingest` sorts the batch by `recordedAt` and drops any report no newer than the vehicle's latest. A repeated batch or a reconnect burst is therefore a no-op that doesn't bump `version` (per make-operations-idempotent). A live report glides from where the vehicle is drawn now, so a report that lands mid-tween causes no jump. The tween lasts the vehicle's own gap, with a 1 s floor. A gap over 2 minutes (the stale threshold) snaps the model instead of gliding. The trail stays: a layover at a depot adds a zero-length segment, and a segment across a longer silence is already mostly faded when it appears. When one batch has several reports for the same vehicle, each one chains from the previous point, so relay history becomes trail and only the last step animates. History needs no separate field or method. The first bearing is the reported one. If a vehicle has never reported a bearing, the store derives one from its movement.

**Trail times.** Each trail point stores `drawnAt`, the time the drawn model reaches it. A live report's point gets the tween's `endsAt`. Points from one batch keep their spacing and end at the tween's end. A point is stamped once and never re-stamped. TripsLayer's own interpolation then puts the trail head under the tweened model, and `trailLength = TRAIL_MS` fades the trail with no fade state in the store. `trails` includes hidden vehicles, so a stale or ended vehicle's trail fades out on its own after its model disappears.

**Stale rule.** `isStale` is one function, applied at read time and never stored. The parser turns wire statuses into `journeyEnded: boolean`, with null meaning alive. The relay will already filter stale vehicles, and the store applies the rule anyway. A vanished vehicle sends no goodbye, so the age check has to live in the store. A vehicle silent for `STALE_MS + TRAIL_MS` is forgotten.

**Source seam.** `type VehicleSource = (onReports) => stop`. This interface is the one with a reason to exist: it is the M4 swap point. `source.ts` implements it, and its wire types are not exported (per boundary-discipline). The contract allows any order, repeats, history and unfiltered stale records, because the store absorbs all of them. A new source only has to connect, parse and emit.

**Feeding deck.gl.** `frame(now)` is the only read for layers. It applies the stale rule, tweens every visible vehicle, spends up to 2 ms re-sampling terrain z, and returns `{ poses, trails }`. A reader can't see an un-advanced store, because no other read exists.

- Models and dots: `poses` is a fresh array of `{ id, mode, position: [lng, lat, z], bearing }` each frame. The same array feeds the `ScenegraphLayer` at opacity `s(zoom)` and a `ScatterplotLayer` of dots at opacity `1 - s`, with a smoothstep between zoom 9 and 11. Each layer is `visible: false` at 0 opacity.
- Trails: `trails` keeps its reference until a trail gains a point, a z changes, or a vehicle is forgotten. Between those events TripsLayer only updates its `currentTime` uniform.
- Picking: deck `onClick` hands the picked pose's id, or null, to `onPick`, which is the Solid setter.

**Terrain z.** The store gets `ElevationAt` as a plain function, the only map knowledge it has. Each report samples z once for its own point, about 100 queries a second for Norway. A DEM tile load calls `terrainChanged()`, which is O(1) and bumps an epoch. `frame` then sweeps vehicles behind that epoch round-robin, within a 2 ms budget, re-sampling every trail point and the tween start. Only a full sweep marks a vehicle current, so a report arriving mid-sweep can't hide unswept points. A null sample keeps the old z. The trigger is `sourcedata`, not `idle`, because `idle` may never fire while deck animates every frame.

**Per-frame cost for about 1200 vehicles (estimates, not measured).** `frame` does one map pass with a stale check, three lerps and a bearing lerp per vehicle, well under 0.5 ms. deck then recomputes instance attributes for two layers of 1200, under 1 ms. Steady state makes no terrain queries per frame. After a tile load, sweeps take at most 2 ms a frame until done. Rebuilding trail geometry (up to about 90k vertices) happens about 6 times a second in Norway and is the biggest CPU item.

**Solid.** The store never imports Solid, and deck never sees a signal. Two signals cross in `App`: `version`, mirrored after each ingest, and `selected`, set from picking. The card is a memo that pulls `store.info(id, now)` when either changes.

**Interface depth.** The store's public surface is four methods and one getter. Behind it are ordering, dedupe, the stale rule, bearing hold and derivation, tween start and chaining, trail stamping, pruning, eviction, and budgeted z refresh. `VehicleState` and `TrailPoint` are private to `store.ts`.

**Deliberately not done.** No event bus or subscriber list. No reactive store. No per-mode layers yet (M3 maps a `Record<Mode, url>` over `poses`). No connection-status UI. No GPU-side tween. No pose pooling.

## Synthesis decision

Two runners produced candidates. Candidate 1 (Opus) was "one fat store, thin edges": a `VehicleStore` class, `source/` as a directory with an index that picks the source, and relay history sent as ordinary reports. Candidate 2 (Sonnet) was a `Fleet` class with `tick(now)` followed by reads of public `visible` and `trailRev` fields, a branded monotonic clock, and an optional `VehicleReport.history` field.

Both runners chose the same core shape: one mutable store class that owns all per-vehicle state, a function-typed source seam, and a pure motion module that M5 replaces. That agreement was the strongest signal of the arena.

The cross-judge (Sonnet) recommended candidate 2 as base. I picked candidate 1. Candidate 2's main flaws were structural. It had public mutable fields, a temporal coupling where `tick` had to run before reads, and two ways to put positions into a trail (`history` plus ingest). Its `at <=` drop also discarded out-of-order reports, since it never sorted. Candidate 1's flaws were mechanisms that could be swapped out. The judge was right about those, so the swaps came from candidate 2:

- **One read per frame.** `poses()`, `trails()` and `refreshElevation()` became `frame(now)`. This answers the judge's "callers coordinate several calls" point and avoids candidate 2's tick-then-read coupling.
- **Budgeted, epoch-based z refresh (from candidate 2).** It replaces candidate 1's single sweep of up to 90k queries gated on `idle`, which may never fire. The z epoch now lives per vehicle and only a full sweep sets it. That fixes a bug the judge found in candidate 2, where ingest marked half-swept vehicles current.
- **Trail points stamped once with the time the model reaches them (from candidate 2).** It replaces candidate 1's re-shift of the whole trail on every ingest, which made older points' fade times jitter.
- **The source in one file (from candidate 2).** `vehicles/source.ts` is rewritten in place in M4. That fits "changes one module" exactly and removes candidate 1's index/entur import cycle.
- **First-report bearing derived from movement (from candidate 2).** It replaces "0 until reported".
- **Outage threshold equal to the stale rule.** It replaces candidate 1's 60 s snap and 30 s tween cap, which conflicted with the 2-minute rule.

Rejected from candidate 2: the `MonoMs` clock. It needs an epoch-to-mono offset that drifts across laptop sleep, and seconds since page load fit float32 just as well. Also rejected: in-place pose mutation with `updateTriggers: now` (more rules for every reader, for about 1200 small objects a frame), the public `trailRev` and `visible` fields, and the 500 ms poll for the info card. The `version` signal already updates the card on every ingest.

Verification: the sketch type-checks under `strict` against deck.gl 9.4.0, maplibre-gl 6.16, solid-js 1.9 and graphql-ws 6. That check found and fixed one real mismatch: MapLibre's `LngLatLike` doesn't accept a readonly tuple. All 10 tests in `store.test.ts` load and fail with `not implemented`.

## Tradeoffs accepted

- We accept a store that holds render state (tween, z) in exchange for one owner of per-vehicle state. Nothing outside the store needs pruning in sync with it.
- We accept a fresh pose array every frame in exchange for a plain array that deck diffs by reference. If GC shows up in a profile, pool the poses.
- We accept mid-tween z as a straight line between two terrain samples. It can cut through a crest on long gaps, in exchange for zero per-frame elevation queries.
- We accept terrain z lagging for a few frames after a big tile load, in exchange for never spending more than 2 ms a frame on it.
- We accept a tween length taken from the last gap only, with no smoothing.
- We accept a faint straight trail segment when a vehicle moves during a silence of over 2 minutes, in exchange for trails that survive layovers.
- We accept that `motion.ts` and `source.ts` can be imported from outside `vehicles/`. TypeScript has no package-private visibility. A `no-restricted-imports` lint rule closes that gap if it matters.

## Alternatives considered

- **Pure reducer with an immutable snapshot per batch, and a renderer that keeps its own tween and z caches by id.** Each piece looks cleaner, but per-vehicle state gets two owners that must be pruned and keyed in sync. Every batch also copies about 1200 entries that no reader needs.
- **Solid `createStore` holding the vehicles.** The UI would get reactivity for free, but deck would read 1200 tracked proxies 60 times a second, against PLAN's rule that map and deck state stay outside Solid.
- **deck.gl attribute `transitions` on `getPosition` (a GPU tween).** It costs no CPU per frame, but its duration is per layer, not per vehicle's gap. Every batch of 20 would restart all 1200 transitions, and z and bearing couldn't follow the same rule.
- **Struct-of-arrays store feeding deck binary attributes.** It is the fastest option, but evictions need free-slot management and trails become variable-length rows. At 1200 vehicles the accessor path already costs under 1 ms.
- **Delayed playback on source timestamps** (draw at `now - gap` and interpolate between reports). It handles batch jitter best, but needs a per-vehicle clock offset, and PLAN asks for a tween over the observed gap. `motion.ts` is the swap point if M5 wants it.
- **Two source implementations behind a config flag.** That is two ways to do one task, plus a flag nobody turns off. Git keeps the Entur adapter after M4.

## Open questions and risks

- Is `vehicleId` unique across codespaces, or should the parser prefix the codespace?
- Does `opacity` on a `ScenegraphLayer` crossfade cleanly, or does transparency sorting look wrong mid-fade? A fallback is to scale the models down while the dots fade in.
- Does `MapLibreOverlay` in interleaved mode trigger a map repaint on every `setProps`, or does the rAF loop need `map.triggerRepaint()`? Check this in M1.
- How fast is `queryTerrainElevation`? The 2 ms budget assumes a few µs per call. Measure it in M1.
- Will the relay send full states? The contract says a source expands deltas itself, which would mean `source.ts` keeps a map of last journeys.

Decided at sign-off (2026-10-25): a trail survives a long silence, a hidden vehicle's trail fades out on its own, and the 9 to 11 crossfade zoom gets tuned by eye in M2.

## Next implementation step

Fill in `motion.ts` and `VehicleStore` against `store.test.ts`. Then feed it a saved spike capture from `~/scratch/entur-vehicles-spike/` before any map exists.
