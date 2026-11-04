# Vehicle store design

Design for the vehicle store after M5, which adds delayed playback, route shapes and tunnel freezes. `src/vehicles/store.test.ts` is the executable spec. Terms are in [GLOSSARY.md](../GLOSSARY.md). The evidence behind the numbers is in [SPIKES.md](../SPIKES.md), route-shape glide.

## Problem

About 1200 vehicles arrive as unordered batches of full states. That's up to 20 per message and about 6 messages a second for all of Norway, with a burst of stale records after every subscribe. In M4 a relay replaces Entur-direct and adds about 5 minutes of trail history to the first snapshot. For each vehicle the store keeps state and derives visibility, a per-frame pose, trail geometry and info-card data from it.

M1 drew each vehicle by tweening straight from where it was drawn to its newest report, over its last update gap. The route-shape spike measured what that costs. Buses cut corners by up to 72 m, stood still 49 to 61% of the time because tweens finish before the next report lands, and raced 2 km in 17 s out of tunnels. M5 replaces the motion model with five rules from PLAN.md. Three terms first. A fix is a report whose position the store moves to, so not an exact repeat of the position before it. A run is a stretch of a vehicle's life that the model plays without a break. A pass is one stretch of a shape that runs near a point, so a road the route drives out and back on has two passes there.

1. Each vehicle plays back 35 s behind real time. Playback waits at the newest report and catches up at 1.25x.
2. The store reads `serviceJourney.id` from reports and gets that journey's shape, the journey pattern's `pointsOnLink`.
3. Between two reports the model glides along the shape at constant speed. It falls back to a straight line when a report is over 40 m off the shape or projects more than 15 m backwards. Jitter within 15 m backwards becomes a stop.
4. Projection searches forward from the last known distance along the shape, so out-and-back spurs and terminal loops don't snap to the wrong pass.
5. An exactly repeated position while `lastUpdated` keeps ticking is no fix. The model glides across the whole freeze, and a speed cap lets it arrive late rather than lengthening the delay.

Review added three rules that PLAN.md doesn't state. A fix that would leave the model more than 3 minutes past its 35 s target starts a new run at that fix. A projection over the whole shape picks the pass the reported bearing points along. A glide that runs far longer along the shape than the straight line between its ends goes straight instead.

Constraints carried over from M1, still true:

- Upsert by `vehicleId` (codespace-prefixed, `SKY:101`). Reports may arrive in any order, repeat, or be history. The store absorbs all of it.
- A vehicle is stale when its newest `lastUpdated` is over 3 minutes old or its journey is COMPLETED or CANCELLED. A null status counts as alive.
- `speed` is almost always null. Speed is derived from positions.
- A trail belongs to the vehicle, survives journey changes and long silences, and fades out on its own after the model disappears.
- z comes from `map.queryTerrainElevation()` and sharpens as DEM tiles load, so the store re-samples it.
- Map and deck state live outside Solid's reactivity.

Two things make the shape non-obvious. Shapes arrive asynchronously, from the network, into a store that was fully synchronous. And once the model curves along the road and runs 35 s late, a trail built from reports alone would leave the model at every bend, so pose and trail need one source.

## Usage (caller's view)

The app still uses one source, one store and one attach function. M5 adds one injected function, the shape lookup, beside the elevation function the store already takes. M8 adds one `Clock` that every caller reads for "now": `Date.now()` at 1x behind `?live`, or a `ReplayClock` that plays a recording sped up. The store never reads a clock itself.

```ts
// App.tsx, the composition root.
import { journeyShapes } from "./vehicles/shapes";

const store = new VehicleStore({
  elevationAt: (p) => map?.queryTerrainElevation([p[0], p[1]]) ?? null,
  shapeOf: journeyShapes,
});
const [version, setVersion] = createSignal(store.version);
const [selected, setSelected] = createSignal<VehicleId | null>(null);
const info = createMemo(() => (version(), selected() ? store.info(selected()!, clock.now()) : null));

onMount(() => {
  map = createMap(container, live ? BERGEN : NORWAY);
  const detach = attachVehicleLayers(map, store, clock, setSelected);
  const stop = source((reports) => {
    store.ingest(reports, clock.now());
    setVersion(store.version);
  });
  onCleanup(() => { stop(); detach(); map?.remove(); });
});
```

```ts
// map/vehicleLayers.ts. Every animation frame:
const now = clock.now();
overlay.setProps({ layers: vehicleLayers(store.frame(now), map.getZoom(), now) });
// TripsLayer keeps currentTime = now and trailLength = TRAIL_MS.
```

```ts
// vehicles/shapes.ts, the only file that knows Journey Planner. M4 rewrites it for the relay.
export const journeyShapes: ShapeLookup = (journey) => {
  // Calls made in the same tick share one POST, one GraphQL alias per journey:
  //   j0: serviceJourney(id: "...") { journeyPattern { pointsOnLink { points } } }
  // Decodes the precision-5 polyline. Resolves null when the journey has no pattern or points.
  // Rejects on HTTP or network errors and on a GraphQL error for its own alias, which is transient,
  // and aborts after 10 s. It never resolves null for an error.
};
```

Nobody tells the store that a shape arrived, and nobody advances a clock. After each ingest the store asks for the shape of each visible vehicle's newest journey, unless it already has an entry for it, and uses the shape for every segment built after it lands. `info(id, now)` is a pure read. `frame(now)` computes poses and trail times from `now` alone, and also runs the budgeted z sweep, which can change a trail's z.

## Shape

### Module map

| File | Owns | Public surface | M5 change |
|---|---|---|---|
| `vehicles/types.ts` | Domain vocabulary and both seam types | `VehicleId`, `JourneyId`, `LngLat`, `Position3`, `Mode`, `Journey`, `VehicleReport`, `VehicleSource`, `ShapeLookup` | Adds `JourneyId`, `VehicleReport.journeyId`, `ShapeLookup`. `Journey` is unchanged. The `VehicleReport` comment drops its pointer to `speedMps`. |
| `vehicles/source.ts` | graphql-ws subscription over `entur.ts`, which holds the wire parse and recording lines. M4 rewrites `source.ts`. | `vehicleSource` | Selects `serviceJourney { id }` and parses it into `journeyId` |
| `vehicles/source.test.ts` | Parser tests | | Adds a case that parses `serviceJourney.id` into `journeyId`, and null when it is missing |
| `vehicles/shapes.ts` | Journey Planner fetch, batching, polyline decode, the 10 s abort. M4 rewrites it. | `journeyShapes` | New |
| `vehicles/route.ts` | Pure geometry on one shape, in local metres | `prepareShape`, `passesNear`, `pointAlong`, `verticesBetween`, `distanceMetres`, `bearingBetween`, `OFF_SHAPE_M`, `Pass` | New, replaces `motion.ts` |
| `vehicles/motion.ts` | | | Deleted |
| `vehicles/store.ts` | All per-vehicle state, the shape cache, and every motion rule | `VehicleStore`, `STALE_MS`, `TRAIL_MS`, `SHAPE_RETRY_MS`, `SPEED_CAP_MPS`, `ElevationAt`, `VehiclePose`, `TrailPath`, `Frame`, `VehicleInfo` | Rewritten inside, same methods |
| `map/vehicleLayers.ts` | Everything deck.gl | `attachVehicleLayers` | None |
| `App.tsx`, `ui/InfoCard.tsx` | Solid UI and wiring | | The constructor call |
| `scripts/replay.test.ts` | Capture replay | | The constructor call. The oracle hides ended vehicles at playback time. |

### Type sketch

```ts
// vehicles/types.ts (additions)
declare const journeyIdBrand: unique symbol;
/** Entur's service journey id, e.g. `SKY:ServiceJourney:24-202789-20949097`. Only the source's parser mints one. */
export type JourneyId = string & { readonly [journeyIdBrand]: true };

export interface VehicleReport {
  // ...as in M1, including `journey: Journey | null`, the card's line, destination and delay
  /** The service journey, or null when the feed didn't name one. Names the route shape. */
  journeyId: JourneyId | null;
}

/**
 * Resolves a journey to its route shape, the journey pattern's `pointsOnLink` decoded to lng/lat.
 * Resolves null when the journey has no shape, and the store doesn't ask again while it keeps that
 * journey's entry. Rejects on a transient failure. The store asks again for an unanswered or rejected
 * journey 30 s after the request, then after 60 s, 120 s and so on up to 10 minutes. Should settle
 * within 10 s. Implemented once, by `shapes.ts`.
 */
export type ShapeLookup = (journey: JourneyId) => Promise<readonly LngLat[] | null>;
```

```ts
// vehicles/store.ts, public
export const STALE_MS = 2 * 60_000;
export const TRAIL_MS = 5 * 60_000;
/** The first wait before asking again for an unanswered journey. Each later wait doubles, up to 10 minutes. */
export const SHAPE_RETRY_MS = 30_000;
/** The fastest a model is drawn, in metres per wall-clock second. Calibration knob. */
export const SPEED_CAP_MPS: Record<Mode, number> = { bus: 25, coach: 30, ferry: 20, train: 70, other: 25 };

export type ElevationAt = (p: LngLat) => number | null;
export interface VehiclePose { id: VehicleId; mode: Mode; position: Position3; bearing: number }
/** `times[i]` is the wall time the drawn model is at `path[i]`. The tail end may lie in the future. */
export interface TrailPath { id: VehicleId; mode: Mode; path: Position3[]; times: number[] }
export interface Frame { poses: readonly VehiclePose[]; trails: readonly TrailPath[] }
export interface VehicleInfo { id: VehicleId; mode: Mode; journey: Journey | null }

export class VehicleStore {
  constructor(deps: { elevationAt: ElevationAt; shapeOf: ShapeLookup });
  /** Bumps on every ingest that changed something a read can see. Solid mirrors it for the info card. */
  get version(): number;
  /** Upserts a batch in any order, possibly repeated or historical. Idempotent. Asks for missing shapes. */
  ingest(reports: readonly VehicleReport[], now: number): void;
  /** O(1). `frame` re-samples z within a 2 ms budget. */
  terrainChanged(): void;
  /** What to draw at `now`. Poses and trail times depend only on `now`. Also runs the budgeted z sweep. */
  frame(now: number): Frame;
  /** The newest report's journey, or null exactly when `frame(now)` hides the vehicle. */
  info(id: VehicleId, now: number): VehicleInfo | null;
}
```

```ts
// vehicles/store.ts, private to the file
const DELAY_MS = 35_000;
const CATCH_UP = 1.25;
/** Playback rate while the model is less than 35 s behind. Only a new or restarted run gets there. */
const EASE_IN = 0.8;
/** A fix whose lag would pass this starts a new run there. Above the 145 s the Bergen capture's longest tunnel needs. */
const MAX_LAG_MS = 3 * 60_000;
const SHAPE_RETRY_MAX_MS = 10 * 60_000;
const BACKWARD_GRACE_M = 15;
/** A glide longer along the shape than DETOUR_FACTOR × its chord + DETOUR_SLACK_M is taken as the wrong pass. */
const DETOUR_FACTOR = 2;
const DETOUR_SLACK_M = 50;
/** A model turns to a new heading over this many metres. */
const TURN_M = 10;

/** One point the drawn model passes. Behind `now` it is trail, ahead of `now` it is the plan. */
interface PathPoint {
  position: Position3;
  /** Wall time, epoch ms, at which the drawn model is here. Stamped once, at ingest. TripsLayer's timestamp. */
  at: number;
  /** Heading of travel arriving here, degrees. A zero-length step copies the previous one. */
  heading: number;
}

/** The newest fix. Frozen and repeated ended reports aren't fixes. The bearing seeds a lazy projection. */
interface Fix { position: LngLat; recordedAt: number; bearing: number | null }

/** Distance along a journey's shape of the newest fix that was on it. Where the forward window starts. */
interface Cursor { journey: JourneyId; along: number; recordedAt: number }

interface VehicleState {
  /** The newest report of any kind. Info card, silence check, the ended check, mode. */
  latest: VehicleReport;
  fix: Fix;
  cursor: Cursor | null;
  /** Never empty. Keyed by vehicle only, so a journey change has nothing to reset. */
  path: PathPoint[];
  zEpoch: number;
}

type ShapeEntry =
  | { state: "asked"; requestedAt: number; attempts: number }
  | { state: "ready"; shape: RouteShape }
  | { state: "none" };

/** Map<JourneyId, ShapeEntry>, one entry per journey some known vehicle's newest report names. */

/** Wall time to play `spanMs` of reports, starting `lagMs` behind the 35 s target. See Playback schedule. */
function crossMs(spanMs: number, lagMs: number): number;
```

```ts
// vehicles/route.ts, pure, imported only by store.ts
/** Within this distance a position counts as on the shape. */
export const OFF_SHAPE_M = 40;
/** A shape in local metres around its first point, with cumulative distance per vertex. */
export interface RouteShape { /* origin, scale, xs, ys, cum, length */ }
/** Null for fewer than two distinct points. Drops repeated vertices, which have no heading. */
export function prepareShape(points: readonly LngLat[]): RouteShape | null;
/** One pass's nearest point to a position, and the bearing of the shape segment it lies on. */
export interface Pass { along: number; heading: number }
/**
 * The passes near `p` inside [from, to], in order along the shape. A pass is a run of consecutive shape
 * segments whose own projection of `p` lies within OFF_SHAPE_M and inside the window. It ends where a
 * segment fails that, or where the shape turns back by more than 90°. Each pass gives its nearest point.
 */
export function passesNear(shape: RouteShape, p: LngLat, from: number, to: number): Pass[];
export function pointAlong(shape: RouteShape, along: number): LngLat;
/** The shape's own vertices strictly between two distances. */
export function verticesBetween(shape: RouteShape, from: number, to: number): LngLat[];
export function distanceMetres(a: LngLat, b: LngLat): number;
export function bearingBetween(a: LngLat, b: LngLat): number;
```

### One path per vehicle

The load-bearing decision is that each vehicle has exactly one geometric record, `path`, and each point on it has exactly one time, `at`. The model's pose is the path sampled at `now`. The trail is the same path handed to TripsLayer with `at` as timestamps. Points behind `now` are the trail. Points ahead of it are where the model goes next, up to the newest fix, about 35 s of road. TripsLayer draws only points whose time has passed, so the part ahead stays invisible until the model gets there. Pose and trail head come from the same points and the same times, so the head can't drift from the model, around bends included (per model-the-domain).

There is no clock state. The playback rules are evaluated once per segment, at ingest, and written down as `at` stamps. Nothing is re-stamped later. That removes M1's rule that a frame must run before a read (per make-operations-idempotent). Calling `frame` twice, or never, changes no pose, no trail time and no `info` answer. The only state `frame` touches is the z sweep's progress and the z values it re-samples.

This deletes M1's `Tween`, `startTween`, `drawnAt()`, the gap-based duration, `MIN_TWEEN_MS` and `SNAP_GAP_MS`. It also deletes `speedMps`, because the speed cap needs a length and a duration, not a speed. `motion.ts` goes away. `bearingBetween` and the metre offset move to `route.ts`, next to the shape math that shares them (per redesign-from-first-principles, subtract-before-you-add).

Access patterns traced through it:

- Frame. A scan back from the path end over the plan ahead to the piece containing `now`. That is a few points in steady state, and dozens of shape vertices after a long freeze, when the plan ahead holds the whole crossing.
- Trail rebuild. One pass over each path, as in M1.
- Ingest. Appends to the path end and prunes from the front. The prune drops a point once the point after it is older than `TRAIL_MS`.
- Pick and info. A lookup by id.

### Playback schedule

Every time is epoch ms on the app's `Clock`, which is `Date.now()` when live and recording time in replay. A run is a stretch of a vehicle's life that the model plays without a break. It starts with the first live report of a new vehicle, the first live report that reaches a hidden one, or a fix whose lag would pass 3 minutes.

The first report `r0` of a run becomes a point at

```
at = max(at of the path's last point, min(arrival, r0.recordedAt + 35 s))
```

`arrival` is `now` for the first report a batch has for that vehicle. The `max` keeps times non-decreasing when a vehicle reappears while its old path still plays, which a capped segment can cause. Every later report of that vehicle in the same batch counts as arrived at the run's first `at`. Reports in any later batch arrive at `now`. So a multi-report first batch is stamped like this:

- An Entur-direct report, recorded a couple of seconds ago, gets `at = now`. The vehicle shows at once.
- A relay snapshot whose oldest report is 5 minutes old starts at that report plus 35 s. The rest of the batch counts as known by then, so it plays on the 35 s schedule and every point before `now` is trail. The model appears 35 s behind, inside its history.
- A batch whose oldest report is under 35 s old starts at `now` and eases in like a single live report.

Each later fix `r` appends one segment from the path's last point. `prev` is the vehicle's previous fix.

```
leaves  = max(at of the path's last point, arrival)
lag     = leaves − prev.recordedAt − 35 s        // > 0 means further behind than 35 s
span    = r.recordedAt − prev.recordedAt
arrives = max(leaves + crossMs(span, lag), leaves + length / SPEED_CAP_MPS[mode])
```

`leaves` is "waits at the newest report". The model can't leave the previous fix before it got there or before the next fix arrived. `crossMs(span, lag)` plays `span` of reports at 1.25x while `lag > 0`, at 0.8x while `lag < 0`, and at 1x once the lag reaches 0.

```
lag > 0:  span <= 5 × lag     ? span / 1.25 : span − lag
lag < 0:  span <= 4 × (−lag)  ? span / 0.8  : span − lag
lag = 0:  span
```

At 1.25x the lag closes by 0.25 s a second, so closing it covers 5 × lag of reports. At 0.8x it closes by 0.2 s a second and covers 4 × (−lag). Both branches that close the lag land at `r.recordedAt + 35 s`, exactly on target. In steady state a report lands before the model needs it, the lag is 0, and the model reaches every fix at its `recordedAt + 35 s`.

The second term of `arrives` is the speed cap, applied to the drawn travel time. Whatever the schedule says, the model never covers `length` metres faster than the cap. The cap only slows the model, it never lets it run ahead of its schedule.

When `lag` is over `MAX_LAG_MS`, 3 minutes, the fix starts a new run instead of a segment. The model jumps to the fix at `max(last at, min(arrival, r.recordedAt + 35 s))`, which is `now` for a live report, and eases in from there. The trail keeps a straight piece across the gap, as after a silence. Without this, a position stuck for 10 minutes would leave the model about 450 s over its target even after the 1.25x crossing, and at 0.25 s a second that takes about half an hour to close.

Every point of the segment gets an `at` proportional to its distance between `leaves` and `arrives`, so the model moves at constant speed within the segment. A segment where the lag closes partway moves at its average rate. When the model waits (`leaves` later than the last point's `at`), a hold point goes in first. It repeats the last position, stamped `leaves`. Without it TripsLayer would interpolate the trail head along the whole next piece while the model stands.

Worked cases from the spec, with a 10 s report gap and 2 s latency:

- Catch-up. A model that reached its 10 s report at 45 s and waited sees five reports land at 62 s. `lag = 62 − 10 − 35 = 17`, so each 10 s span takes 8 s, reaching the 60 s report at 102 s. Lags of 7, 5, 3 and 1 s follow, and the 100 s report is reached at 135 s, back on target.
- Ease-in. A fresh vehicle shows at 2 s, stands at its first report until the second lands at 12 s, then plays at 0.8x with `lag = −23`. It reaches report k at 12 + 12.5k s and is back on the 35 s delay at the 100 s report, at 135 s, about 2 minutes after it appeared.

Real gaps aren't regular. Bergen's are p50 10 s and p90 31 s. Right after a wait, the model reaches the next fix 1.25 gaps plus latency after that fix was recorded, so a gap more than 1.25 times the one before runs it dry again. A cold-start replay of the Bergen capture measured what that costs against standing still at the first report until it is 35 s old (see Evidence). Easing in gave each moving vehicle 0.23 more stops of 3 s or more after its first move, but it stood 19 s at its first report instead of 32 s. Over the first 3 minutes after load, both rules gave 2.4 stops per moving vehicle, and easing in stood 30.1% of the time against 34.7%. Ease-in stays.

### Building the path at ingest

`ingest` sorts the batch, groups it by vehicle, and drops reports no newer than the vehicle's `latest`. Then it handles each vehicle once.

1. For each report in order:
   - New or hidden. An ended report only refreshes `latest`, and the store drops it when it doesn't know the vehicle. It never starts a run and never adds a point, so a bus driving to the depot after its journey ends draws nothing. A live report starts a run, stamped as above. If its journey's shape is ready, the store projects the point onto the shape (see Snapping) and starts the cursor there. The cursor is cleared otherwise.
   - Visible. `latest = r`. An ended report after an ended report adds nothing. A position exactly equal to `fix.position` is a freeze, no fix, and adds nothing, but it still keeps a frozen vehicle alive. Otherwise the store appends a segment, as below. The first ended report of a run is still a fix, so the model drives to the terminus.
2. Prune the front of the path.
3. If the vehicle is visible at `now`, ask for the shape of its newest report's journey (see Shapes). History journeys and vehicles hidden on arrival ask for nothing.
4. Forget vehicles silent for `STALE_MS + TRAIL_MS`, evict shapes no vehicle names, and bump `version` if a read could see a change. An ended report that only refreshes a hidden vehicle's `latest` bumps nothing.

A segment from the path's last point to report `r` on journey `j`:

- Cursor. With `j`'s shape ready, the store uses the vehicle's cursor if it is on `j`. With no cursor on `j`, it projects the previous fix over the whole shape and starts the cursor there. That covers a fix that landed while the shape was pending and a journey change, in one rule.
- Geometry. The segment glides when the cursor belongs to the previous fix (`cursor.recordedAt === fix.recordedAt`) and `r` falls inside the forward window. The glide is the shape's vertices from the cursor to `r`'s distance along, plus `r`'s point on the shape. If the previous point was drawn off the shape, because its shape was pending, the glide starts with a short connector onto the shape. A glide longer along the shape than twice its chord plus 50 m goes straight instead, because that much detour means the cursor sits on the wrong pass. In every other case the segment is one straight step to `r`'s drawn position.
- Times. As in the playback schedule.

### Snapping

The store snaps a fix onto its shape in one of three ways.

- Forward window. The window is `[cursor − 15 m, cursor + cap × (r.recordedAt − cursor.recordedAt) + 40 m]`. The store takes the earliest pass inside it, then the nearest point in that pass. A result behind the cursor is clamped to the cursor, so jitter up to 15 m backwards becomes a stop and the glide never reverses. Earliest-pass is what fixes the spike's bus 400. Once the cursor is past the tip of a spur, the outbound pass lies behind the window and the return pass is the earliest candidate. When both lanes of a spur lie inside the window, the earlier one wins even if the later one is nearer.
- Whole shape, no cursor. This is the run start, the lazy projection of the previous fix, and a report whose previous fix is off the shape. The store takes the earliest pass whose heading at the candidate is within 90° of the report's bearing, and the earliest pass when the bearing is null or no pass matches. A run that starts on the return leg of a spur with a southbound bearing starts on the southbound pass. With a null bearing it may start on the outbound one. The detour guard then turns the next step straight, so the model doesn't drive out to the tip and back.
- Miss. For a fix outside the window the store searches the whole shape, and the pass nearest the cursor's distance wins. A hit puts the fix on the shape there and re-seeds the cursor, but the step goes straight. This covers backwards by more than 15 m and a lost cursor. No hit means the fix is off the shape. The store draws it at its raw position and keeps the cursor, so the next on-shape fix still searches forward from the last good distance, with a reach that has grown with time. That fix also goes straight, because the cursor doesn't belong to the fix before it.

A journey change uses the same rules. The store drops the old journey's cursor and projects the previous fix over the new shape. For a journey that begins at its terminus, the earliest matching pass is the start of the route. If the previous fix is within 40 m of the new shape, the step glides along the new shape. If not, the step goes straight and the next one glides.

### Worked tunnel example

This is the spike's bus 5 at the Løvstakk tunnel, and the spec's 2-minute freeze. The bus reports its last fix at 10 s, which the model reaches at 45 s. It reports the same position until 120 s, then reports 2 km further on at 130 s, received at 132 s.

- From 45 s to 132 s the model stands at the tunnel mouth. There is no fix to go to. The frozen reports keep the vehicle alive.
- At 132 s, `leaves = 132`, `lag = 132 − 10 − 35 = 87`, `span = 120`. Since 120 <= 5 × 87, the schedule plays the span at 1.25x, 96 s. The cap allows 2000 m / 25 m/s = 80 s. `arrives = max(228, 212) = 228`.
- The bus drives through the tunnel at 20.8 m/s and comes out at 228 s. That is 98 s behind its report, 63 s over the 35 s target. Its next fix, 100 m further at 140 s, takes 8 s at 1.25x and is reached at 236 s, 61 s over the target. The lag keeps closing at 0.25 s a second, so the vehicle is back on the 35 s delay after about 4 more minutes, at no point faster than the cap.

For this freeze the 1.25x limit, not the cap, sets the crossing time. The cap decides when a freeze ends far away relative to its length. A 60 s freeze that ends 2 km on (fix at 70 s, received at 72 s) has `lag = 27`, and the schedule says 48 s at 41.7 m/s. The cap stretches that to 80 s, so the bus comes out at 152 s instead of 120 s. A freeze shorter than about 33 s needs no wait at all, because the fix after it arrives before the model reaches the mouth. The bus then glides across the whole freeze at its schedule, slowed only if the cap binds.

How often the model stands at a mouth, measured on the Bergen capture (123 vehicles, 5098 fix-to-fix spans). There were 190 exact-repeat freezes in 80 vehicles. Their span from the last fix to the next one was p50 18 s, p90 81 s and p99 176 s, and 55 of them (29%) ran over 33 s. In 57 (30%) the next fix landed after a model on schedule would reach the frozen fix, so the model stood at the mouth, for p50 29 s and at most 145 s. The 19 freezes whose next fix lay 1 km or more away, most likely tunnels, all stood, with a span of p50 116 s. The longest freeze ran 178 s and 3.6 km and left 145 s of lag, under the 3-minute limit, so it glides. A freeze of 10 minutes passes the limit, and the model jumps to the fix after it.

### Shapes

The store owns the shape cache, `Map<JourneyId, ShapeEntry>`. There is one way for a shape to enter, the injected lookup.

- Request. After each ingest, the store asks for the journey of each visible vehicle's newest report. It calls `shapeOf(journey)` when the journey has no entry, or when an `asked` entry is older than its wait. The wait is 30 s after the first ask, then 60 s, 120 s and so on, doubling up to 10 minutes. The new entry is `asked` with `requestedAt = now` and one more attempt. Two vehicles on one journey, repeated reports, and reports during the flight all share one call. Retry is driven by reports, so the store needs no timers.
- Settle. The callbacks only write the entry. A shape becomes `ready`, prepared into local metres once. Null or fewer than two points becomes `none`. A rejection writes nothing, so the entry stays `asked` and the store asks again after its wait. A lookup that never settles is the same case, so it needs no rule of its own. A callback writes only if the entry is still the same object, so the store drops a late answer for an evicted journey, or for a journey it has asked again since. Settling changes no visible state, so it bumps nothing and needs no callback to the app.
- Use. A segment glides only with a `ready` shape at the moment it is built. A shape that lands before the vehicle's next report loses nothing, because the store projects the previous fix when it builds the next segment. A first batch with several reports is different. The store builds every one of its segments in that one ingest, before any shape can land, so a first batch draws straight. Entur-direct first batches are almost always one report, so today this costs little. The M4 relay snapshot sends about 5 minutes of history per vehicle, and all of it would draw straight (see Open questions).
- Evict. After each ingest, the store drops entries for journeys that no known vehicle's newest report names. The cache is bounded by the number of live vehicles. A vehicle whose reports alternate between naming a journey and naming none makes its entry flap. That is harmless, because a re-ask is one cheap alias in a batched POST.

Many journeys share one pattern. The cache keys by journey and accepts duplicate polylines, because the journey-to-pattern step costs a request either way and the duplicates are bounded by live vehicles. `shapes.ts` can add a pattern-level cache inside itself if bytes ever matter, and the store wouldn't notice.

M4 rewrites `shapes.ts` to ask the relay, keeping the `ShapeLookup` signature. Nothing else changes (per boundary-discipline).

### Async failure modes

| Case | What the user sees | Who handles it |
|---|---|---|
| Pending | Straight steps until the shape lands. The next segment after it lands glides, from the previous fix projected onto it. | The store. A missing shape is the straight fallback. |
| Arrives late | Steps already built stay straight, so nothing pops. Segments built after it glide. A multi-report first batch is all built before any shape lands, so all of it stays straight. | The store, through lazy projection of the previous fix |
| Fails | Same as pending. The store asks again on a later report, 30 s after the request, then doubling up to 10 minutes. | The store's `asked` entry |
| Never settles | Same as fails. `shapes.ts` aborts after 10 s anyway. | The store's `asked` entry |
| No shape | Straight steps for that journey while the store keeps its entry. A legal steady state, not an error. | The store's `none` entry |
| Wrong pass or bad report | A fix off the shape, or more than 15 m backwards, is one straight step, and the next fix goes straight too. A run that starts on the wrong pass goes straight when the glide would detour, then searches forward from the fix it reached, which is on the right pass. A cursor stuck behind on a spur after a long freeze can still pick the outbound pass inside a grown window, and only the detour guard stops that drawing a U-turn. | The store |

### Bearing

The model faces the way it travels along its path. Each path point stores the heading of the piece arriving at it. The pose eases from the previous heading to the current piece's heading over its first `TURN_M`. A stopped vehicle keeps its last heading. The reported bearing does two jobs. It seeds the heading of a run that hasn't moved yet, and it picks the pass for a whole-shape projection. Reported bearings are 35 s ahead of the drawn model, so using them for a moving model would turn it before the bend. PLAN's "a null bearing keeps the previous bearing" becomes "a stopped model keeps its last heading".

### Stale rule and visibility

`isStale` is still one function, applied at read time. A vehicle is hidden when `now − latest.recordedAt > STALE_MS`, the silence half and unchanged, or when `latest.journeyEnded` and `now` has reached the `at` of the path's last point, the ended half. The store stores no hide time. It derives it. A live report after an ended one makes `latest` live again, so the vehicle plays on without hiding first. A frozen ended report adds no point, so the vehicle hides when the model reaches the frozen position. The thresholds are M1's. Only the moment the ended half applies moves to when the model reaches the end. Hiding on the newest report would remove the model 35 s before it reaches the terminus, while its trail kept drawing toward it.

`info` returns null exactly when `frame` hides the vehicle. The app's memo re-reads `info` only when `version` bumps, so the card closes on the first ingest after the model disappears, not at that frame. Bergen's feed sends about 1.6 batches a second (975 in the 10-minute capture), so that is within about a second.

A live report that arrives for a hidden vehicle starts a new run at that report. The model appears there and the trail keeps a faint straight segment across the gap, as in M1. A vehicle silent for `STALE_MS + TRAIL_MS` is forgotten, trail and all.

### Info card

`info` reads `latest`, the newest report, never the drawn position. The card's line, destination and delay are therefore "now", while the model is 35 s behind. `Journey` keeps its M1 shape, so an operator that reports a line without a service journey still gets its card.

### Terrain z

Unchanged in mechanism. Each new path point samples its own z, falling back to the previous point's z. `terrainChanged()` bumps an epoch in O(1). `frame` sweeps vehicles behind it round-robin within 2 ms, re-sampling every path point, and only a full sweep of a vehicle marks it current. A null sample keeps the old z. The trigger is `sourcedata` on the terrain source, not `idle`. Paths now hold shape vertices as well as reports, so a full sweep covers more points than in M1.

### Feeding deck.gl and Solid

Unchanged. `frame(now)` is the only read for layers and returns `{ poses, trails }`. `poses` is a fresh array each frame. `trails` keeps its reference until a path gains or loses a point, a z changes, or a vehicle is forgotten. `trails` includes hidden vehicles so their trails fade out. Seconds since page load for TripsLayer's float32 timestamps remain a `vehicleLayers.ts` concern. The store never imports Solid. `version` and `selected` are the only two signals.

### Interface depth

The public surface is M1's four methods and one getter, plus one injected function in the constructor. Behind it sit ordering and dedupe, the playback schedule with its wait, catch-up, ease-in and lag limit, the speed cap, hold points, the shape cache with dedupe, backoff and eviction, forward-window projection with the off-shape, backwards, jitter and detour rules, bearing-picked passes, lazy projection across pending shapes and journey changes, freeze detection, travel heading, hiding at the end of playback, pruning, forgetting, and budgeted z. Callers never coordinate shape arrival, playback or projection. The layers and the source don't change beyond one parsed field. `VehicleState`, `PathPoint`, `Cursor`, `ShapeEntry`, `crossMs` and `route.ts` are private to `vehicles/`.

### Deliberately not done

- No playback clock state. The schedule is written into `at` stamps once per segment.
- No rebuild of unplayed segments when a shape lands late. Today it matters only for a multi-report first batch. M4's relay snapshot makes it matter more (see Open questions).
- No dead reckoning into a tunnel. During a long freeze the model stands at the mouth until the next fix arrives.
- No pattern-level cache, no Viterbi matching, and no per-line shape prefetch.
- No `reported` position or time on `VehicleInfo`. No consumer reads it yet.
- No timers or per-frame state in the store, and no reactive store.

### Evidence for this sketch

Measured on 2026-11-01 with a throwaway implementation of this sketch, outside the repo, revised for the interrogate round.

- All 62 tests in `store.test.ts` pass. `tsc --noEmit` under the repo's tsconfig exits 0 for the whole project, with `App.tsx`, `source.ts` and the replay script updated to the new types. Against M1's `store.ts` and `types.ts` the spec is red, as expected, because it targets the new types.
- 58 single-rule mutations of that implementation each fail at least one test. The first 30 are the previous round's: a 20 s delay, 1x catch-up, 1x ease-in, standing still until 35 s old, nearest-point projection with and without earliest-pass, no earliest-pass, the first point instead of the nearest in a pass, frozen reports as fixes, the cap judged on report-time speed, the cap as a rate on the span, no cap, 30 m and 60 m off-shape thresholds, 0 m and 30 m backward grace, no jitter clamp, no hold point, hiding ended vehicles at the newest report, no lookup dedupe, retry at half the wait, no retry, no lazy projection of the previous fix, reusing the old journey's cursor across a journey change, gliding after an off-shape fix, a first batch that waits for `now`, no restart for a hidden vehicle, frozen reports that don't refresh `latest`, no trail prune, and info from the drawn journey. The 28 added this round are: an ended report that starts a run on a hidden vehicle, an ended report to a hidden vehicle that bumps `version`, later ended reports that append, an end-hide that waits for the ended report's own 35 s, asking for every report's journey, asking for hidden and unknown vehicles, a seed that ignores the bearing, bearing tolerances of 45° and 135°, passes that don't split where the shape turns back, a miss that takes the bearing seed instead of the pass nearest the cursor, a miss drawn at the raw report, no detour guard, a 3x guard, a guard without its 50 m slack, a 2-minute lag limit, no lag limit, a wait that doesn't double, a wait with no 10-minute cap, a 15 s first wait, a rejection that means no shape for good, a late answer written to a dropped entry, no eviction, no run-start snap, turning over 20 m, turning at once, a run start that ignores the end of the old path, and a trail that thins points which keep the previous heading. None survived the first run of the full table.
- A cold-start replay of the Sunday Bergen capture (2026-10-25, 10 minutes, about 120 vehicles) through the real source and store compared the two rules for a vehicle's first report. Each of 8 page loads, 0 to 420 s into the capture and 60 s apart, used a fresh store and shape cache, so the first batch was the subscribe burst. A load after the capture's start got each vehicle's newest record so far as its burst. Frames ran at 1000/60 ms, 10,800 per 3-minute window. Journeys came from the spike's Viterbi pattern match, because the capture has no service journey, and every lookup answered after 500 ms. Over 935 vehicle-loads, 709 of them moving (more than 200 m in the window):

  | Rule | Stops of 3 s or more per moving vehicle | Of which after the first move | Time standing | First stand | Largest step between frames |
  |---|---|---|---|---|---|
  | Ease in at 0.8x (chosen) | 2.42 | 1.40 | 30.1% | 19.2 s | 0.418 m (bus), 0.502 m (coach) |
  | Stand until 35 s old | 2.40 | 1.17 | 34.7% | 32.2 s | 0.418 m (bus), 0.502 m (coach) |
  | Every report known up front | 1.58 | 1.11 | 19.8% | | 0.418 m (bus), 0.502 m (coach) |

  The last row is a store fed the whole capture as one history batch, so it never waits. Its stops are real dwells, the floor for both rules. Easing in stood less at all 8 loads, by 3.4 to 5.8 points. The stop counts differ by 0.02 per vehicle, while the per-load difference ranged from −0.12 to +0.11, so they are the same. The first stand limits the gap. The standing rule pays 35 s minus latency once per vehicle. Ease-in pays one report gap plus latency, and can then run dry when a gap runs over 1.25 times the one before. The largest step is the speed cap, 25 m/s and 30 m/s at 60 fps, under every rule. With no shapes, or lookups answering after 5 s, standing moved by at most 1.3 points and the ease-in lead held. The limits are one 10-minute capture, overlapping windows that are not independent samples, a synthetic burst for loads after the first, and a Viterbi pattern standing in for the service journey.
- Replaying the whole capture with the chosen rule, no vehicle moved more than 5 m between frames. With a 2-minute lag limit, 4 did, up to 3.7 km, one per freeze over 2 minutes of lag.
- A replay of the Sunday Norway capture (1219 ids, 10 minutes, no shapes), two runs, took 0.147 to 0.153 ms per `frame()` at p50 and 0.167 to 0.173 ms at p95. Frames that rebuilt trails took 0.501 to 0.511 ms at p50, 0.589 ms at p95 and 1.17 ms at most, over 37,226 trail points. The replay's oracle counted 981 visible vehicles against the store's 982, because the oracle still hides an ended vehicle at its newest report. Shape vertices will multiply trail points in cities, by a factor not yet measured.

## Synthesis decision

Two runners produced candidates. Candidate 1 (Opus) started from a store that owns shape loading through an injected lookup. Candidate 2 (Sonnet) started from a synchronous store that takes shapes through `setShape` and lists the journeys it still needs through `wanted(now)`, with fetching in a `withShapes` wrapper around the source.

Both runners arrived at the same core on their own. Each vehicle has one timed path that is both its trail and its motion, stamped once at ingest, and `frame` only samples it. Both deleted `Tween` outright and let the model face its direction of travel. That agreement was the strongest signal of the arena.

The cross-judge (Sonnet) and I both picked candidate 1 as the base. It kept M1's public surface and added one constructor argument. It defined every lookup outcome inside the store, and M4 rewrites only `shapes.ts`. Candidate 2 needed a caller-driven protocol and a change to the `VehicleSource` type in M4. The judge scored candidate 2 higher on redesign quality, and these grafts came from it:

- **No clock state.** Candidate 1 stored a per-vehicle clock anchor and gave each point two times. Candidate 2's closed-form schedule, evaluated once per segment, replaced both with one `at` per point. Candidate 1's 0.8x ease-in survives as the negative-lag half of the same `crossMs`, so a fresh vehicle needs no seeding rule of its own.
- **Hold points.** A wait writes a point at the moment the model leaves, so the trail head stays under a standing model.
- **`journeyId` on the report.** `Journey` keeps its M1 shape, so an operator without a service journey keeps its card.
- **Lazy projection of the previous fix.** This replaced candidate 1's three-state snap and covers a pending shape and a journey change with one rule.
- **The async failure-mode table and four tests.** These are the 35 m on-shape case, the per-mode cap, trail pruning and the parallel-lane spur.

Rejected from candidate 2: hiding an ended vehicle at its newest report (the model vanished 35 s before the terminus while its trail kept drawing), `setShape` with `wanted`, and a `reported` position on `VehicleInfo`, which has no reader yet. The judge also said candidate 2's cap let the spike's 2-minute freeze escape. The mutation run showed otherwise. That form matches the travel-time cap whenever the lag is zero or positive, and it lost on clarity, as Alternatives says.

Verification is listed under Evidence above. I re-ran the 41 tests, `tsc` and all 30 mutations myself on 2026-11-01, and none of the mutations survived.

### Interrogate round

Two reviewers, Opus and Sonnet, attacked this design adversarially, and both found the same two bugs on their own. Repeated ended reports after hiding started new runs, and the store built a multi-report first batch before any shape could land, which the doc had called lossless. The fold-in derives the end-hide from `latest` instead of storing `hideAt`, and states the first-batch cost with an open question for M4. It also picks a whole-shape pass by the reported bearing, adds a detour guard and a 3-minute lag limit, merges `pending` and `failed` into one `asked` entry with a doubling wait, asks only for visible vehicles' newest journeys, and makes every test ingest only reports from its past. The ease-in rule and the freeze share were measured instead of argued. The spec grew to 62 tests and the mutation table to 58, with no survivors.

## Tradeoffs accepted

- We accept every vehicle shown 35 s late in exchange for no stop-start and smooth curves. The info card stays on the newest report.
- We accept a model standing at a tunnel mouth for most of a long freeze, then driving through at up to 1.25x or the cap, in exchange for no guessing and a fixed delay. In the Bergen capture the model stood at the mouth in 30% of exact-repeat freezes, at most 145 s. After the spike's 2-minute freeze it comes out 63 s over the target and needs about 4 minutes to get back to 35 s.
- We accept that a fix more than 3 minutes behind starts a new run, so after a freeze that long the model jumps to the fix instead of driving there. None of the 190 freezes in the Bergen capture got there. The price of the limit is up to 12 minutes of catching up after a 3-minute lag.
- We accept constant speed within a segment. A segment where the lag closes partway moves at its average rate, in exchange for points stamped once and no clock state.
- We accept that the store decides a segment once, when its end report arrives. A shape that lands after the next report costs one straight segment, and a shape that lands after a multi-report first batch costs that whole batch.
- We accept a start-up ease-in, where a fresh vehicle runs 2 to 35 s behind for about 2 minutes and waits at its first report until the second lands, in exchange for a map that moves within seconds of loading. Measured, it adds 0.23 stops of 3 s or more per moving vehicle in the first 3 minutes and still stands less than waiting for the full delay.
- We accept that departure from a frozen position is set by when the next fix arrives. An operator that reports identical coordinates while dwelling at a stop would see its departures start late and catch up.
- We accept that the silence rule can hide a model mid-road. A capped segment can still be playing when the newest report turns 2 minutes old, and the model then disappears before it arrives. It needs a capped crossing and a silence after it, which is rare.
- We accept that the forward window keeps growing after a long freeze or a run of off-shape fixes. Earliest-pass then decides more of the projection, and a long freeze on a spur can pick the outbound pass. The detour guard turns that into a straight step instead of a U-turn.
- We accept that the detour guard also straightens a real loop the vehicle drove between two reports when the loop is longer than twice the chord plus 50 m. At Bergen's 10 s p50 gap a bus covers about 100 m, so only a long gap around a turning loop hits it.
- We accept duplicate polylines for journeys that share a pattern, in exchange for one cache key and no pattern step in the store.
- We accept more path points per vehicle (shape vertices), so trail rebuilds and z sweeps cost more than in M1.
- We accept that reported bearings no longer steer a moving model.
- We accept that `route.ts` and `shapes.ts` can be imported from outside `vehicles/`. A `no-restricted-imports` rule closes that gap if it matters.

## Alternatives considered

- **Caller-coordinated shapes**, with `store.wantedShapes()` and `store.setShape(journey, shape)`. The store stays synchronous, but the app learns which journeys are pending, dedupes and retries them, and keeps failure memory outside the store. That is a shallow two-method protocol, and the relay would need a second path in. Rejected for an injected lookup the store owns end to end.
- **The source resolves shapes before emitting**, with reports carrying their shape. The store stays simple, but each journey's first report waits on a fetch, the source gains a cache and a second remote, and playback sees reports late. Rejected.
- **A stored playback clock per vehicle**, an anchor moved at ingest with a closed-form playhead read at `frame`. It reads closest to PLAN's wording, but each point then has two times, a report-clock time and a wall time derived from it, and the bound and seeding need their own rules. Rejected for one `at` per point.
- **A frame-integrated playhead**, as in the spike prototype (`tau += dt × rate`). Its state depends on frame cadence, `info` and `frame` could disagree, and it brings back tick-then-read. Rejected.
- **The cap as a rate on the span**, `rate = min(1.25, cap × span / length)`. Whenever the lag is 0 or positive it gives the same arrival as capping the travel time, which the mutation run confirmed. Only the ease-in test tells them apart. It lost because it needs a rate-dependent `crossMs` and has no stated meaning at negative lag, where capping the travel time stays one `max`.
- **Stand still at the first report until it is 35 s old**, instead of easing in. One fewer rate, the model is on the full delay from its first move, and the relay's history makes it moot in M4. Measured over the first 3 minutes after 8 cold loads of the Bergen capture, it gave the same 2.4 stops of 3 s or more per moving vehicle and stood 34.7% of the time against ease-in's 30.1%. Its first stand averaged 32.2 s against 19.2 s. Rejected for the extra standing at load.
- **A 2-minute lag limit**, as review first proposed. The longest freeze in the Bergen capture left 145 s of lag, and 4 freezes passed 2 minutes. In the replay each of those jumped, up to 3.7 km. Rejected for 3 minutes, which made none jump.
- **A longer delay to cover freezes.** Freezes ran up to 3 minutes, which would put every vehicle 3 minutes behind. PLAN chose the speed cap.

## Decided at sign-off (2026-11-03)

The open questions from the interrogate round were settled with the recommended option each time.

- **Speed caps.** Keep bus 25, coach 30, ferry 20, train 70 and other 25 m/s for now. The M5 implementation replays the Bergen capture with shapes and reports the 99th percentile segment speed by mode. Each cap is then set just above its mode's p99.
- **Long freezes stand at the tunnel mouth.** M5 does not dead-reckon into tunnels. It would need a rule for a fix that lands behind the guess, and it would creep at stops that repeat their coordinates. It goes to PLAN.md's "For later", to revisit after watching M5 on live data.
- **M4 relay history draws straight.** The relay sending shapes ahead of the snapshot can't fix this on its own, because the store asks for a shape only after the ingest that names it. M4 instead has the store re-plan a run's segments when that run's shape lands. That bends "stamped once" for one case, and M4 designs the exact rule.
- **Clock skew.** M5 does not estimate a clock offset. The M5 live check logs the median and p99 of `now − recordedAt` at ingest. The store gets an offset estimate only if the median is more than 5 s from the spike's 2 s.
- **Trail cost with shape vertices.** This is a gate for M2. Before dropping the bounding box, M2 measures trail rebuild time for all of Norway with shapes. If rebuilds pass 2 ms at p95, it thins trail points behind `now` and keeps hold points and corners. The 2 ms is a starting threshold, not a measured one.
- **Journey Planner start-up burst.** `shapes.ts` sends at most 50 aliases per POST and one POST at a time. These are starting values. Tune them if Entur answers 429 or a batch takes over 2 s.

## Settled earlier and still true

- A trail survives a long silence. A hidden vehicle's trail fades out on its own. The 9 to 11 crossfade zoom is tuned by eye in M2 (sign-off, 2026-10-25).
- The parser prefixes `vehicleId` with the codespace, because each operator picks its own ids (implementation, 2026-10-25).
- `setProps` repaints the map on its own, so the frame loop doesn't call `map.triggerRepaint()`. The cost is a full map repaint every frame (M1, measured in headless Chromium on ANGLE Vulkan).
- `queryTerrainElevation` takes 0.4 to 1.2 µs a call, so the 2 ms z budget covers about 1,700 to 4,600 queries a frame (M1, measured).
- `store.frame` took under 0.1 ms at p95 for 110 Bergen vehicles in M1, and 0.4 ms right after `terrainChanged()`.

## Measured in M5 (2026-11-03)

The implementation passes the unchanged spec, 62 of 62, with `tsc --noEmit` clean.

- **Speed caps stay at the sign-off values.** A replay of the Sunday Bergen capture with Viterbi-matched shapes and the caps lifted gave a bus p99 segment speed of 26.1 m/s over 4685 segments. Every faster segment was a freeze or tunnel crossing, up to 2155 m in 10.4 s. Setting the bus cap just above that p99 is blocked by the spec. The 145 s freeze test assumes the cap binds on a 3600 m crossing whose schedule takes 142.4 s, so the bus cap must stay at or below 25.28 m/s. At 25 m/s the cap binds on 44 of 4679 bus segments (0.9%). Coach, ferry and train each had a single vehicle in the capture, so their p99 is one sample's maximum and calibrates nothing. They keep 30, 20 and 70 m/s. Raising the bus cap means changing that test first.
- **Clock skew needs no offset.** In the live check at zoom 15 over Bergen, `now − recordedAt` at ingest was median 2.25 s and p99 6.45 s over 2230 reports, once the first 10 s of subscribe burst had passed. The median is within 5 s of the spike's 2 s, so the store gets no offset estimate.
- **Live behaviour.** Every one of 3083 live reports named a service journey. Journey Planner answered 22 POSTs, the start-up burst as 6, 50, 50, 50 and 28 aliases, one at a time, all 200 at p50 88 ms and at most 174 ms. Over three 5 s windows at 60 fps, with 180 to 187 vehicles visible, no model moved more than 0.5 m between frames. The page logged no console errors.
- **Replay oracle.** The oracle now hides an ended vehicle at playback time. On the Norway capture it counts 982 visible, the same as the store, where the old oracle counted 981.
