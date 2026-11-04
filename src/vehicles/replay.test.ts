import { afterEach, expect, it, vi } from "vitest";
import { encodeLine } from "./entur";
import { loadRecording, LOOP_GAP_MS, RecordingMissing, ReplayClock, replaySource, type Recording } from "./replay";
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const wire = (id: string, dest: string) => ({
  vehicleId: id, codespace: { codespaceId: "SKY" }, lastUpdated: "2026-11-04T07:00:00Z",
  location: { latitude: 60.39, longitude: 5.32 }, line: { publicCode: "3" }, destinationName: dest,
});
const LINES_PAST_ONE_CHUNK = 3000;
const ndjson = Array.from({ length: LINES_PAST_ONE_CHUNK }, (_, i) => encodeLine(LINES_PAST_ONE_CHUNK - i, wire(`v${LINES_PAST_ONE_CHUNK - i}`, i % 2 ? "Åsane" : "Bønes")))
  .join("");
const gzip = async (text: string) =>
  new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

it.each([["plain", false], ["gzipped", true]])("loads a %s recording larger than one stream chunk", async (_, gz) => {
  const bytes = gz ? await gzip(ndjson) : new TextEncoder().encode(ndjson);
  vi.stubGlobal("fetch", async () => new Response(bytes));
  const r = await loadRecording("/r.ndjson.gz");
  expect(r.entries.map((e) => e.arrivalMs)).toEqual(Array.from({ length: LINES_PAST_ONE_CHUNK }, (_, i) => i + 1));
  expect(r.entries.map((e) => e.report.id)).toEqual(Array.from({ length: LINES_PAST_ONE_CHUNK }, (_, i) => `SKY:v${i + 1}`));
  expect(r.entries[0].report.journey?.destination).toBe("Åsane");
  expect([r.startMs, r.endMs]).toEqual([1, LINES_PAST_ONE_CHUNK]);
});

it("rejects a truncated gzip", async () => {
  const gz = await gzip(ndjson);
  vi.stubGlobal("fetch", async () => new Response(gz.slice(0, -4)));
  await expect(loadRecording("/r.ndjson.gz")).rejects.toThrow(TypeError);
});

it("rejects a malformed JSON line", async () => {
  vi.stubGlobal("fetch", async () => new Response(`${encodeLine(1, wire("a", "Bønes"))}{oops\n`));
  await expect(loadRecording("/r.ndjson")).rejects.toThrow(SyntaxError);
});

it("rejects with an AbortError when the signal is already aborted", async () => {
  vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    return new Response(ndjson);
  });
  const ac = new AbortController();
  ac.abort();
  await expect(loadRecording("/r.ndjson", ac.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("rejects when aborted mid-parse", async () => {
  vi.stubGlobal("fetch", async () => new Response(await gzip(ndjson)));
  const ac = new AbortController();
  const parse = JSON.parse;
  vi.spyOn(JSON, "parse").mockImplementationOnce((text: string) => (ac.abort(), parse(text)));
  await expect(loadRecording("/r.ndjson.gz", ac.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("treats an HTML response as a missing file", async () => {
  vi.stubGlobal("fetch", async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
  await expect(loadRecording("/r.ndjson.gz")).rejects.toThrow(RecordingMissing);
});

it("treats a 404 as a missing file", async () => {
  vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
  await expect(loadRecording("/r.ndjson.gz")).rejects.toThrow(RecordingMissing);
});

it("rejects when aborted while the last read is pending", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify([1, wire("a", "Bønes")]) + "\n"));
  const ac = new AbortController();
  let sawText = false;
  const proto = ReadableStreamDefaultReader.prototype;
  const read = proto.read;
  vi.spyOn(proto, "read").mockImplementation(function (this: ReadableStreamDefaultReader) {
    const result = read.call(this);
    void result.then((r) => {
      if (typeof r.value === "string") sawText = true;
      else if (r.done && sawText) ac.abort();
    });
    return result;
  } as typeof read);
  await expect(loadRecording("/r.ndjson", ac.signal)).rejects.toMatchObject({ name: "AbortError" });
});
