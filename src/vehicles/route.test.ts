import { describe, expect, it } from "vitest";
import { OFF_SHAPE_M, passesNear, pointAlong, prepareShape, verticesBetween, type RouteShape } from "./route";
import type { LngLat } from "./types";

// Shapes are written in metres east and north of a point in Bergen.
const LAT0 = 60.39;
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number): LngLat => [5.32 + x / M_PER_DEG_LNG, LAT0 + y / M_PER_DEG_LAT];
const xy = (p: LngLat) => [(p[0] - 5.32) * M_PER_DEG_LNG, (p[1] - LAT0) * M_PER_DEG_LAT].map((v) => Math.round(v));
const shape = (m: [number, number][]): RouteShape => prepareShape(m.map(([x, y]) => ll(x, y)))!;

/** East 200 m, then north 200 m. */
const L = shape([[0, 0], [200, 0], [200, 200]]);
/** Out to a tip 400 m along and back on the same road. (200, y) is 200 + y along out and 600 - y back. */
const SPUR = shape([[0, 0], [200, 0], [200, 200], [200, 0], [0, 0]]);

const rounded = (passes: { along: number; heading: number }[]) =>
  passes.map((p) => ({ along: Math.round(p.along), heading: Math.round(p.heading) % 360 }));

describe("passesNear", () => {
  it("splits an out-and-back spur into two passes where the shape turns back", () => {
    expect(rounded(passesNear(SPUR, ll(200, 100), 0, Infinity))).toEqual([
      { along: 300, heading: 0 },
      { along: 500, heading: 180 },
    ]);
  });

  it("keeps a bend under 90° in one pass and gives its nearest point", () => {
    // (190, 30) is 30 m from the eastbound leg and 10 m from the northbound leg at 230 m along.
    expect(rounded(passesNear(L, ll(190, 30), 0, Infinity))).toEqual([{ along: 230, heading: 0 }]);
  });

  it("honours the window", () => {
    expect(rounded(passesNear(SPUR, ll(200, 100), 400, Infinity))).toEqual([{ along: 500, heading: 180 }]);
    expect(rounded(passesNear(SPUR, ll(200, 100), 0, 350))).toEqual([{ along: 300, heading: 0 }]);
    expect(passesNear(SPUR, ll(200, 100), 320, 480)).toEqual([]);
  });

  it("counts a position within OFF_SHAPE_M as on the shape", () => {
    expect(rounded(passesNear(L, ll(100, -(OFF_SHAPE_M - 1)), 0, Infinity))).toEqual([{ along: 100, heading: 90 }]);
    expect(passesNear(L, ll(100, -(OFF_SHAPE_M + 1)), 0, Infinity)).toEqual([]);
  });
});

describe("pointAlong", () => {
  it("interpolates along the shape and clamps to its ends", () => {
    expect(xy(pointAlong(L, 250))).toEqual([200, 50]);
    expect(xy(pointAlong(L, -50))).toEqual([0, 0]);
    expect(xy(pointAlong(L, 5_000))).toEqual([200, 200]);
  });
});

describe("verticesBetween", () => {
  it("returns only the vertices strictly between the two distances", () => {
    expect(verticesBetween(SPUR, 200, 600).map(xy)).toEqual([[200, 200]]);
    expect(verticesBetween(SPUR, 199, 601).map(xy)).toEqual([[200, 0], [200, 200], [200, 0]]);
  });
});

describe("prepareShape", () => {
  it("drops repeated vertices", () => {
    const s = shape([[0, 0], [0, 0], [100, 0], [100, 0], [100, 100]]);
    expect(s.length).toBeCloseTo(200, 6);
    // A zero-length segment would have split this into two passes.
    expect(rounded(passesNear(s, ll(100, 0), 0, Infinity))).toEqual([{ along: 100, heading: 90 }]);
  });

  it("is null for fewer than two distinct points", () => {
    expect(prepareShape([ll(5, 5), ll(5, 5)])).toBeNull();
    expect(prepareShape([ll(5, 5)])).toBeNull();
    expect(prepareShape([])).toBeNull();
  });
});
