import { bearingBetween, distanceMetres, OFF_SHAPE_M, passesNear, pointAlong, prepareShape, verticesBetween, type Pass, type RouteShape } from "./route";
import type { Journey, JourneyId, LngLat, Mode, Position3, ShapeLookup, VehicleId, VehicleReport } from "./types";

/** A report older than this hides the vehicle. */
export const STALE_MS = 3 * 60_000;
/** How long a trail is kept and how long it takes to fade out. The trail layer reads this too. */
export const TRAIL_MS = 5 * 60_000;
/** The first wait before asking again for an unanswered journey. Each later wait doubles, up to 10 minutes. */
export const SHAPE_RETRY_MS = 30_000;
/** The fastest a model is drawn, in metres per wall-clock second. Calibration knob. */
export const SPEED_CAP_MPS: Record<Mode, number> = { bus: 25, coach: 30, ferry: 20, train: 70, other: 25 };

/** A vehicle silent this long is forgotten, trail and all. */
const FORGET_MS = STALE_MS + TRAIL_MS;
/** Per-frame time budget for re-sampling terrain z after tiles load. */
const Z_BUDGET_MS = 2;
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

/** Terrain height in metres at a point, or null while no DEM tile covers it yet. */
export type ElevationAt = (p: LngLat) => number | null;

/** A vehicle as drawn this frame. What the model layer, dot layer and picking see. */
export interface VehiclePose {
  id: VehicleId;
  mode: Mode;
  position: Position3;
  bearing: number;
}

/** `times[i]` is the wall time the drawn model is at `path[i]`. The tail end may lie in the future. */
export interface TrailPath {
  id: VehicleId;
  mode: Mode;
  path: Position3[];
  times: number[];
}

/** Everything the layers need for one frame. */
export interface Frame {
  /** Visible vehicles as drawn now. A fresh array every frame. */
  poses: readonly VehiclePose[];
  /**
   * Trails of every known vehicle, hidden ones included, so they fade out on their own in TripsLayer.
   * Same reference until a trail changes, so deck re-uploads only then.
   */
  trails: readonly TrailPath[];
}

/** What the info card shows. */
export interface VehicleInfo {
  id: VehicleId;
  mode: Mode;
  journey: Journey | null;
}

/** One point the drawn model passes. Behind `now` it is trail, ahead of `now` it is the plan. */
interface PathPoint {
  position: Position3;
  /** Wall time, epoch ms, at which the drawn model is here. Stamped once, at ingest. TripsLayer's timestamp. */
  at: number;
  /** Heading of travel arriving here, degrees. A zero-length step copies the previous one. */
  heading: number;
}

/** The newest fix. Frozen and repeated ended reports aren't fixes. The bearing seeds a lazy projection. */
interface Fix {
  position: LngLat;
  recordedAt: number;
  bearing: number | null;
}

/** Distance along a journey's shape of the newest fix that was on it. Where the forward window starts. */
interface Cursor {
  journey: JourneyId;
  along: number;
  recordedAt: number;
}

interface VehicleState {
  /** The newest report of any kind. Info card, silence check, the ended check, mode. */
  latest: VehicleReport;
  fix: Fix;
  cursor: Cursor | null;
  /** Never empty. Keyed by vehicle only, so a journey change has nothing to reset. */
  path: PathPoint[];
  /** Terrain epoch at which every path point was last sampled. Only the z sweep writes it. */
  zEpoch: number;
}

type ShapeEntry =
  | { state: "asked"; requestedAt: number; attempts: number }
  | { state: "ready"; shape: RouteShape }
  | { state: "none" };

/**
 * Every vehicle the app knows about, and everything derived from them: visibility, pose, trail, info.
 * Plain mutable state outside Solid. Each vehicle has one timed path that is both its trail and its
 * motion, stamped once at ingest, so `frame` and `info` only read it (docs/vehicle-store.md).
 * All times are epoch ms on the app's `Clock`.
 */
export class VehicleStore {
  #vehicles = new Map<VehicleId, VehicleState>();
  /** One entry per journey some known vehicle's newest report names. */
  #shapes = new Map<JourneyId, ShapeEntry>();
  #version = 0;
  #terrainEpoch = 0;
  /** Built lazily, dropped when a path gains or loses a point, a z changes, or a vehicle is forgotten. */
  #trails: readonly TrailPath[] | null = null;
  /** Index into the vehicle map where the next z sweep resumes. */
  #zCursor = 0;
  readonly #elevationAt: ElevationAt;
  readonly #shapeOf: ShapeLookup;

  constructor(deps: { elevationAt: ElevationAt; shapeOf: ShapeLookup }) {
    this.#elevationAt = deps.elevationAt;
    this.#shapeOf = deps.shapeOf;
  }

  /** Bumps on every ingest that changed something a read can see. Solid mirrors it for the info card. */
  get version(): number {
    return this.#version;
  }

  /** Upserts a batch in any order, possibly repeated or historical. Idempotent. Asks for missing shapes. */
  ingest(reports: readonly VehicleReport[], now: number): void {
    const byVehicle = new Map<VehicleId, VehicleReport[]>();
    for (const r of [...reports].sort((a, b) => a.recordedAt - b.recordedAt)) {
      const list = byVehicle.get(r.id) ?? [];
      list.push(r);
      byVehicle.set(r.id, list);
    }
    let changed = false;
    for (const [id, batch] of byVehicle) {
      let v = this.#vehicles.get(id);
      let arrival = now;
      let touched = false;
      for (const r of batch) {
        if (v && r.recordedAt <= v.latest.recordedAt) continue;
        // `arrival`, not `now`: a history batch must not find the vehicle silent at its own older reports.
        if (!v || this.#hidden(v, arrival)) {
          if (r.journeyEnded) {
            if (v) v.latest = r;
            continue;
          }
          v = this.#startRun(id, v, r, arrival);
          arrival = v.path[v.path.length - 1].at;
          touched = true;
          continue;
        }
        touched = true;
        const wasEnded = v.latest.journeyEnded;
        v.latest = r;
        if ((wasEnded && r.journeyEnded) || samePosition(r.position, v.fix.position)) continue;
        const leaves = Math.max(v.path[v.path.length - 1].at, arrival);
        if (leaves - v.fix.recordedAt - DELAY_MS > MAX_LAG_MS) {
          this.#startRun(id, v, r, arrival);
          arrival = v.path[v.path.length - 1].at;
        } else this.#appendSegment(v, r, leaves);
      }
      if (!v || !touched) continue;
      changed = true;
      while (v.path.length > 1 && v.path[1].at < now - TRAIL_MS) v.path.shift();
      if (v.latest.journeyId && !this.#hidden(v, now)) this.#askShape(v.latest.journeyId, now);
    }
    for (const [id, v] of this.#vehicles) {
      if (v.latest.recordedAt < now - FORGET_MS) {
        this.#vehicles.delete(id);
        changed = true;
      }
    }
    const named = new Set<JourneyId>();
    for (const v of this.#vehicles.values()) if (v.latest.journeyId) named.add(v.latest.journeyId);
    for (const j of this.#shapes.keys()) if (!named.has(j)) this.#shapes.delete(j);
    if (changed) {
      this.#version++;
      this.#trails = null;
    }
  }

  /** O(1). `frame` re-samples z within a 2 ms budget. Call on `sourcedata` for the terrain source. */
  terrainChanged(): void {
    this.#terrainEpoch++;
  }

  /** What to draw at `now`. Poses and trail times depend only on `now`. Also runs the budgeted z sweep. */
  frame(now: number): Frame {
    const poses: VehiclePose[] = [];
    for (const [id, v] of this.#vehicles) {
      if (!this.#hidden(v, now)) poses.push({ id, mode: v.latest.mode, ...poseOn(v.path, now) });
    }
    this.#sweepZ();
    this.#trails ??= [...this.#vehicles]
      .filter(([, v]) => v.path.length >= 2)
      .map(([id, v]) => ({ id, mode: v.latest.mode, path: v.path.map((p) => p.position), times: v.path.map((p) => p.at) }));
    return { poses, trails: this.#trails };
  }

  /** The newest report's journey, or null exactly when `frame(now)` hides the vehicle. */
  info(id: VehicleId, now: number): VehicleInfo | null {
    const v = this.#vehicles.get(id);
    return v && !this.#hidden(v, now) ? { id, mode: v.latest.mode, journey: v.latest.journey } : null;
  }

  /** The stale rule. Silent too long, or ended and the model has reached the end of its path. */
  #hidden(v: VehicleState, now: number): boolean {
    return now - v.latest.recordedAt > STALE_MS || (v.latest.journeyEnded && now >= v.path[v.path.length - 1].at);
  }

  #askShape(journey: JourneyId, now: number): void {
    const entry = this.#shapes.get(journey);
    if (entry && (entry.state !== "asked" || now - entry.requestedAt < retryWaitMs(entry.attempts))) return;
    const asked: ShapeEntry = { state: "asked", requestedAt: now, attempts: (entry?.state === "asked" ? entry.attempts : 0) + 1 };
    this.#shapes.set(journey, asked);
    this.#shapeOf(journey).then(
      (points) => {
        if (this.#shapes.get(journey) !== asked) return;
        const shape = points && prepareShape(points);
        this.#shapes.set(journey, shape ? { state: "ready", shape } : { state: "none" });
      },
      () => {},
    );
  }

  #readyShape(journey: JourneyId | null): RouteShape | null {
    const entry = journey && this.#shapes.get(journey);
    return entry && entry.state === "ready" ? entry.shape : null;
  }

  /** Starts a run at `r`: a new vehicle, a hidden one, or a fix whose lag would pass MAX_LAG_MS. */
  #startRun(id: VehicleId, v: VehicleState | undefined, r: VehicleReport, arrival: number): VehicleState {
    const path = v?.path ?? [];
    const last = path.at(-1);
    let drawn = r.position;
    let cursor: Cursor | null = null;
    const shape = this.#readyShape(r.journeyId);
    const seed = shape && pickByBearing(passesNear(shape, r.position, 0, Infinity), r.bearing);
    if (shape && seed && r.journeyId) {
      cursor = { journey: r.journeyId, along: seed.along, recordedAt: r.recordedAt };
      drawn = pointAlong(shape, seed.along);
    }
    path.push({
      position: [drawn[0], drawn[1], this.#elevationAt(drawn) ?? last?.position[2] ?? 0],
      at: Math.max(last?.at ?? -Infinity, Math.min(arrival, r.recordedAt + DELAY_MS)),
      heading: r.bearing ?? last?.heading ?? 0,
    });
    const fix = { position: r.position, recordedAt: r.recordedAt, bearing: r.bearing };
    if (v) {
      v.latest = r;
      v.fix = fix;
      v.cursor = cursor;
      return v;
    }
    const state: VehicleState = { latest: r, fix, cursor, path, zEpoch: -1 };
    this.#vehicles.set(id, state);
    return state;
  }

  /** One segment from the path's last point to fix `r`, leaving at `leaves`. */
  #appendSegment(v: VehicleState, r: VehicleReport, leaves: number): void {
    const last = v.path[v.path.length - 1];
    const { drawn, glide } = this.#snap(v, r);

    const points: LngLat[] = [];
    const cum: number[] = [];
    let prev = flat(last.position);
    let length = 0;
    for (const p of [...glide, drawn]) {
      const d = distanceMetres(prev, p);
      if (d < 1e-3 && p !== drawn) continue;
      length += d;
      points.push(p);
      cum.push(length);
      prev = p;
    }

    const span = r.recordedAt - v.fix.recordedAt;
    const lag = leaves - v.fix.recordedAt - DELAY_MS;
    const arrives = Math.max(leaves + crossMs(span, lag), leaves + (length / SPEED_CAP_MPS[r.mode]) * 1000);
    // A hold point keeps TripsLayer's trail head under the model while it waits.
    if (leaves > last.at) v.path.push({ position: last.position, at: leaves, heading: last.heading });
    let heading = last.heading;
    let z = last.position[2];
    prev = flat(last.position);
    points.forEach((p, i) => {
      if (distanceMetres(prev, p) > 0.01) heading = bearingBetween(prev, p);
      z = this.#elevationAt(p) ?? z;
      const at = length > 0 ? leaves + ((arrives - leaves) * cum[i]) / length : arrives;
      v.path.push({ position: [p[0], p[1], z], at, heading });
      prev = p;
    });
    v.fix = { position: r.position, recordedAt: r.recordedAt, bearing: r.bearing };
  }

  /**
   * Where fix `r` is drawn, and the shape points to glide through before it (none for a straight
   * step). Moves the cursor. See Snapping in docs/vehicle-store.md.
   */
  #snap(v: VehicleState, r: VehicleReport): { drawn: LngLat; glide: LngLat[] } {
    const journey = r.journeyId;
    const shape = this.#readyShape(journey);
    if (!shape || !journey) return { drawn: r.position, glide: [] };

    let cursor = v.cursor?.journey === journey ? v.cursor : null;
    if (!cursor) {
      const seed = pickByBearing(passesNear(shape, v.fix.position, 0, Infinity), v.fix.bearing);
      if (seed) cursor = v.cursor = { journey, along: seed.along, recordedAt: v.fix.recordedAt };
    }

    let along: number | null = null;
    let glides = false;
    if (cursor) {
      const reach = (SPEED_CAP_MPS[r.mode] * (r.recordedAt - cursor.recordedAt)) / 1000 + OFF_SHAPE_M;
      const earliest = passesNear(shape, r.position, cursor.along - BACKWARD_GRACE_M, cursor.along + reach)[0];
      if (earliest) {
        along = Math.max(earliest.along, cursor.along);
        glides = cursor.recordedAt === v.fix.recordedAt;
      }
    }
    if (along === null) {
      const all = passesNear(shape, r.position, 0, Infinity);
      along = (cursor ? nearestTo(all, cursor.along) : pickByBearing(all, r.bearing))?.along ?? null;
    }
    if (along === null) return { drawn: r.position, glide: [] };

    const drawn = pointAlong(shape, along);
    v.cursor = { journey, along, recordedAt: r.recordedAt };
    if (!glides || !cursor) return { drawn, glide: [] };
    const start = pointAlong(shape, cursor.along);
    if (along - cursor.along > DETOUR_FACTOR * distanceMetres(start, drawn) + DETOUR_SLACK_M) return { drawn, glide: [] };
    return { drawn, glide: [start, ...verticesBetween(shape, cursor.along, along)] };
  }

  /**
   * Round-robin over vehicles behind the terrain epoch: re-sample every path point (a null sample keeps
   * the old z). Only a full sweep of one vehicle marks it current. Stops after Z_BUDGET_MS and resumes
   * from a cursor next frame.
   */
  #sweepZ(): void {
    const start = performance.now();
    let changed = false;
    let i = 0;
    for (const v of this.#vehicles.values()) {
      if (i++ < this.#zCursor || v.zEpoch >= this.#terrainEpoch) continue;
      for (const p of v.path) {
        const z = this.#elevationAt([p.position[0], p.position[1]]);
        if (z !== null && z !== p.position[2]) {
          p.position = [p.position[0], p.position[1], z];
          changed = true;
        }
      }
      v.zEpoch = this.#terrainEpoch;
      if (performance.now() - start > Z_BUDGET_MS) {
        this.#zCursor = i;
        if (changed) this.#trails = null;
        return;
      }
    }
    this.#zCursor = 0;
    if (changed) this.#trails = null;
  }
}

/**
 * Wall time to play `spanMs` of reports, starting `lagMs` behind the 35 s target. The rate is CATCH_UP
 * while behind and EASE_IN while ahead. Closing the lag at rate k covers lag × k / (k − 1) of reports,
 * and the rest of the span plays at 1x, so a span that closes it lands exactly on target.
 */
function crossMs(spanMs: number, lagMs: number): number {
  if (lagMs === 0) return spanMs;
  const rate = lagMs > 0 ? CATCH_UP : EASE_IN;
  return spanMs <= (lagMs * rate) / (rate - 1) ? spanMs / rate : spanMs - lagMs;
}

function retryWaitMs(attempts: number): number {
  return Math.min(SHAPE_RETRY_MS * 2 ** (attempts - 1), SHAPE_RETRY_MAX_MS);
}

/** Signed turn from heading a to heading b, −180 to 180. */
function turnBy(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** Whole-shape projection: the earliest pass within 90° of the bearing, else the earliest pass. */
function pickByBearing(passes: Pass[], bearing: number | null): Pass | undefined {
  return (bearing === null ? undefined : passes.find((p) => Math.abs(turnBy(p.heading, bearing)) <= 90)) ?? passes[0];
}

function nearestTo(passes: Pass[], along: number): Pass | undefined {
  let best: Pass | undefined;
  for (const p of passes) if (!best || Math.abs(p.along - along) < Math.abs(best.along - along)) best = p;
  return best;
}

function samePosition(a: LngLat, b: LngLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function flat(p: Position3): LngLat {
  return [p[0], p[1]];
}

/** The path sampled at `now`. The heading eases from the previous piece's over the first TURN_M. */
function poseOn(path: PathPoint[], now: number): { position: Position3; bearing: number } {
  let i = path.length - 1;
  while (i > 0 && path[i].at > now) i--;
  if (i === path.length - 1 || path[i].at > now) return { position: path[i].position, bearing: path[i].heading };
  const a = path[i];
  const b = path[i + 1];
  const t = (now - a.at) / (b.at - a.at);
  const position: Position3 = [
    a.position[0] + (b.position[0] - a.position[0]) * t,
    a.position[1] + (b.position[1] - a.position[1]) * t,
    a.position[2] + (b.position[2] - a.position[2]) * t,
  ];
  const len = distanceMetres(flat(a.position), flat(b.position));
  const k = len > 0.01 ? Math.min(1, (t * len) / TURN_M) : 1;
  return { position, bearing: (a.heading + turnBy(a.heading, b.heading) * k + 360) % 360 };
}
