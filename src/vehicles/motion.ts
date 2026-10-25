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
  // ponytail: last gap only. Use a short EMA of gaps if vehicles visibly stall or rush.
  const duration = gapMs > SNAP_GAP_MS ? 0 : Math.max(gapMs, MIN_TWEEN_MS);
  return { from, fromBearing, startedAt: now, endsAt: now + duration };
}

/** Where and which way the vehicle is drawn at `now`. Holds at `to` once the tween ends. */
export function drawnAt(
  tween: Tween,
  to: Position3,
  toBearing: number,
  now: number,
): { position: Position3; bearing: number } {
  // Mid-tween z is a straight line between two terrain samples, so it can cut a crest on long
  // gaps (accepted, see the design doc).
  const duration = tween.endsAt - tween.startedAt;
  const t = duration > 0 ? Math.min(1, Math.max(0, (now - tween.startedAt) / duration)) : 1;
  const { from } = tween;
  const turn = ((toBearing - tween.fromBearing + 540) % 360) - 180;
  return {
    position: [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t],
    bearing: (((tween.fromBearing + turn * t) % 360) + 360) % 360,
  };
}

/** Degrees clockwise from north, from a to b. Only for a vehicle that has never reported a bearing. */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const [dx, dy] = offsetMetres(a, b);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Ground speed between two reports in m/s. Derived, never stored. M5 is its first caller. */
export function speedMps(a: LngLat, aAt: number, b: LngLat, bAt: number): number {
  const [dx, dy] = offsetMetres(a, b);
  return Math.hypot(dx, dy) / ((bAt - aAt) / 1000);
}

const EARTH_RADIUS_M = 6_371_000;

/** East and north offset from a to b in metres. Equirectangular, fine at these ranges. */
function offsetMetres(a: LngLat, b: LngLat): [east: number, north: number] {
  const rad = Math.PI / 180;
  const meanLat = ((a[1] + b[1]) / 2) * rad;
  return [(b[0] - a[0]) * rad * Math.cos(meanLat) * EARTH_RADIUS_M, (b[1] - a[1]) * rad * EARTH_RADIUS_M];
}
