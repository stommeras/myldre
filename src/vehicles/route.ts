/** Pure geometry on one route shape, measured in metres. Imported only by the store. */
import type { LngLat } from "./types";

/** Within this distance a position counts as on the shape. */
export const OFF_SHAPE_M = 40;

const EARTH_RADIUS_M = 6_371_000;
const RAD = Math.PI / 180;
/** Slack for float error when comparing distances along the shape. */
const EPS_M = 1e-6;

/**
 * A shape's vertices with cumulative distance per vertex. Each query measures in a local frame
 * centred on its own point, so OFF_SHAPE_M holds on shapes that span many degrees of latitude.
 */
export interface RouteShape {
  lngs: number[];
  lats: number[];
  cum: number[];
  length: number;
}

/** Null for fewer than two distinct points. Drops repeated vertices, which have no heading. */
export function prepareShape(points: readonly LngLat[]): RouteShape | null {
  const distinct = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  if (distinct.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < distinct.length; i++) cum.push(cum[i - 1] + distanceMetres(distinct[i - 1], distinct[i]));
  return { lngs: distinct.map((p) => p[0]), lats: distinct.map((p) => p[1]), cum, length: cum[cum.length - 1] };
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
  const { lngs, lats, cum } = shape;
  const ky = EARTH_RADIUS_M * RAD;
  const kx = ky * Math.cos(p[1] * RAD);
  const passes: Pass[] = [];
  let best: { pass: Pass; d: number } | null = null;
  let prevHeading: number | null = null;
  for (let i = firstSegmentReaching(cum, from); i < lngs.length && cum[i - 1] <= to + EPS_M; i++) {
    // The segment in metres from p.
    const ax = (lngs[i - 1] - p[0]) * kx;
    const ay = (lats[i - 1] - p[1]) * ky;
    const vx = (lngs[i] - lngs[i - 1]) * kx;
    const vy = (lats[i] - lats[i - 1]) * ky;
    const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / (vx * vx + vy * vy)));
    const d = Math.hypot(ax + vx * t, ay + vy * t);
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
  const { lngs, lats, cum } = shape;
  const s = Math.max(0, Math.min(shape.length, along));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return [lngs[i - 1] + (lngs[i] - lngs[i - 1]) * t, lats[i - 1] + (lats[i] - lats[i - 1]) * t];
}

/** The shape's own vertices strictly between two distances. */
export function verticesBetween(shape: RouteShape, from: number, to: number): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i < shape.cum.length; i++) {
    if (shape.cum[i] > from + EPS_M && shape.cum[i] < to - EPS_M) out.push([shape.lngs[i], shape.lats[i]]);
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
