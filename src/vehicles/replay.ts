import { parseVehicle, type WireVehicle } from "./source";
import { STALE_MS, TRAIL_MS } from "./store";
import type { Clock, VehicleReport, VehicleSource } from "./types";

export interface Recording {
  startMs: number;
  endMs: number;
  /** Sorted by arrivalMs. */
  entries: { arrivalMs: number; report: VehicleReport }[];
}

/** Dev server or browser may or may not have decoded the gzip already, so sniff the magic bytes. */
export async function loadRecording(url: string): Promise<Recording> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const body = gzipped ? new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")) : new Blob([bytes]).stream();
  const text = await new Response(body).text();
  const entries: Recording["entries"] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [arrivalMs, wire] = JSON.parse(line) as [number, unknown];
    if (typeof wire !== "object" || wire === null) continue;
    for (const report of parseVehicle(wire as WireVehicle)) entries.push({ arrivalMs, report });
  }
  if (entries.length === 0) throw new Error(`${url}: no vehicle reports`);
  entries.sort((a, b) => a.arrivalMs - b.arrivalMs);
  return { startMs: entries[0].arrivalMs, endMs: entries[entries.length - 1].arrivalMs, entries };
}

/** Each loop's sim time jumps past the store's forget window, so the previous loop's vehicles are hidden, then forgotten, and sim time stays monotonic. */
export const LOOP_GAP_MS = STALE_MS + TRAIL_MS + 60_000;

export class ReplayClock implements Clock {
  /** Sim time between the same recording instant in consecutive loops. */
  readonly loopMs: number;
  private readonly duration: number;
  private virtual = 0;
  private wallAt: number;

  constructor(
    private readonly recording: Recording,
    private rate: number,
    private readonly wallNow: () => number = () => performance.now(),
  ) {
    this.duration = Math.max(1, recording.endMs - recording.startMs);
    this.loopMs = this.duration + LOOP_GAP_MS;
    this.wallAt = wallNow();
  }

  get speed(): number {
    return this.rate;
  }

  now(): number {
    const v = this.virtual + (this.wallNow() - this.wallAt) * this.rate;
    const k = Math.floor(v / this.duration);
    return this.recording.startMs + (v - k * this.duration) + k * this.loopMs;
  }

  setSpeed(speed: number): void {
    const t = this.wallNow();
    this.virtual += (t - this.wallAt) * this.rate;
    this.wallAt = t;
    this.rate = speed;
  }
}

export function replaySource(recording: Recording, clock: ReplayClock): VehicleSource {
  return (onReports) => {
    const { entries } = recording;
    let i = 0;
    let k = 0;
    let raf = requestAnimationFrame(function tick() {
      const now = clock.now();
      const due: VehicleReport[] = [];
      for (;;) {
        const shift = k * clock.loopMs;
        const e = entries[i];
        if (e.arrivalMs + shift > now) break;
        due.push(k === 0 ? e.report : { ...e.report, recordedAt: e.report.recordedAt + shift });
        if (++i === entries.length) (i = 0), k++;
      }
      if (due.length > 0) onReports(due);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  };
}
