// Replays a saved spike capture through the real source, store and frame loop.
// REPLAY=~/scratch/entur-vehicles-spike/capture-query-none.json pnpm replay
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

const DELAY_MS = 35_000;
const FRAME_MS = 1000 / 60;
const file = process.env.REPLAY;

it.runIf(file)("replays a capture", () => {
  const capture = JSON.parse(readFileSync(file!, "utf8")) as {
    messages: { t: number; msg: { type: string; payload: unknown } }[];
  };
  const messages = capture.messages.filter((m) => m.msg.type === "next");

  const store = new VehicleStore({ elevationAt: () => 0, shapeOf: () => Promise.resolve(null) });
  const latest = new Map<string, VehicleReport>();
  const firstEnded = new Map<string, number>();
  let now = messages[0]!.t;
  vehicleSource((reports) => {
    for (const r of reports) {
      const prev = latest.get(r.id);
      if ((prev?.recordedAt ?? -Infinity) >= r.recordedAt) continue;
      latest.set(r.id, r);
      if (!r.journeyEnded) firstEnded.delete(r.id);
      else if (!prev?.journeyEnded) firstEnded.set(r.id, r.recordedAt);
    }
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
  const fresh = (r: VehicleReport) => now - r.recordedAt <= STALE_MS;
  const oldAlive = known.filter((r) => !r.journeyEnded && fresh(r));
  const expected = new Set(known.filter((r) => fresh(r) && (!r.journeyEnded || now < firstEnded.get(r.id)! + DELAY_MS)).map((r) => r.id));
  const visible = new Set(frame.poses.map((p) => p.id));
  const driving = [...visible].filter((id) => !expected.has(id));
  const pct = (ms: number[], p: number) => [...ms].sort((a, b) => a - b)[Math.floor(p * (ms.length - 1))]!.toFixed(3);
  const stats = (ms: number[]) => `${ms.length} frames, p50 ${pct(ms, 0.5)} ms, p95 ${pct(ms, 0.95)} ms, max ${pct(ms, 1)} ms`;
  process.stdout.write(
    [
      `messages ${messages.length}, distinct ids ${latest.size}, simulated ${((now - messages[0]!.t) / 60_000).toFixed(1)} min`,
      `known ${known.length}, visible ${frame.poses.length}, stale ${known.length - frame.poses.length}`,
      `old oracle (newest report live) ${oldAlive.length}, expected visible ${expected.size}, ended, still driving to the terminus ${driving.length}`,
      `trails ${frame.trails.length}, trail points ${frame.trails.reduce((n, t) => n + t.path.length, 0)}`,
      `frame(), same trails: ${stats(frameMs)}`,
      `frame(), trails rebuilt: ${stats(rebuildMs)}`,
    ].join("\n") + "\n",
  );
  expect([...expected].filter((id) => !visible.has(id))).toEqual([]);
  expect(driving.filter((id) => !(latest.get(id)!.journeyEnded && fresh(latest.get(id)!)))).toEqual([]);
}, 120_000);
