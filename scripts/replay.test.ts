// Replays a saved spike capture through the real source, store and frame loop.
// REPLAY=~/scratch/entur-vehicles-spike/capture-query-none.json npm run replay
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { STALE_MS, TRAIL_MS, VehicleStore } from "../src/vehicles/store";
import type { VehicleReport } from "../src/vehicles/types";

const sink = vi.hoisted(() => ({ next: (_msg: unknown) => {} }));
vi.mock("graphql-ws", () => ({
  createClient: () => ({
    subscribe: (_: unknown, s: typeof sink) => {
      sink.next = s.next;
      return () => {};
    },
    dispose: () => {},
  }),
}));
const { vehicleSource } = await import("../src/vehicles/source");

const FRAME_MS = 1000 / 60;
const file = process.env.REPLAY;

it.runIf(file)("replays a capture", () => {
  const capture = JSON.parse(readFileSync(file!, "utf8")) as {
    messages: { t: number; msg: { type: string; payload: unknown } }[];
  };
  const messages = capture.messages.filter((m) => m.msg.type === "next");

  const store = new VehicleStore(() => 0);
  const latest = new Map<string, VehicleReport>();
  let now = messages[0]!.t;
  vehicleSource((reports) => {
    for (const r of reports) if ((latest.get(r.id)?.recordedAt ?? -Infinity) < r.recordedAt) latest.set(r.id, r);
    store.ingest(reports, now);
  });

  const frameMs: number[] = [];
  const rebuildMs: number[] = [];
  let frame = store.frame(now);
  let next = 0;
  for (const end = messages.at(-1)!.t; now <= end; now += FRAME_MS) {
    while (next < messages.length && messages[next]!.t <= now) sink.next(messages[next++]!.msg.payload);
    const prev = frame.trails;
    const t0 = performance.now();
    frame = store.frame(now);
    (frame.trails === prev ? frameMs : rebuildMs).push(performance.now() - t0);
  }

  const known = [...latest.values()].filter((r) => r.recordedAt >= now - (STALE_MS + TRAIL_MS));
  const alive = known.filter((r) => !r.journeyEnded && now - r.recordedAt <= STALE_MS);
  const pct = (ms: number[], p: number) => [...ms].sort((a, b) => a - b)[Math.floor(p * (ms.length - 1))]!.toFixed(3);
  const stats = (ms: number[]) => `${ms.length} frames, p50 ${pct(ms, 0.5)} ms, p95 ${pct(ms, 0.95)} ms, max ${pct(ms, 1)} ms`;
  process.stdout.write(
    [
      `messages ${messages.length}, distinct ids ${latest.size}, simulated ${((now - messages[0]!.t) / 60_000).toFixed(1)} min`,
      `known ${known.length}, visible ${frame.poses.length}, stale ${known.length - frame.poses.length}`,
      `trails ${frame.trails.length}, trail points ${frame.trails.reduce((n, t) => n + t.path.length, 0)}`,
      `frame(), same trails: ${stats(frameMs)}`,
      `frame(), trails rebuilt: ${stats(rebuildMs)}`,
    ].join("\n") + "\n",
  );
  expect(frame.poses.length).toBe(alive.length);
});
