import { decodeLine } from "./entur";
import { FORGET_MS } from "./store";
import type { Clock, VehicleReport, VehicleSource } from "./types";

export interface Recording {
  startMs: number;
  endMs: number;
  /** Sorted by arrivalMs. */
  entries: { arrivalMs: number; report: VehicleReport }[];
}

export class RecordingMissing extends Error {}

export type Playback =
  | { kind: "loading" }
  | { kind: "failed"; name: string; missing: boolean }
  | { kind: "playing"; clock: ReplayClock; source: VehicleSource };

type Page = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/**
 * Plays `public/recordings/<name>.ndjson.gz`. Reports loading, then playing or failed. While it
 * plays, a hidden page pauses the clock and keeps the chosen speed. The returned stop cancels a
 * pending load and drops the page listener. Nothing is reported after stop.
 */
export function playRecording(name: string, speed: number, onChange: (p: Playback) => void, page: Page = document): () => void {
  const loading = new AbortController();
  let clock: ReplayClock | undefined;
  const onVisibility = () => clock?.setPaused(page.hidden);
  onChange({ kind: "loading" });
  loadRecording(`/recordings/${name}.ndjson.gz`, loading.signal).then(
    (recording) => {
      if (loading.signal.aborted) return;
      clock = new ReplayClock(recording, speed);
      clock.setPaused(page.hidden);
      page.addEventListener("visibilitychange", onVisibility);
      onChange({ kind: "playing", clock, source: replaySource(recording, clock) });
    },
    (err) => {
      if (loading.signal.aborted) return;
      console.error("recording failed to load", err);
      onChange({ kind: "failed", name, missing: err instanceof RecordingMissing });
    },
  );
  return () => {
    loading.abort();
    page.removeEventListener("visibilitychange", onVisibility);
  };
}

const YIELD_AFTER_MS = 50;

/** Dev server or browser may or may not have decoded the gzip already, so sniff the magic bytes. */
export async function loadRecording(url: string, signal?: AbortSignal): Promise<Recording> {
  const res = await fetch(url, { signal });
  if (res.status === 404) throw new RecordingMissing(`${url}: not found`);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  // Vite answers a missing file with index.html and a 200.
  if (res.headers.get("content-type")?.includes("text/html")) throw new RecordingMissing(`${url}: not found`);
  const blob = await res.blob();
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzipped = magic[0] === 0x1f && magic[1] === 0x8b;
  const bytes = gzipped ? blob.stream().pipeThrough(new DecompressionStream("gzip")) : blob.stream();
  const reader = bytes.pipeThrough(new TextDecoderStream()).getReader();
  const entries: Recording["entries"] = [];
  const parseLine = (line: string) => entries.push(...decodeLine(line));
  try {
    let rest = "";
    let yieldedAt = performance.now();
    for (;;) {
      // MessageChannel, not setTimeout: background tabs throttle timers to one per second.
      if (performance.now() - yieldedAt > YIELD_AFTER_MS) {
        await new Promise((r) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = r;
          port2.postMessage(null);
        });
        yieldedAt = performance.now();
      }
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (rest + value).split("\n");
      rest = lines.pop()!;
      lines.forEach(parseLine);
    }
    signal?.throwIfAborted();
    parseLine(rest);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  if (entries.length === 0) throw new Error(`${url}: no vehicle reports`);
  entries.sort((a, b) => a.arrivalMs - b.arrivalMs);
  return { startMs: entries[0].arrivalMs, endMs: entries[entries.length - 1].arrivalMs, entries };
}

export const LOOP_GAP_MS = FORGET_MS + 60_000;

export class ReplayClock implements Clock {
  readonly loopPeriodMs: number;
  private readonly duration: number;
  private virtual = 0;
  private wallAt: number;

  constructor(
    private readonly recording: Recording,
    private rate: number,
    private readonly wallNow: () => number = () => performance.now(),
  ) {
    this.duration = Math.max(1, recording.endMs - recording.startMs);
    this.loopPeriodMs = this.duration + LOOP_GAP_MS;
    this.wallAt = wallNow();
  }

  private paused = false;

  /** The chosen speed. Still the chosen speed while paused. */
  get speed(): number {
    return this.rate;
  }

  now(): number {
    const v = this.virtual + (this.wallNow() - this.wallAt) * this.running();
    const k = Math.floor(v / this.duration);
    return this.recording.startMs + (v - k * this.duration) + k * this.loopPeriodMs;
  }

  setSpeed(speed: number): void {
    this.rebase();
    this.rate = speed;
  }

  /** Holds sim time without changing the chosen speed. A hidden tab gets no frames, so a running clock would hand every report it missed to one frame. */
  setPaused(paused: boolean): void {
    this.rebase();
    this.paused = paused;
  }

  private running(): number {
    return this.paused ? 0 : this.rate;
  }

  private rebase(): void {
    const t = this.wallNow();
    this.virtual += (t - this.wallAt) * this.running();
    this.wallAt = t;
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
        const shift = k * clock.loopPeriodMs;
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
