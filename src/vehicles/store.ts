import { bearingBetween, drawnAt, startTween, type Tween } from "./motion";
import type { Journey, LngLat, Mode, Position3, VehicleId, VehicleReport } from "./types";

/** A report older than this hides the vehicle. */
export const STALE_MS = 2 * 60_000;
/** How long a trail is kept and how long it takes to fade out. The trail layer reads this too. */
export const TRAIL_MS = 5 * 60_000;
/** A vehicle silent this long is forgotten, trail and all. */
const FORGET_MS = STALE_MS + TRAIL_MS;
/** Per-frame time budget for re-sampling terrain z after tiles load. */
const Z_BUDGET_MS = 2;

/** Terrain height in metres at a point, or null while no DEM tile covers it yet. */
export type ElevationAt = (p: LngLat) => number | null;

/** A vehicle as drawn this frame. What the model layer, dot layer and picking see. */
export interface VehiclePose {
  id: VehicleId;
  mode: Mode;
  position: Position3;
  bearing: number;
}

/**
 * A trail ready for `TripsLayer`. `times[i]` is when the drawn vehicle reaches `path[i]`
 * (epoch ms), so the trail's head sits under the tweened model, not ahead of it.
 */
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
   * Trails of every known vehicle, hidden ones included: a stopped or ended vehicle's trail fades
   * out on its own in TripsLayer. Same reference until a trail changes, so deck re-uploads only then.
   */
  trails: readonly TrailPath[];
}

/** What the info card shows. */
export interface VehicleInfo {
  id: VehicleId;
  mode: Mode;
  journey: Journey | null;
}

/** Private. Nothing outside this file sees it. */
interface TrailPoint {
  position: Position3;
  /** The report's `recordedAt`. Speed (M5) reads it. */
  recordedAt: number;
  /**
   * When the drawn vehicle reaches this point: the tween's `endsAt` when the point arrived.
   * Stamped once and never re-shifted, so older points' fade times don't jitter.
   */
  drawnAt: number;
}

/** Private. Nothing outside this file sees it. */
interface VehicleState {
  latest: VehicleReport;
  /** Last non-null bearing, or one derived from movement. Null until either exists. */
  bearing: number | null;
  /**
   * Oldest first, never empty. The last point is always `latest.position` with its z, and is
   * the tween target. Keyed by vehicle only, so a journey change can't reset it.
   */
  trail: TrailPoint[];
  tween: Tween;
  /** Terrain epoch at which every point of `trail` was last sampled. Only the z sweep writes it. */
  zEpoch: number;
}

/**
 * Every vehicle the app knows about, and everything derived from them: visibility, pose,
 * trail, info. The one owner of per-vehicle state. Plain mutable state outside Solid.
 *
 * Writes come from `ingest` (the source) and `terrainChanged` (the map). The layers call
 * `frame` once per animation frame, and that's the only way to read poses and trails, so a
 * reader can't see an un-advanced store. All times are epoch ms on `Date.now()`'s clock,
 * because the stale rule compares `recordedAt` with local time (SPIKES: skew under 1 s).
 */
export class VehicleStore {
  #vehicles = new Map<VehicleId, VehicleState>();
  #version = 0;
  #terrainEpoch = 0;
  /** Built lazily, dropped when a trail gains a point, a z changes, or a vehicle is forgotten. */
  #trails: readonly TrailPath[] | null = null;
  /** Index into the vehicle map where the next z sweep resumes. */
  #zCursor = 0;

  constructor(private readonly elevationAt: ElevationAt) {}

  /** Bumps on every ingest that changed something. Solid mirrors it into a signal for the info card. */
  get version(): number {
    return this.#version;
  }

  /**
   * Upserts a batch of reports, in any order, possibly repeated or historical.
   * Idempotent: a report no newer than the vehicle's latest is ignored, so a reconnect burst
   * or a replayed relay snapshot changes nothing the second time.
   */
  ingest(reports: readonly VehicleReport[], now: number): void {
    const sorted = [...reports].sort((x, y) => x.recordedAt - y.recordedAt);
    const added = new Map<VehicleId, TrailPoint[]>();
    for (const r of sorted) {
      const v = this.#vehicles.get(r.id);
      if (v && r.recordedAt <= v.latest.recordedAt) continue;
      const z = this.elevationAt(r.position) ?? v?.trail.at(-1)!.position[2] ?? 0;
      const point: TrailPoint = { position: [r.position[0], r.position[1], z], recordedAt: r.recordedAt, drawnAt: NaN };
      if (!v) {
        const tween = startTween(point.position, r.bearing ?? 0, Infinity, now);
        this.#vehicles.set(r.id, { latest: r, bearing: r.bearing, trail: [point], tween, zEpoch: -1 });
        added.set(r.id, [point]);
        continue;
      }
      const prev = v.trail.at(-1)!;
      const bearing = r.bearing ?? v.bearing ?? bearingBetween([prev.position[0], prev.position[1]], r.position);
      // A live report glides from where the vehicle is drawn now. A later report of the same
      // vehicle in one batch (relay history, reconnect burst) chains from the previous point, so
      // only the last step animates.
      const from = added.has(r.id)
        ? { position: prev.position, bearing: v.bearing ?? bearing }
        : drawnAt(v.tween, prev.position, v.bearing ?? bearing, now);
      v.tween = startTween(from.position, from.bearing, r.recordedAt - v.latest.recordedAt, now);
      // An outage snaps the model but keeps the trail: the segment across the silence is mostly faded.
      v.trail.push(point);
      const keepFrom = v.trail.findIndex((p) => p.recordedAt >= r.recordedAt - TRAIL_MS);
      v.trail.splice(0, keepFrom);
      v.bearing = bearing;
      v.latest = r;
      added.set(r.id, [...(added.get(r.id) ?? []), point]);
    }
    for (const [vid, points] of added) {
      const v = this.#vehicles.get(vid)!;
      const offset = v.tween.endsAt - v.latest.recordedAt;
      for (const p of points) {
        const i = v.trail.indexOf(p);
        if (i < 0) continue;
        p.drawnAt = Math.max(p.recordedAt + offset, i > 0 ? v.trail[i - 1].drawnAt + 1 : -Infinity);
      }
    }
    let changed = added.size > 0;
    for (const [vid, v] of this.#vehicles) {
      if (v.latest.recordedAt < now - FORGET_MS) {
        this.#vehicles.delete(vid);
        changed = true;
      }
    }
    if (changed) {
      this.#version++;
      this.#trails = null;
    }
  }

  /**
   * Call when terrain tiles load (MapLibre `sourcedata` on the terrain source). O(1). `frame`
   * re-samples z for vehicles behind this epoch within its time budget.
   */
  terrainChanged(): void {
    this.#terrainEpoch++;
  }

  /**
   * Advances the store to `now` and returns what to draw. Called once per animation frame.
   * Applies the stale rule, tweens every visible vehicle, and spends up to Z_BUDGET_MS
   * re-sampling terrain z.
   */
  frame(now: number): Frame {
    // ponytail: ~1200 fresh pose objects per frame, and deck recomputes the instance attributes
    //           anyway. Reuse a pool if GC shows up in a profile.
    const poses: VehiclePose[] = [];
    for (const [id, v] of this.#vehicles) {
      if (isStale(v, now)) continue;
      const { position, bearing } = drawnAt(v.tween, v.trail.at(-1)!.position, v.bearing ?? 0, now);
      poses.push({ id, mode: v.latest.mode, position, bearing });
    }
    this.#sweepZ();
    this.#trails ??= [...this.#vehicles]
      .filter(([, v]) => v.trail.length >= 2)
      .map(([id, v]) => ({ id, mode: v.latest.mode, path: v.trail.map((p) => p.position), times: v.trail.map((p) => p.drawnAt) }));
    return { poses, trails: this.#trails };
  }

  /** The info card's data, or null when the vehicle is unknown or stale. */
  info(id: VehicleId, now: number): VehicleInfo | null {
    const v = this.#vehicles.get(id);
    return v && !isStale(v, now) ? { id, mode: v.latest.mode, journey: v.latest.journey } : null;
  }

  /**
   * Round-robin over known vehicles with zEpoch < terrainEpoch: re-sample every trail point
   * and tween.from (a null sample keeps the old z), then set zEpoch = terrainEpoch. Only a
   * full sweep of one vehicle marks it current, so ingest never hides unswept points.
   * Stops after Z_BUDGET_MS of `performance.now()` and resumes from a cursor next frame.
   * Drops `#trails` if any z changed.
   */
  #sweepZ(): void {
    // ponytail: up to ~1200 × ~75 points after a big tile load, spread over frames. If z lags
    //           visibly after a pan, sweep viewport vehicles first.
    const start = performance.now();
    let changed = false;
    let i = 0;
    for (const v of this.#vehicles.values()) {
      if (i++ < this.#zCursor || v.zEpoch >= this.#terrainEpoch) continue;
      for (const p of v.trail) {
        const z = this.elevationAt([p.position[0], p.position[1]]);
        if (z !== null && z !== p.position[2]) {
          p.position = [p.position[0], p.position[1], z];
          changed = true;
        }
      }
      const f = v.tween.from;
      const fz = this.elevationAt([f[0], f[1]]);
      if (fz !== null) v.tween.from = [f[0], f[1], fz];
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

/** The stale rule, in one place. A null status arrives as `journeyEnded: false`, so it stays alive. */
function isStale(v: VehicleState, now: number): boolean {
  return v.latest.journeyEnded || now - v.latest.recordedAt > STALE_MS;
}
