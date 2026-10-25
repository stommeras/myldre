/**
 * Pure geometry over time: where a vehicle is drawn at a given instant.
 * M5 (dead reckoning, easing, route snapping) replaces the bodies here and nothing outside
 * `vehicles/` changes, because callers only ever see a pose.
 */
import type { LngLat, Position3 } from "./types";

/**
 * Straight-line glide from where the vehicle was drawn to its latest reported position.
 * The target is not stored here. It is always the vehicle's newest trail point, so it can't
 * drift from the trail. A snap is a tween with `endsAt === startedAt`.
 */
export interface Tween {
  from: Position3;
  fromBearing: number;
  /** Wall-clock epoch ms. */
  startedAt: number;
  endsAt: number;
}

/** Bounds on the tween duration. Gaps are p50 4 s, p90 21 s in Norway (SPIKES.md). */
export const MIN_TWEEN_MS = 1_000;
/** A gap longer than this is an outage, not an update gap: snap the model instead of gliding. Same as the stale rule. */
export const SNAP_GAP_MS = 2 * 60_000;

/**
 * Starts a tween that lasts about the vehicle's own observed update gap.
 * `gapMs` is the difference between the two reports' `recordedAt`, or `Infinity` for a
 * vehicle's first report.
 */
export function startTween(from: Position3, fromBearing: number, gapMs: number, now: number): Tween {
  // TODO: gapMs > SNAP_GAP_MS → { from, fromBearing, startedAt: now, endsAt: now }
  //       else endsAt = now + max(gapMs, MIN_TWEEN_MS)
  // ponytail: last gap only. Use a short EMA of gaps if vehicles visibly stall or rush.
  throw new Error("not implemented");
}

/** Where and which way the vehicle is drawn at `now`. Holds at `to` once the tween ends. */
export function drawnAt(
  tween: Tween,
  to: Position3,
  toBearing: number,
  now: number,
): { position: Position3; bearing: number } {
  // TODO: t = clamp01((now - startedAt) / (endsAt - startedAt)), 1 when the duration is 0
  //       position = lerp(from, to, t), z included. Mid-tween z is a straight line between two
  //       terrain samples, so it can cut a crest on long gaps (accepted, see the design doc).
  //       bearing  = shortest-arc lerp(fromBearing, toBearing, t), normalised to [0, 360)
  throw new Error("not implemented");
}

/** Degrees clockwise from north, from a to b. Only for a vehicle that has never reported a bearing. */
export function bearingBetween(a: LngLat, b: LngLat): number {
  throw new Error("not implemented");
}

/** Ground speed between two reports in m/s. Derived, never stored. M5 is its first caller. */
export function speedMps(a: LngLat, aAt: number, b: LngLat, bAt: number): number {
  // TODO: equirectangular distance (fine at these ranges) / ((bAt - aAt) / 1000)
  throw new Error("not implemented");
}
