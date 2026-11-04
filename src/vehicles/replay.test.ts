import { afterEach, expect, it, vi } from "vitest";
import { loadRecording, LOOP_GAP_MS, ReplayClock, replaySource, type Recording } from "./replay";
import type { VehicleId, VehicleReport } from "./types";

const report = (id: string, recordedAt: number) =>
  ({ id: id as VehicleId, recordedAt, position: [5, 60], bearing: null, journeyEnded: false, mode: "bus", journey: null, journeyId: null }) satisfies VehicleReport;

const recording: Recording = {
  startMs: 1_000_000,
  endMs: 1_010_000,
  entries: [
    { arrivalMs: 1_000_000, report: report("a", 999_000) },
    { arrivalMs: 1_005_000, report: report("b", 1_004_000) },
    { arrivalMs: 1_010_000, report: report("c", 1_009_000) },
  ],
};
const D = 10_000;

function setup(speed = 1) {
  let wall = 0;
  const clock = new ReplayClock(recording, speed, () => wall);
  let frame: (() => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => ((frame = f), 1));
  vi.stubGlobal("cancelAnimationFrame", () => (frame = undefined));
  const batches: VehicleReport[][] = [];
  const stop = replaySource(recording, clock)((r) => batches.push(r));
  const advance = (ms: number) => ((wall += ms), frame?.());
  return { clock, batches, stop, advance, setWall: (w: number) => (wall = w) };
}

afterEach(() => vi.unstubAllGlobals());

it("emits entries in order once their time passes, batched per frame", () => {
  const { batches, advance } = setup();
  advance(0);
  advance(4_999);
  expect(batches.map((b) => b.map((r) => r.id))).toEqual([["a"]]);
  advance(1);
  expect(batches.map((b) => b.map((r) => r.id))).toEqual([["a"], ["b"]]);
});

it("re-emits the next loop shifted by D + LOOP_GAP_MS, and sim time stays monotonic", () => {
  const { clock, batches, advance } = setup();
  advance(D);
  const [c, again] = [batches[0][2], batches[0][3]];
  expect([c.id, again.id]).toEqual(["c", "a"]);
  expect(again.recordedAt).toBe(999_000 + D + LOOP_GAP_MS);
  expect(clock.now()).toBe(recording.startMs + D + LOOP_GAP_MS);
  let last = -Infinity;
  for (let i = 0; i < 100; i++) {
    advance(1_337);
    expect(clock.now()).toBeGreaterThan(last);
    last = clock.now();
  }
});

it("setSpeed keeps now() continuous and then runs at the new speed", () => {
  const { clock, advance } = setup(1);
  advance(3_000);
  const before = clock.now();
  clock.setSpeed(60);
  expect(clock.now()).toBe(before);
  advance(100);
  expect(clock.now()).toBe(before + 6_000);
});

it("stop cancels the loop", () => {
  const { batches, stop, advance } = setup();
  stop();
  advance(10_000);
  expect(batches).toHaveLength(0);
});

it("holds sim time at speed 0, as for a hidden tab, and emits nothing missed on resume", () => {
  const { clock, batches, advance } = setup(1);
  advance(0);
  clock.setSpeed(0);
  const paused = clock.now();
  advance(60_000);
  expect(clock.now()).toBe(paused);
  clock.setSpeed(1);
  advance(5_000);
  expect(batches.map((b) => b.map((r) => r.id))).toEqual([["a"], ["b"]]);
});

it("rejects a recording with no vehicle reports", async () => {
  vi.stubGlobal("fetch", async () => new Response("\n"));
  await expect(loadRecording("/empty.ndjson")).rejects.toThrow("no vehicle reports");
});
