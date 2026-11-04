/** Pure geometry on one route shape, in local metres. Imported only by the store. */
import type { LngLat } from "./types";

/** Within this distance a position counts as on the shape. */
export const OFF_SHAPE_M = 40;

const EARTH_RADIUS_M = 6_371_000;
const RAD = Math.PI / 180;
/** Slack for float error when comparing distances along the shape. */
const EPS_M = 1e-6;

/** A shape in local metres around its first point, with cumulative distance per vertex. */
export interface RouteShape {
  origin: LngLat;
  /** Metres per degree of longitude and of latitude at the origin. */
  scale: readonly [x: number, y: number];
  xs: number[];
  ys: number[];
  cum: number[];
  length: number;
}

/** Null for fewer than two distinct points. Drops repeated vertices, which have no heading. */
export function prepareShape(points: readonly LngLat[]): RouteShape | null {
  const distinct = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  if (distinct.length < 2) return null;
  const origin = distinct[0];
  const sy = EARTH_RADIUS_M * RAD;
  const scale = [sy * Math.cos(origin[1] * RAD), sy] as const;
  const xs = distinct.map((p) => (p[0] - origin[0]) * scale[0]);
  const ys = distinct.map((p) => (p[1] - origin[1]) * scale[1]);
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
  return { origin, scale, xs, ys, cum, length: cum[cum.length - 1] };
}

/** One pass's nearest point to a position, and the bearing of the shape segment it lies on. */
export interface Pass {
  along: number;
  heading: number;
}

/**
 * The passes near `p` inside [from, to], in order along the shape. A pass is a run of consecutive shape
 * segments whose own projection of `p` lies within OFF_SHAPE_M and inside the window. It ends where a
 * segment fails that, or where the shape turns back by more than 90°. Each pass gives its nearest point.
 */
export function passesNear(shape: RouteShape, p: LngLat, from: number, to: number): Pass[] {
  const { xs, ys, cum } = shape;
  const px = (p[0] - shape.origin[0]) * shape.scale[0];
  const py = (p[1] - shape.origin[1]) * shape.scale[1];
  const passes: Pass[] = [];
  let best: { pass: Pass; d: number } | null = null;
  let prevHeading: number | null = null;
  for (let i = firstSegmentReaching(cum, from); i < xs.length && cum[i - 1] <= to + EPS_M; i++) {
    const vx = xs[i] - xs[i - 1];
    const vy = ys[i] - ys[i - 1];
    const t = Math.max(0, Math.min(1, ((px - xs[i - 1]) * vx + (py - ys[i - 1]) * vy) / (vx * vx + vy * vy)));
    const d = Math.hypot(xs[i - 1] + vx * t - px, ys[i - 1] + vy * t - py);
    const along = cum[i - 1] + t * (cum[i] - cum[i - 1]);
    const heading = headingOf(vx, vy);
    const near = d <= OFF_SHAPE_M && along >= from - EPS_M && along <= to + EPS_M;
    const turnsBack = prevHeading !== null && turn(prevHeading, heading) > 90;
    if (best && (!near || turnsBack)) {
      passes.push(best.pass);
      best = null;
    }
    if (near && (!best || d < best.d - EPS_M)) best = { pass: { along, heading }, d };
    prevHeading = heading;
  }
  if (best) passes.push(best.pass);
  return passes;
}

function firstSegmentReaching(cum: readonly number[], from: number): number {
  let lo = 1;
  let hi = cum.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < from - EPS_M) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The point `along` metres along the shape, clamped to its ends. */
export function pointAlong(shape: RouteShape, along: number): LngLat {
  const { xs, ys, cum } = shape;
  const s = Math.max(0, Math.min(shape.length, along));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return toLngLat(shape, xs[i - 1] + (xs[i] - xs[i - 1]) * t, ys[i - 1] + (ys[i] - ys[i - 1]) * t);
}

/** The shape's own vertices strictly between two distances. */
export function verticesBetween(shape: RouteShape, from: number, to: number): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i < shape.cum.length; i++) {
    if (shape.cum[i] > from + EPS_M && shape.cum[i] < to - EPS_M) out.push(toLngLat(shape, shape.xs[i], shape.ys[i]));
  }
  return out;
}

export function distanceMetres(a: LngLat, b: LngLat): number {
  const [east, north] = offsetMetres(a, b);
  return Math.hypot(east, north);
}

/** Degrees clockwise from north, from a to b. */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const [east, north] = offsetMetres(a, b);
  return headingOf(east, north);
}

/** East and north offset from a to b in metres. Equirectangular, fine at these ranges. */
function offsetMetres(a: LngLat, b: LngLat): [east: number, north: number] {
  const meanLat = ((a[1] + b[1]) / 2) * RAD;
  return [(b[0] - a[0]) * RAD * Math.cos(meanLat) * EARTH_RADIUS_M, (b[1] - a[1]) * RAD * EARTH_RADIUS_M];
}

function headingOf(east: number, north: number): number {
  return ((Math.atan2(east, north) / RAD) + 360) % 360;
}

/** The unsigned angle between two headings, 0 to 180. */
function turn(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

function toLngLat(shape: RouteShape, x: number, y: number): LngLat {
  return [shape.origin[0] + x / shape.scale[0], shape.origin[1] + y / shape.scale[1]];
}
