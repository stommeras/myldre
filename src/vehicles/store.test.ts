// The store's rules as an executable spec. Fails until the bodies are filled in. Needs `vitest`.
import { describe, expect, it } from "vitest";
import { speedMps } from "./motion";
import { STALE_MS, VehicleStore } from "./store";
import type { VehicleId, VehicleReport } from "./types";

const id = "SKY:Vehicle:1" as VehicleId;
const A = [5.3, 60.39] as const;
const B = [5.31, 60.39] as const;
const C = [5.32, 60.39] as const;

function report(over: Partial<VehicleReport> = {}): VehicleReport {
  return { id, recordedAt: 0, position: A, bearing: 90, journeyEnded: false, mode: "bus", journey: null, ...over };
}
const store = () => new VehicleStore(() => 0);

describe("VehicleStore", () => {
  it("upserts by vehicleId", () => {
    const s = store();
    s.ingest([report(), report({ recordedAt: 5_000, position: B })], 6_000);
    expect(s.frame(6_000).poses).toHaveLength(1);
  });

  it("ignores a repeated batch", () => {
    const s = store();
    s.ingest([report()], 1_000);
    const v = s.version;
    s.ingest([report()], 2_000);
    expect(s.version).toBe(v);
  });

  it("hides stale and ended vehicles, keeps null-status ones", () => {
    const s = store();
    s.ingest([report()], 1_000);
    expect(s.frame(STALE_MS + 1).poses).toHaveLength(0);
    s.ingest([report({ recordedAt: 10_000, journeyEnded: true })], 10_000);
    expect(s.frame(10_000).poses).toHaveLength(0);
    s.ingest([report({ recordedAt: 20_000, journeyEnded: false })], 20_000);
    expect(s.frame(20_000).poses).toHaveLength(1);
  });

  it("keeps the previous bearing when bearing is null", () => {
    const s = store();
    s.ingest([report({ bearing: 45 })], 0);
    s.ingest([report({ recordedAt: 5_000, bearing: null })], 5_000);
    expect(s.frame(60_000).poses[0].bearing).toBe(45);
  });

  it("derives a bearing from movement when none was ever reported", () => {
    const s = store();
    s.ingest([report({ bearing: null, position: A })], 0);
    s.ingest([report({ recordedAt: 5_000, bearing: null, position: B })], 5_000);
    expect(s.frame(60_000).poses[0].bearing).toBeCloseTo(90, 0);
  });

  it("tweens over the vehicle's own update gap", () => {
    const s = store();
    s.ingest([report({ position: A })], 1_000);
    s.ingest([report({ recordedAt: 10_000, position: B })], 20_000);
    const [lng] = s.frame(25_000).poses[0].position;
    expect(lng).toBeCloseTo((A[0] + B[0]) / 2);
  });

  it("keeps the trail across a journey change", () => {
    const s = store();
    s.ingest([report({ journey: { line: "3", destination: "Sentrum", delaySeconds: 0 } })], 0);
    s.ingest([report({ recordedAt: 5_000, position: B, journey: { line: "4", destination: "Lia", delaySeconds: 0 } })], 5_000);
    expect(s.frame(5_000).trails[0].path).toHaveLength(2);
  });

  it("keeps an ended vehicle's trail so it can fade out", () => {
    const s = store();
    s.ingest([report({ position: A })], 0);
    s.ingest([report({ recordedAt: 5_000, position: B, journeyEnded: true })], 5_000);
    const f = s.frame(6_000);
    expect(f.poses).toHaveLength(0);
    expect(f.trails).toHaveLength(1);
  });

  it("keeps the trail across a long silence", () => {
    const s = store();
    s.ingest([report({ position: A })], 0);
    s.ingest([report({ recordedAt: 5_000, position: B })], 5_000);
    s.ingest([report({ recordedAt: 200_000, position: B })], 200_000);
    expect(s.frame(200_000).trails[0].path).toHaveLength(3);
  });

  it("puts the trail head under the model", () => {
    const s = store();
    s.ingest([report({ position: A })], 0);
    s.ingest([report({ recordedAt: 10_000, position: B })], 12_000);
    const { trails } = s.frame(12_000);
    expect(trails[0].times.at(-1)).toBe(22_000); // tween ends at now + gap
  });

  it("turns a history batch into trail and animates only the last step", () => {
    const s = store();
    s.ingest([report({ recordedAt: 20_000, position: C }), report({ position: A }), report({ recordedAt: 10_000, position: B })], 30_000);
    const f = s.frame(30_000);
    expect(f.trails[0].path).toHaveLength(3);
    expect(f.poses[0].position[0]).toBeCloseTo(B[0]);
  });
});

it("derives speed from consecutive positions", () => {
  // 0.01° of longitude at 60.39°N is about 551 m.
  expect(speedMps(A, 0, B, 55_100)).toBeCloseTo(10, 0);
});
