// The store's rules as an executable spec. Times are epoch ms, distances are metres.
// The numbers come from PLAN.md (Motion, Shapes, M5), SPIKES.md (route-shape glide) and the
// schedule in docs/vehicle-store.md. A point's time is `at`, the wall time the drawn model is there:
//
//   first point of a run   at      = min(now, recordedAt + 35 s)
//   every later fix        leaves  = max(at of the path's last point, arrival)
//                          lag     = leaves - previous fix's recordedAt - 35 s
//                          arrives = max(leaves + crossMs(span, lag), leaves + length / cap)
//
// crossMs plays the report span at 1.25x while lag > 0 and 0.8x while lag < 0, then 1x once lag is 0.
// Every report in a vehicle's first batch counts as arrived at that batch's first `at`. A fix whose
// lag would pass 3 minutes starts a new run instead, like a vehicle that reappears.
import { describe, expect, it } from "vitest";
import {
  SPEED_CAP_MPS,
  STALE_MS,
  TRAIL_MS,
  VehicleStore,
  type ElevationAt,
  type Frame,
  type TrailPath,
} from "./store";
import type { Journey, JourneyId, LngLat, ShapeLookup, VehicleId, VehicleReport } from "./types";

/** Each vehicle's playback runs 35 s behind real time (PLAN.md). */
const DELAY = 35_000;
/** Reports land p50 2 s after they were recorded (SPIKES.md). */
const LATENCY = 2_000;

const V1 = "SKY:1" as VehicleId;
const V2 = "SKY:2" as VehicleId;
const V3 = "SKY:3" as VehicleId;
const J1 = "SKY:ServiceJourney:1" as JourneyId;
const J2 = "SKY:ServiceJourney:2" as JourneyId;
const J3 = "SKY:ServiceJourney:3" as JourneyId;

// Positions are written as metres east and north of a point in Bergen.
const LNG0 = 5.32;
const LAT0 = 60.39;
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number): LngLat => [LNG0 + x / M_PER_DEG_LNG, LAT0 + y / M_PER_DEG_LAT];
const xy = (p: readonly number[]): [number, number] => [(p[0] - LNG0) * M_PER_DEG_LNG, (p[1] - LAT0) * M_PER_DEG_LAT];

type Metres = [x: number, y: number][];
const LINE: Metres = [[0, 0], [3000, 0]];
/** East 200 m, then north 200 m. The corner is 200 m along. */
const L: Metres = [[0, 0], [200, 0], [200, 200]];
/** East, north, west, 200 m each. Corners at 200 m and 400 m along. */
const U: Metres = [[0, 0], [200, 0], [200, 200], [0, 200]];
/**
 * Out to a tip at 400 m along and back on the same road, like Bergen's line 400 near Loddefjord.
 * A point (200, y) is 200 + y along northbound and 600 - y along southbound, on the way back.
 */
const SPUR: Metres = [[0, 0], [200, 0], [200, 200], [200, 0], [0, 0]];
/** East 150 m, north 30 m, back west 150 m: a turning loop narrower than OFF_SHAPE_M, so one pass. */
const TURN: Metres = [[0, 0], [150, 0], [150, 30], [0, 30]];
/**
 * Out 500 m east and 300 m north, 6 m across, then back south on a lane 6 m east of the outbound one.
 * The turning point is 800 m along. A point (506, y) on the way back is 806 + 300 - y along.
 */
const LANES: Metres = [[0, 0], [500, 0], [500, 300], [506, 300], [506, 0]];

const card = (line = "3"): Journey => ({ line, destination: "Sentrum", delaySeconds: 0 });
function report(over: Partial<VehicleReport> = {}): VehicleReport {
  return { id: V1, recordedAt: 0, position: ll(0, 0), bearing: 90, journeyEnded: false, mode: "bus", journey: null, journeyId: null, ...over };
}
/** V1 at `t` seconds, at (x, y) metres, on service journey `j` (null for none). */
const at = (t: number, x: number, y: number, j: JourneyId | null = J1, over: Partial<VehicleReport> = {}) =>
  report({ recordedAt: t * 1000, position: ll(x, y), journeyId: j, journey: card(), ...over });

/** Lets every settled shape lookup reach the store. One real zero-delay macrotask, no fake timers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A shape lookup with no network. By default it answers at once from `table` (null for a journey
 * it doesn't know). With `manual`, every call stays pending until the test resolves or rejects it.
 */
function fakeShapes(table: [JourneyId, Metres | null][] = [], manual = false) {
  const shapes = new Map(table);
  const calls: JourneyId[] = [];
  const waiting = new Map<JourneyId, { resolve: (s: readonly LngLat[] | null) => void; reject: (e: Error) => void }>();
  const toLngLat = (m: Metres | null | undefined) => (m ? m.map(([x, y]) => ll(x, y)) : null);
  const lookup: ShapeLookup = (j) => {
    calls.push(j);
    if (!manual) return Promise.resolve(toLngLat(shapes.get(j)));
    return new Promise((resolve, reject) => waiting.set(j, { resolve, reject }));
  };
  return {
    lookup,
    calls,
    async resolve(j: JourneyId, shape: Metres | null) {
      waiting.get(j)!.resolve(toLngLat(shape));
      await settle();
    },
    async reject(j: JourneyId) {
      waiting.get(j)!.reject(new Error("journey planner unreachable"));
      await settle();
    },
  };
}

const newStore = (shapes = fakeShapes(), elevationAt: ElevationAt = () => 0) =>
  new VehicleStore({ elevationAt, shapeOf: shapes.lookup });

/**
 * Receives `first` alone at first.recordedAt + 35 s and lets its shape lookup settle. The rest of the
 * reports recorded by then arrive at that same moment, and each later one at its own recordedAt + 2 s,
 * so no ingest sees a report from its future. The first point gets at = min(now, recordedAt + 35 s),
 * exactly 35 s behind, which is also when the rest count as arrived. A report gap under 35 - 2 = 33 s
 * then lands before the model needs it, so lag stays 0 and the model reaches each fix at its
 * recordedAt + 35 s, unless a cap makes it late.
 */
async function receive(s: VehicleStore, [first, ...rest]: VehicleReport[]) {
  const now = first.recordedAt + DELAY;
  s.ingest([first], now);
  await settle();
  const known = rest.filter((r) => r.recordedAt <= now);
  if (known.length > 0) s.ingest(known, now);
  for (const r of rest.filter((r) => r.recordedAt > now)) s.ingest([r], r.recordedAt + LATENCY);
}

const poseAt = (s: VehicleStore, now: number, id = V1) => s.frame(now).poses.find((p) => p.id === id);
const trailOf = (f: Frame, id = V1) => f.trails.find((t) => t.id === id)!;

function expectAt(s: VehicleStore, now: number, x: number, y: number, id = V1) {
  const pose = poseAt(s, now, id);
  expect(pose, `a pose at ${now}`).toBeDefined();
  const [px, py] = xy(pose!.position);
  expect(px, `x at ${now}`).toBeCloseTo(x, 0);
  expect(py, `y at ${now}`).toBeCloseTo(y, 0);
}

/** Metres from p to the nearest point of a shape. */
function offShape(p: readonly number[], shape: Metres): number {
  const [px, py] = xy(p);
  let best = Infinity;
  for (let i = 1; i < shape.length; i++) {
    const [ax, ay] = shape[i - 1];
    const [bx, by] = shape[i];
    const [vx, vy] = [bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
    best = Math.min(best, Math.hypot(ax + vx * t - px, ay + vy * t - py));
  }
  return best;
}

/** The trail's distinct positions in whole metres, consecutive repeats dropped. */
function knots(trail: TrailPath): Metres {
  const out: Metres = [];
  for (const p of trail.path) {
    const [x, y] = xy(p).map(Math.round);
    const last = out.at(-1);
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  return out;
}

/** Where TripsLayer draws the head of a trail at `now`: linear in time between stamped points. */
function trailHead({ path, times }: TrailPath, now: number): readonly number[] {
  let i = 0;
  while (i + 1 < times.length && times[i + 1] <= now) i++;
  if (i + 1 === times.length || times[i] > now) return path[i];
  const f = (now - times[i]) / (times[i + 1] - times[i]);
  return path[i].map((v, k) => v + (path[i + 1][k] - v) * f);
}

/** Every 250 ms from `from` to `to`, the trail head TripsLayer would draw sits under the model. */
function expectHeadUnderModel(s: VehicleStore, from: number, to: number) {
  for (let now = from; now <= to; now += 250) {
    const f = s.frame(now);
    const [hx, hy] = xy(trailHead(trailOf(f), now));
    const [px, py] = xy(f.poses.find((p) => p.id === V1)!.position);
    expect(Math.hypot(hx - px, hy - py), `head at ${now}`).toBeLessThan(0.5);
  }
}

/** Largest move between poses one second apart, in metres. */
function fastestSecond(s: VehicleStore, from: number, to: number): number {
  let fastest = 0;
  let [prev] = xy(poseAt(s, from)!.position);
  for (let now = from + 1_000; now <= to; now += 1_000) {
    const [x] = xy(poseAt(s, now)!.position);
    fastest = Math.max(fastest, Math.abs(x - prev));
    prev = x;
  }
  return fastest;
}

describe("reports", () => {
  it("upserts by vehicleId", () => {
    const s = newStore();
    s.ingest([report(), report({ recordedAt: 5_000, position: ll(50, 0) })], 6_000);
    expect(s.frame(6_000).poses).toHaveLength(1);
  });

  it("ignores a repeated batch", () => {
    const s = newStore();
    s.ingest([report()], 1_000);
    const v = s.version;
    s.ingest([report()], 2_000);
    expect(s.version).toBe(v);
  });

  it("drops a report older than the newest one", () => {
    const s = newStore();
    s.ingest([at(10, 100, 0, null)], 12_000);
    const v = s.version;
    s.ingest([at(0, 0, 0, null)], 13_000);
    expect(s.version).toBe(v);
  });
});

describe("playback clock", () => {
  it("draws a vehicle 35 s behind its reports", async () => {
    const s = newStore();
    await receive(s, [0, 10, 20].map((t) => at(t, t * 10, 0, null)));
    expectAt(s, 40_000, 50, 0); // report time 40 - 35 = 5 s, at 10 m/s
    expectAt(s, 50_000, 150, 0); // report time 15 s
  });

  it("waits at the newest report, then catches up at 1.25x until it is 35 s behind again", async () => {
    const s = newStore();
    const east = (t: number) => at(t, t * 10, 0, null);
    await receive(s, [east(0), east(10)]);
    // It reaches the 10 s report at 45 s and the next report hasn't arrived.
    expectAt(s, 50_000, 100, 0);
    s.ingest([20, 30, 40, 50, 60].map(east), 62_000);
    // leaves = 62 s, lag = 62 - 10 - 35 = 17 s. Each 10 s span then takes 10 / 1.25 = 8 s while lag > 0.
    expectAt(s, 62_000, 100, 0); // the model leaves when the report arrives, not before
    expectAt(s, 66_000, 150, 0); // 4 s at 12.5 m/s
    expectAt(s, 70_000, 200, 0);
    for (let t = 70; t <= 120; t += 10) s.ingest([east(t)], t * 1000 + LATENCY);
    // Reached at 102 (60 s), 110 (70 s, lag 7), 118 (80 s, lag 5), 126 (90 s, lag 3).
    expectAt(s, 126_000, 900, 0);
    // From 90 s, lag 1: 5 s of span closes it in 4 s, the other 5 s take 5 s. 126 + 9 = 135 = 100 + 35.
    expectAt(s, 135_000, 1000, 0);
    s.ingest([east(130)], 132_000);
    expectAt(s, 145_000, 1100, 0); // 1x from there: 110 + 35
  });

  it("shows a new vehicle at once and eases it back to 35 s behind at 0.8x", () => {
    const s = newStore();
    const send = (t: number) => s.ingest([at(t, t * 10, 0, null)], t * 1000 + LATENCY);
    send(0);
    expectAt(s, 2_000, 0, 0); // at = min(2, 0 + 35) = 2 s
    send(10);
    // leaves = 12 s, lag = 12 - 0 - 35 = -23 s, so 0.8x: each 10 s span takes 12.5 s.
    expectAt(s, 7_000, 0, 0); // it stood at its first report until the second one arrived
    expectAt(s, 17_000, 40, 0); // 0.8 × 5 s = 4 s
    for (let t = 20; t <= 130; t += 10) send(t);
    // Reaches report k at 12 + 12.5k with lag 2.5k - 23, so the 90 s report at 124.5 s with lag -0.5.
    expectAt(s, 124_500, 900, 0);
    // From 90 s: 2 s of span closes the lag in 2.5 s, the other 8 s take 8 s. 124.5 + 10.5 = 135 = 100 + 35.
    expectAt(s, 135_000, 1000, 0);
    expectAt(s, 137_000, 1020, 0); // 1x from there: 102 s
  });

  it("turns a history batch into trail and starts playback 35 s behind inside it", () => {
    const s = newStore();
    s.ingest([at(20, 200, 0, null), at(0, 0, 0, null), at(10, 100, 0, null)], 50_000);
    // First at = min(50, 0 + 35) = 35. The batch counts as arrived then, so lag is 0 and each fix is
    // reached at recordedAt + 35. 50 - 35 = 15 s, halfway from the 10 s report to the 20 s one.
    expectAt(s, 50_000, 150, 0);
    const trail = trailOf(s.frame(50_000));
    expect(knots(trail)).toEqual([[0, 0], [100, 0], [200, 0]]);
    expect(trail.times).toEqual([35_000, 45_000, 55_000]);
  });

  it("shows a first batch younger than 35 s at once and eases it in", () => {
    const s = newStore();
    s.ingest([at(20, 200, 0, null), at(0, 0, 0, null), at(10, 100, 0, null)], 25_000);
    // First at = min(25, 0 + 35) = 25. 10 s report: lag = 25 - 0 - 35 = -10, 10 / 0.8 = 12.5 s, at 37.5.
    // 20 s report: lag = 37.5 - 10 - 35 = -7.5, another 12.5 s, at 50.
    expectAt(s, 25_000, 0, 0);
    expect(trailOf(s.frame(25_000)).times).toEqual([25_000, 37_500, 50_000]);
  });

  it("restarts playback where a hidden vehicle reappears, and keeps its trail", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(5, 50, 0, null)]);
    // Silent for 195 s, longer than STALE_MS, so the vehicle was hidden. at = min(202, 200 + 35) = 202.
    s.ingest([at(200, 500, 0, null)], 202_000);
    expectAt(s, 202_000, 500, 0);
    expect(knots(trailOf(s.frame(202_000)))).toEqual([[0, 0], [50, 0], [500, 0]]);
  });

  it("starts a reappearing vehicle's new run no earlier than the end of its old path", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null)]);
    s.ingest([at(70, 6100, 0, null)], 72_000);
    // leaves = 72, lag = 72 - 10 - 35 = 27, so 1.25x says 60 / 1.25 = 48 s. The cap says 6000 / 25 = 240 s,
    // so the model reaches 6100 m at 312 s. Silent after its 70 s report, it is hidden from 190 s, mid-road.
    expect(poseAt(s, 200_000)).toBeUndefined();
    s.ingest([at(200, 6500, 0, null)], 202_000);
    // The new run starts at max(312, min(202, 200 + 35)) = 312, so the old path still plays until then.
    expectAt(s, 250_000, 100 + SPEED_CAP_MPS.bus * (250 - 72), 0); // 4550 m
    expectAt(s, 312_000, 6500, 0);
  });
});

describe("gliding along the route shape", () => {
  it("glides along the shape around a bend at constant speed", async () => {
    const s = newStore(fakeShapes([[J1, L]]));
    // 100 m along to 300 m along in 20 s. Straight across, the midpoint would be (150, 50).
    await receive(s, [at(0, 100, 0), at(20, 200, 100)]);
    expectAt(s, 40_000, 150, 0); // 5 s, 150 m along
    expectAt(s, 45_000, 200, 0); // 10 s is the corner
    expectAt(s, 50_000, 200, 50); // 15 s, 250 m along
    for (let now = 35_000; now <= 55_000; now += 500) expect(offShape(poseAt(s, now)!.position, L)).toBeLessThan(1);
  });

  it("snaps the first report of a run onto a shape that is already known", async () => {
    const s = newStore(fakeShapes([[J1, LINE]]));
    s.ingest([at(0, 0, 0, J1, { id: V2 })], 2_000); // V2 on the same journey brings the shape in
    await settle();
    s.ingest([at(10, 500, 20, J1)], 12_000);
    expectAt(s, 12_000, 500, 0); // drawn on the road, 20 m south of the report
  });

  it("stays on the shape for a report 35 m off it, inside the 40 m limit", async () => {
    const s = newStore(fakeShapes([[J1, LINE]]));
    await receive(s, [at(0, 0, 0), at(30, 300, 35)]);
    expectAt(s, 50_000, 150, 0); // 15 s, halfway along the road. The chord would be 17.5 m north.
    expectAt(s, 65_000, 300, 0); // arrives snapped onto the road
  });

  it("snaps to the nearest point of the pass, not the first segment within 40 m", async () => {
    const s = newStore(fakeShapes([[J1, L]]));
    // (190, 30) is 30 m from the eastbound leg at 190 m along and 10 m from the northbound leg at 230 m.
    // Both legs are one pass, so the nearer one wins. 100 m to 230 m along in 20 s is 6.5 m/s.
    await receive(s, [at(0, 100, 0), at(20, 190, 30)]);
    expectAt(s, 45_000, 165, 0); // 10 s, 165 m along. The first segment would put it at 145 m.
    expectAt(s, 55_000, 200, 30);
  });

  it("falls back to a straight line around a report 50 m off the shape, then glides again", async () => {
    const s = newStore(fakeShapes([[J1, U]]));
    // (150, 50) is 50 m from the nearest leg. Both report pairs that touch it go straight.
    await receive(s, [at(0, 100, 0), at(10, 150, 50), at(20, 200, 100), at(40, 100, 200)]);
    expectAt(s, 40_000, 125, 25); // 5 s, straight midpoint of (100, 0) and (150, 50)
    expectAt(s, 50_000, 175, 75); // 15 s, straight midpoint of (150, 50) and (200, 100)
    expectAt(s, 65_000, 200, 200); // 30 s, back on the shape at the corner 400 m along
  });

  it("falls back to a straight line when a report projects 20 m backwards, past the 15 m grace", async () => {
    const s = newStore(fakeShapes([[J1, LINE]]));
    // 1000 m along, 1100 m, then 1080 m. A clamp would hold it at 1100.
    await receive(s, [at(0, 1000, 0), at(10, 1100, 0), at(20, 1080, 0)]);
    expectAt(s, 50_000, 1090, 0); // 15 s, halfway back along the straight line
    expectAt(s, 55_000, 1080, 0);
  });

  it("puts a report that misses the window onto the shape when it lies within 40 m of it", async () => {
    const s = newStore(fakeShapes([[J1, LINE]]));
    // (1070, 25) projects 30 m behind the 1100 m cursor, outside the window, so the whole shape is
    // searched. It is 25 m off the road, inside 40 m, so the straight step ends on the road.
    await receive(s, [at(0, 1000, 0), at(10, 1100, 0), at(20, 1070, 25)]);
    expectAt(s, 50_000, 1085, 0);
    expectAt(s, 55_000, 1070, 0);
  });

  it("takes the pass nearest the cursor when a report misses the window", async () => {
    const s = newStore(fakeShapes([[J1, SPUR]]));
    // Southbound at (200, 100), 500 m along. (200, 130) is 30 m back: 470 m on this pass, 330 m on the
    // outbound one, and the window starts at 485. The nearer pass keeps the cursor at 470, so the next
    // fix, (100, 0) at 700 m, glides 230 m round the corner. From 330 m it would glide 370 m via the tip.
    await receive(s, [at(0, 200, 100, J1, { bearing: 180 }), at(10, 200, 130, J1, { bearing: null }), at(30, 100, 0, J1, { bearing: 270 })]);
    expectAt(s, 50_000, 200, 72.5); // 5 of 20 s: 470 + 57.5 = 527.5 m along. Via the tip it would be (200, 177.5).
    expectAt(s, 65_000, 100, 0);
  });

  it("clamps a step back of up to 15 m into a stop, then moves on from where it stopped", async () => {
    const s = newStore(fakeShapes([[J1, L]]));
    // 100 m along, 150 m, then GPS jitter 10 m back to 140 m, then 260 m.
    await receive(s, [at(0, 100, 0), at(10, 150, 0), at(20, 140, 0), at(30, 200, 60)]);
    let x = -Infinity;
    for (let now = 45_000; now <= 55_000; now += 500) {
      const [px] = xy(poseAt(s, now)!.position);
      expect(px).toBeGreaterThanOrEqual(x - 0.01);
      x = px;
    }
    expectAt(s, 50_000, 150, 0);
    expectAt(s, 55_000, 150, 0);
    expectAt(s, 60_000, 200, 5); // 25 s is halfway from 150 m to 260 m along, 205 m, just past the corner
  });

  it("projects forward on an out-and-back spur instead of snapping to the outbound pass", async () => {
    const s = newStore(fakeShapes([[J1, SPUR]]));
    // 100 m along, the tip at 400 m, 500 m on the way back, then 700 m. Nearest-point projection puts
    // (200, 100) at 300 m and (100, 0) at 100 m, both on the outbound pass and behind the vehicle.
    await receive(s, [at(0, 100, 0), at(30, 200, 200), at(40, 200, 100), at(60, 100, 0)]);
    expectAt(s, 80_000, 200, 50); // 45 s: 550 m along, southbound on the way back
    expectAt(s, 85_000, 200, 0); // 50 s: 600 m along, the corner. Straight would be at (150, 50).
    expectAt(s, 95_000, 100, 0);
  });

  it("projects past a parallel return lane that nearest-point would pick", async () => {
    const s = newStore(fakeShapes([[J1, LANES]]));
    // (500, 250) is 750 m along. (502, 150) is 2 m from the outbound lane at 650 m, behind the window that
    // starts at 750 - 15 = 735, and 4 m from the return lane at 806 + 150 = 956 m. 206 m in 20 s.
    await receive(s, [at(0, 500, 250), at(20, 502, 150)]);
    expectAt(s, 40_000, 501.5, 300); // 5 s: 750 + 206 / 4 = 801.5 m, across the turning point
    expectAt(s, 55_000, 506, 150); // snapped onto the return lane
  });

  it("takes the earliest pass when both lanes of a spur lie in the forward window", async () => {
    const s = newStore(fakeShapes([[J1, LANES]]));
    // (500, 100) is 600 m along. 20 s later the window reaches 600 + 25 × 20 + 40 = 1140 m. (504, 200) is
    // 4 m from the outbound lane at 700 m and 2 m from the return lane at 806 + 100 = 906 m. Earliest wins.
    await receive(s, [at(0, 500, 100), at(20, 504, 200)]);
    expectAt(s, 45_000, 500, 150); // 10 s, 650 m along. The return lane would put it at 753 m, (500, 253).
    expectAt(s, 55_000, 500, 200);
  });

  it("starts a run on the pass its reported bearing points along", async () => {
    const s = newStore(fakeShapes([[J1, SPUR]]));
    // (200, 100) is 300 m along northbound and 500 m along southbound. A bearing of 120° is 60° off the
    // southbound pass and 120° off the northbound one, so the run starts at 500. (100, 0) is then 700 m
    // along, 200 m in 20 s round the corner at 600 m.
    await receive(s, [at(0, 200, 100, J1, { bearing: 120 }), at(20, 100, 0, J1, { bearing: 270 })]);
    expectAt(s, 40_000, 200, 50); // 5 s, 550 m along
    expectAt(s, 45_000, 200, 0); // 10 s, the corner. Straight across it would be at (150, 50).
  });

  it("goes straight rather than drawing a detour when a run without a bearing starts on the wrong pass", async () => {
    const s = newStore(fakeShapes([[J1, SPUR]]));
    // With no bearing the run starts on the earliest pass, northbound at 300 m. The next fix is 700 m
    // along: 400 m via the tip for a 141 m chord, more than 2 × 141 + 50 = 333 m, so the step goes straight.
    await receive(s, [at(0, 200, 100, J1, { bearing: null }), at(20, 100, 0, J1, { bearing: null })]);
    for (let now = 35_000; now <= 55_000; now += 500) expect(xy(poseAt(s, now)!.position)[1]).toBeLessThanOrEqual(100.5);
    expectAt(s, 45_000, 150, 50);
  });

  it("goes straight when the glide along the shape is over twice the chord plus 50 m", async () => {
    const s = newStore(fakeShapes([[J1, U]]));
    // (0, 0) to (0, 200) is 600 m along U for a 200 m chord, and 600 > 2 × 200 + 50 = 450.
    await receive(s, [at(0, 0, 0), at(30, 0, 200)]);
    expectAt(s, 50_000, 0, 100); // 15 s, the straight midpoint. Along U it would be at (200, 100).
  });

  it("glides round a tight turn whose detour stays within the 50 m slack", async () => {
    const s = newStore(fakeShapes([[J1, TURN]]));
    // (130, 0) to (130, 30) is 130 m to 200 m along, 70 m for a 30 m chord. 70 > 2 × 30 but 70 <= 2 × 30 + 50.
    await receive(s, [at(0, 130, 0), at(10, 130, 30)]);
    expectAt(s, 40_000, 150, 15); // 5 s, 165 m along. Straight would be at (130, 15).
  });

  it("draws straight while the shape is pending and glides from the next report once it has arrived", async () => {
    const shapes = fakeShapes([], true);
    const s = newStore(shapes);
    s.ingest([at(0, 100, 0)], 35_000);
    s.ingest([at(20, 200, 100)], 35_000);
    expectAt(s, 45_000, 150, 50); // 10 s, straight midpoint while the shape isn't known yet
    await shapes.resolve(J1, U);
    s.ingest([at(40, 100, 200)], 50_000);
    // The 20 s fix is projected now, at 300 m along. To 500 m from 55 s to 75 s puts it at the corner
    // 400 m along at 65 s. Straight across, it would be at (150, 150).
    expectAt(s, 65_000, 200, 200);
    expect(shapes.calls).toEqual([J1]);
  });

  it("draws a first batch straight when its shape lands after the batch", async () => {
    const shapes = fakeShapes([], true);
    const s = newStore(shapes);
    // One history batch at 45 s: every segment is built at that ingest, before the shape exists.
    s.ingest([at(0, 100, 0), at(20, 200, 100), at(40, 100, 200)], 45_000);
    await shapes.resolve(J1, U);
    // First at = min(45, 0 + 35) = 35, so the 20 s and 40 s fixes are reached at 55 s and 75 s.
    expectAt(s, 65_000, 150, 150); // the straight midpoint. Along U it would be at the corner (200, 200).
  });

  it("glides on the new journey's shape across a journey change, from where the old fix sits on it", async () => {
    // On J1 the 10 s fix is 1000 m along. On J2 it is 100 m along, and the next fix is 300 m along.
    const s = newStore(fakeShapes([[J1, [[-900, 0], [3000, 0]]], [J2, L]]));
    s.ingest([at(0, 0, 0, J1), at(0, 0, 0, J2, { id: V2 })], 35_000);
    await settle();
    s.ingest([at(10, 100, 0, J1), at(30, 200, 100, J2)], 35_000);
    expectAt(s, 55_000, 200, 0); // 20 s, the corner 200 m along J2. Straight would be (150, 50).
    expect(knots(trailOf(s.frame(65_000)))).toEqual([[0, 0], [100, 0], [200, 0], [200, 100]]);
  });

  it("steps straight across a journey change when the old fix is off the new shape, then glides again", async () => {
    // J2 runs north 150 m from (1000, 0), then east. V2 on J2 brings its shape in.
    const s = newStore(fakeShapes([[J1, [[0, 0], [1000, 0]]], [J2, [[1000, 0], [1000, 150], [1150, 150]]]]));
    s.ingest([at(0, 500, 0, J1), at(0, 1000, 0, J2, { id: V2 })], 35_000);
    await settle();
    s.ingest([at(30, 900, 0, J1)], 35_000);
    // (900, 0) is 100 m from J2's shape, so the step to (1000, 100), 100 m along J2, goes straight.
    s.ingest([at(40, 1000, 100, J2)], 42_000);
    // The next fix is 250 m along J2. From 100 m it glides 150 m round the corner at 150 m.
    s.ingest([at(50, 1100, 150, J2)], 52_000);
    expectAt(s, 70_000, 950, 50); // halfway between the fixes reached at 65 s and 75 s
    expectAt(s, 80_000, 1025, 150); // 5 of 10 s: 175 m along J2. Straight would be at (1050, 125).
    // (500, 0), (900, 0), (1000, 100), the corner (1000, 150), and (1100, 150).
    expect(trailOf(s.frame(85_000)).path).toHaveLength(5);
  });

  it("faces along the shape around a bend and keeps that heading when it stops", async () => {
    const s = newStore(fakeShapes([[J1, L]]));
    // Reported bearings say north, nothing, then south. Once it moves the model faces where it drives.
    // The third report repeats the second position exactly, so it stands still.
    await receive(s, [at(0, 100, 0, J1, { bearing: 0 }), at(20, 200, 100, J1, { bearing: null }), at(30, 200, 100, J1, { bearing: 180 })]);
    expect(poseAt(s, 40_000)!.bearing).toBeCloseTo(90, 0); // 150 m along, heading east
    expect(poseAt(s, 50_000)!.bearing).toBeCloseTo(0, 0); // 250 m along, 50 m up the northbound leg
    expect(poseAt(s, 60_000)!.bearing).toBeCloseTo(0, 0); // standing at (200, 100)
  });

  it("turns to a new heading over the first 10 m after a corner", async () => {
    const s = newStore(fakeShapes([[J1, L]]));
    // 10 m/s along L, so the corner at 200 m along is passed at 45 s.
    await receive(s, [at(0, 100, 0), at(20, 200, 100)]);
    expect(poseAt(s, 44_500)!.bearing).toBeCloseTo(90, 6);
    expect(poseAt(s, 45_500)!.bearing).toBeCloseTo(45, 6); // 5 of 10 m into the turn from east to north
    expect(poseAt(s, 46_000)!.bearing).toBeCloseTo(0, 6);
  });

  it("faces its reported bearing until it first moves", () => {
    const s = newStore();
    s.ingest([at(0, 0, 0, null, { bearing: 45 })], 2_000);
    expect(poseAt(s, 2_000)!.bearing).toBe(45);
  });
});

describe("shape lookups", () => {
  it("asks once per journey, however many vehicles and reports share it", async () => {
    const shapes = fakeShapes([], true);
    const s = newStore(shapes);
    s.ingest([at(0, 0, 0, J1), at(0, 0, 0, J1, { id: V2 })], 1_000);
    s.ingest([at(10, 100, 0, J1)], 11_000);
    expect(shapes.calls).toEqual([J1]); // in flight
    await shapes.resolve(J1, L);
    s.ingest([at(10, 100, 0, J1, { id: V2 })], 12_000);
    expect(shapes.calls).toEqual([J1]); // cached
    s.ingest([at(20, 200, 0, J2)], 21_000);
    await shapes.resolve(J2, null);
    s.ingest([at(30, 200, 100, J2)], 31_000);
    expect(shapes.calls).toEqual([J1, J2]); // a journey without a shape isn't asked again
  });

  it("retries a failed lookup after 30 s, doubling the wait each time up to 10 minutes", async () => {
    const shapes = fakeShapes([], true);
    const s = newStore(shapes);
    // A report recorded 2 s before each ingest keeps the vehicle visible, and only a visible vehicle asks.
    const send = (now: number) => s.ingest([at((now - LATENCY) / 1000, 0, 0, J3)], now);
    let asked = 1_000;
    send(asked);
    await shapes.reject(J3);
    for (const wait of [30, 60, 120, 240, 480, 600, 600]) {
      const calls = shapes.calls.length;
      send(asked + wait * 1000 - 1);
      expect(shapes.calls, `not yet, ${wait} s after the last ask`).toHaveLength(calls);
      asked += wait * 1000;
      send(asked);
      expect(shapes.calls, `asked again ${wait} s after the last ask`).toHaveLength(calls + 1);
      await shapes.reject(J3);
    }
  });

  it("asks again for a lookup that never answers, after the same 30 s", () => {
    const shapes = fakeShapes([], true);
    const s = newStore(shapes);
    s.ingest([at(0, 0, 0, J3)], 2_000);
    s.ingest([at(31, 100, 0, J3)], 32_000);
    expect(shapes.calls).toEqual([J3, J3]);
  });

  it("asks only for the newest journey of a visible vehicle", () => {
    const shapes = fakeShapes([], true);
    const s = newStore(shapes);
    s.ingest([at(0, 0, 0, J1), at(10, 100, 0, J2)], 35_000); // a history batch that changes journey
    s.ingest([at(0, 0, 0, J3, { id: V2 })], 200_000); // recorded 200 s ago, hidden at once by the silence rule
    s.ingest([at(199, 0, 0, J3, { id: V3, journeyEnded: true })], 200_000); // ended, so no run starts
    expect(shapes.calls).toEqual([J2]);
  });

  it("drops a shape no vehicle names any more, and ignores its late answer", async () => {
    const shapes = fakeShapes([], true);
    const s = newStore(shapes);
    s.ingest([at(0, 0, 0, J1)], 1_000);
    s.ingest([at(10, 100, 0, J2)], 11_000); // V1 moves on to J2, so nothing names J1
    await shapes.resolve(J1, LINE); // the answer for J1 lands after its entry was dropped
    s.ingest([at(20, 200, 0, J1)], 21_000);
    // Asked again 20 s after the first ask, well inside the 30 s wait, because J1 had no entry left.
    expect(shapes.calls).toEqual([J1, J2, J1]);
  });
});

describe("tunnel freezes", () => {
  it("glides across a short freeze from the last fix to the next one", async () => {
    const s = newStore(fakeShapes([[J1, LINE]]));
    // The 20 s report repeats the 10 s position exactly, so it is no fix. The glide runs 100 m to 400 m from 10 s to 30 s.
    await receive(s, [at(0, 0, 0), at(10, 100, 0), at(20, 100, 0), at(30, 400, 0)]);
    expectAt(s, 55_000, 250, 0); // 20 s, halfway across instead of standing at 100 m
  });

  it("keeps a frozen vehicle visible while its reports keep coming", () => {
    const s = newStore();
    for (let t = 0; t <= 180; t += 30) s.ingest([at(t, 1000, 0, null)], t * 1000 + LATENCY);
    // The newest report is 10 s old. The first one is 190 s old, past STALE_MS.
    expect(s.frame(190_000).poses).toHaveLength(1);
  });

  it("crosses the spike's 2-minute freeze without jumping and arrives late", async () => {
    const s = newStore(fakeShapes([[J1, LINE]]));
    await receive(s, [at(0, 0, 0), at(10, 100, 0), at(20, 100, 0), at(30, 100, 0)]);
    const frozen = (t: number) => s.ingest([at(t, 100, 0)], t * 1000 + LATENCY);
    for (let t = 40; t <= 90; t += 10) frozen(t);
    expectAt(s, 100_000, 100, 0); // it reached the last fix at 45 s and has nowhere to go
    for (let t = 100; t <= 120; t += 10) frozen(t);
    s.ingest([at(130, 2100, 0)], 132_000);
    s.ingest([at(140, 2200, 0)], 142_000);
    // 2 km after the tunnel. leaves = 132, lag = 132 - 10 - 35 = 87, span 120 s <= 5 × 87, so 1.25x:
    // 120 / 1.25 = 96 s. The cap allows 2000 / 25 = 80 s, so the schedule decides: arrives 228, 63 s late.
    expectAt(s, 132_000, 100, 0);
    expectAt(s, 180_000, 1100, 0); // 48 of 96 s
    expectAt(s, 228_000, 2100, 0);
    expect(fastestSecond(s, 132_000, 228_000)).toBeLessThanOrEqual(SPEED_CAP_MPS.bus + 0.01);
    // Next 100 m: leaves 228, lag = 228 - 130 - 35 = 63, 10 / 1.25 = 8 s. 236 is 61 s late, down from 63.
    expectAt(s, 236_000, 2200, 0);
  });

  it("glides across the longest freeze in the Bergen capture, 145 s of lag, without starting over", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null)]);
    for (let t = 20; t <= 180; t += 10) s.ingest([at(t, 100, 0, null)], t * 1000 + LATENCY);
    s.ingest([at(188, 3700, 0, null)], 190_000);
    // leaves = 190, lag = 190 - 10 - 35 = 145 s, under the 3-minute limit. 1.25x says 178 / 1.25 = 142.4 s,
    // the cap says 3600 / 25 = 144 s, so it arrives at 334 s.
    expectAt(s, 190_000, 100, 0); // still at the tunnel mouth
    // Reports after the tunnel keep it from going silent. None is needed before 334 s.
    for (let t = 198; t <= 328; t += 10) s.ingest([at(t, 3700 + (t - 188) * 10, 0, null)], t * 1000 + LATENCY);
    expectAt(s, 262_000, 100 + SPEED_CAP_MPS.bus * 72, 0); // 1900 m
    expectAt(s, 334_000, 3700, 0);
  });

  it("starts over at the next fix after a 10-minute freeze instead of trailing it by minutes", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null)]);
    for (let t = 20; t <= 600; t += 10) s.ingest([at(t, 100, 0, null)], t * 1000 + LATENCY);
    expectAt(s, 611_000, 100, 0);
    s.ingest([at(610, 600, 0, null)], 612_000);
    // lag = 612 - 10 - 35 = 567 s, over 3 minutes, so a new run starts at max(45, min(612, 610 + 35)) = 612.
    expectAt(s, 612_000, 600, 0);
    s.ingest([at(620, 700, 0, null)], 622_000);
    // Then it eases in like a new vehicle: leaves 622, lag 622 - 610 - 35 = -23, 10 / 0.8 = 12.5 s.
    expectAt(s, 628_250, 650, 0);
    expectAt(s, 634_500, 700, 0);
    // The trail keeps a straight piece from the tunnel mouth. The (0, 0) point went with the prune:
    // the point after it, at 45 s, is older than 612 - 300 = 312 s.
    expect(knots(trailOf(s.frame(640_000)))).toEqual([[100, 0], [600, 0], [700, 0]]);
  });

  it("arrives late at the speed cap when a freeze ends too far away for the schedule", () => {
    const s = newStore();
    const cap = SPEED_CAP_MPS.bus;
    s.ingest([at(0, 0, 0, null)], DELAY);
    s.ingest([at(10, 100, 0, null)], DELAY);
    for (let t = 20; t <= 60; t += 10) s.ingest([at(t, 100, 0, null)], t * 1000 + LATENCY);
    s.ingest([at(70, 2100, 0, null)], 72_000);
    // leaves = 72, lag = 72 - 10 - 35 = 27, span 60 s <= 5 × 27, so the schedule says 60 / 1.25 = 48 s.
    // The cap says 2000 m / 25 m/s = 80 s, so it arrives at 152 s instead of 120 s.
    expectAt(s, 72_000, 100, 0);
    expectAt(s, 112_000, 100 + cap * 40, 0); // 1100 m
    expectAt(s, 120_000, 100 + cap * 48, 0); // the uncapped arrival time, still on its way at 1300 m
    expectAt(s, 152_000, 2100, 0);
  });

  it("holds the cap while catching up, where 1.25x would pass it", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null)]);
    s.ingest([at(60, 1200, 0, null)], 62_000);
    // 1100 m in 50 s of reports is 22 m/s, under the 25 m/s cap. But leaves = 62, lag = 17, and 1.25x
    // would cross in 40 s at 27.5 m/s. The cap stretches it to 1100 / 25 = 44 s, arriving at 106 s.
    expectAt(s, 84_000, 100 + SPEED_CAP_MPS.bus * 22, 0); // 650 m
    expectAt(s, 102_000, 100 + SPEED_CAP_MPS.bus * 40, 0); // 1100 m, not yet there
    expectAt(s, 106_000, 1200, 0);
  });

  it("only ever slows the model, so a fast segment during ease-in still plays at 0.8x", () => {
    const s = newStore();
    s.ingest([at(0, 0, 0, null)], 2_000);
    s.ingest([at(10, 260, 0, null)], 12_000);
    // 26 m/s of reports. leaves = 12, lag = -23, so 0.8x: 10 / 0.8 = 12.5 s, at 20.8 m/s. The cap would
    // allow 260 / 25 = 10.4 s, but arrives takes the later of the two, 24.5 s.
    expectAt(s, 18_250, 130, 0);
    expectAt(s, 24_500, 260, 0);
  });

  it("gives each mode its own cap, so a train is not slowed to bus speed", () => {
    // 500 m in 10 s is 50 m/s, over the bus cap and under the train cap.
    expect(SPEED_CAP_MPS.bus).toBeLessThan(50);
    expect(SPEED_CAP_MPS.train).toBeGreaterThan(50);
    const s = newStore();
    s.ingest([at(0, 0, 0, null), at(0, 0, 0, null, { id: V2, mode: "train" })], DELAY);
    s.ingest([at(10, 500, 0, null), at(10, 500, 0, null, { id: V2, mode: "train" })], DELAY);
    expectAt(s, 45_000, 500, 0, V2); // on schedule, 10 + 35
    expectAt(s, 45_000, SPEED_CAP_MPS.bus * 10, 0); // the bus covers 250 m in those 10 s
    expectAt(s, (35 + 500 / SPEED_CAP_MPS.bus) * 1000, 500, 0); // and arrives at 55 s
  });
});

describe("visibility and the info card", () => {
  it("hides a vehicle silent for longer than STALE_MS", () => {
    const s = newStore();
    s.ingest([report()], 1_000);
    expect(s.frame(STALE_MS).poses).toHaveLength(1);
    expect(s.frame(STALE_MS + 1).poses).toHaveLength(0);
    expect(s.info(V1, STALE_MS + 1)).toBeNull();
  });

  it("hides an ended vehicle when playback reaches the end of its journey, not 35 s early", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null, { journeyEnded: true })]);
    expect(s.frame(40_000).poses).toHaveLength(1); // 5 s, still driving to the terminus
    expect(s.info(V1, 40_000)).not.toBeNull();
    const f = s.frame(45_000); // 10 s, it reaches the ended report
    expect(f.poses).toHaveLength(0);
    expect(s.info(V1, 45_000)).toBeNull();
    expect(f.trails).toHaveLength(1); // the trail stays so it can fade out
  });

  it("shows an ended vehicle again when a live report follows", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null, { journeyEnded: true })]);
    expect(s.frame(50_000).poses).toHaveLength(0);
    // Hidden at 45 s, so the live report starts a new run: at = min(52, 20 + 35) = 52.
    s.ingest([at(20, 200, 0, null)], 52_000);
    expectAt(s, 52_000, 200, 0);
    expect(s.info(V1, 52_000)).not.toBeNull();
  });

  it("keeps an ended vehicle visible when a live report lands before the model reaches the end", () => {
    const s = newStore();
    s.ingest([at(0, 0, 0, null)], 2_000);
    s.ingest([at(10, 100, 0, null, { journeyEnded: true })], 12_000);
    // Ease-in: leaves 12, lag -23, so the ended fix is reached at 12 + 12.5 = 24.5 s. The live report
    // lands at 22 s, before that, and plays on: leaves 24.5, lag 24.5 - 10 - 35 = -20.5, at 0.8x to 37 s.
    s.ingest([at(20, 200, 0, null)], 22_000);
    for (let now = 2_000; now <= 40_000; now += 500) expect(poseAt(s, now), `a pose at ${now}`).toBeDefined();
    expectAt(s, 37_000, 200, 0);
  });

  it("hides an ended vehicle when the model reaches a frozen ended report's position", async () => {
    const s = newStore();
    // The ended report repeats the 10 s position, so it is no fix. The model reaches that position at 45 s.
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null), at(20, 100, 0, null, { journeyEnded: true })]);
    expect(poseAt(s, 44_000)).toBeDefined();
    expect(poseAt(s, 45_000)).toBeUndefined();
  });

  it("ignores ended reports that keep coming after the vehicle is hidden", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null, { journeyEnded: true })]);
    const { times } = trailOf(s.frame(50_000));
    const v = s.version;
    for (let t = 50; t <= 90; t += 10) s.ingest([at(t, 100, 0, null, { journeyEnded: true })], t * 1000 + LATENCY);
    expect(s.version).toBe(v);
    expect(trailOf(s.frame(95_000)).times).toEqual(times);
  });

  it("draws no trail for an ended vehicle driving on to the depot", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null, { journeyEnded: true })]);
    // The 20 s report lands before the model reaches the end at 45 s, the rest after it hides.
    for (let t = 20; t <= 90; t += 10) s.ingest([at(t, t * 10, 0, null, { journeyEnded: true })], t * 1000 + LATENCY);
    for (let now = 45_000; now <= 130_000; now += 5_000) expect(poseAt(s, now), `no pose at ${now}`).toBeUndefined();
    expect(knots(trailOf(s.frame(130_000)))).toEqual([[0, 0], [100, 0]]);
  });

  it("fills the info card from the newest report while the model is 35 s behind", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, J1), at(10, 100, 0, J2, { journey: card("4") })]);
    expectAt(s, 36_000, 10, 0); // 1 s, still on the old journey
    expect(s.info(V1, 36_000)?.journey?.line).toBe("4");
  });
});

describe("trail", () => {
  it("keeps the trail head under the model while a new vehicle eases in", () => {
    const s = newStore();
    const reports = [0, 10, 20, 30].map((t) => at(t, t * 10, 0, null));
    let next = 0;
    let compared = 0;
    for (let now = 2_000; now <= 70_000; now += 500) {
      while (next < reports.length && reports[next].recordedAt + LATENCY <= now) s.ingest([reports[next++]], now);
      const f = s.frame(now);
      const trail = f.trails.find((t) => t.id === V1);
      const pose = f.poses.find((p) => p.id === V1)!;
      if (!trail) continue;
      const [hx, hy] = xy(trailHead(trail, now));
      const [px, py] = xy(pose.position);
      expect(Math.hypot(hx - px, hy - py), `head at ${now}`).toBeLessThan(0.5);
      compared++;
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("keeps the trail head under the model round a bend", async () => {
    const s = newStore(fakeShapes([[J1, L]]));
    await receive(s, [at(0, 100, 0), at(20, 200, 100)]);
    expectHeadUnderModel(s, 35_000, 60_000);
  });

  it("keeps the trail head under the model across a wait and a capped segment", async () => {
    const s = newStore();
    // As in the cap test: it waits at the 10 s fix from 45 s to 62 s, then takes 44 s at the cap.
    await receive(s, [at(0, 0, 0, null), at(10, 100, 0, null)]);
    s.ingest([at(60, 1200, 0, null)], 62_000);
    expectHeadUnderModel(s, 62_000, 110_000);
  });

  it("keeps the trails reference until something changes", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(5, 50, 0, null)]);
    const { trails } = s.frame(35_000);
    expect(s.frame(36_000).trails).toBe(trails);
    s.ingest([at(10, 100, 0, null)], 36_000);
    expect(s.frame(36_000).trails).not.toBe(trails);
  });

  it("re-samples z after terrainChanged, and a null sample keeps the old z", async () => {
    let h: number | null = 0;
    const s = newStore(fakeShapes(), () => h);
    await receive(s, [at(0, 0, 0, null), at(5, 50, 0, null)]);
    const before = s.frame(35_000).trails;
    h = 100;
    s.terrainChanged();
    const after = s.frame(35_000).trails;
    expect(after).not.toBe(before);
    expect(after.find((t) => t.id === V1)!.path.every((p) => p[2] === 100)).toBe(true);
    h = null;
    s.terrainChanged();
    expect(trailOf(s.frame(35_000)).path.every((p) => p[2] === 100)).toBe(true);
  });

  it("drops trail points older than TRAIL_MS", () => {
    const s = newStore();
    for (let k = 0; k <= 40; k++) s.ingest([at(10 * k, 100 * k, 0, null)], 10_000 * k + LATENCY);
    // As in the ease-in test: first point at 2 s, a hold point at 12 s, report k at 12 + 12.5k for k <= 9,
    // then report k at 10k + 35. At the last ingest, 402 s, the cutoff is 402 - 300 = 102 s. Report 7 at
    // 99.5 s is the one point kept before it, because report 8 at 112 s is inside. Reports 7 to 40 are 34 points.
    const { times } = trailOf(s.frame(402_000));
    expect(times).toHaveLength(34);
    expect(times[0]).toBeCloseTo(99_500, 6);
    expect(times[1]).toBeCloseTo(112_000, 6);
    expect(times.at(-1)).toBeCloseTo(435_000, 6);
  });

  it("forgets a vehicle silent for STALE_MS + TRAIL_MS, trail and all", async () => {
    const s = newStore();
    await receive(s, [at(0, 0, 0, null), at(5, 50, 0, null)]);
    expect(s.frame(35_000).trails).toHaveLength(1);
    const late = 6_000 + STALE_MS + TRAIL_MS;
    s.ingest([report({ id: V2, recordedAt: late })], late);
    expect(s.frame(late).trails.filter((t) => t.id === V1)).toHaveLength(0);
  });
});
