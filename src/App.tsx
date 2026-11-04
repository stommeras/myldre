import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { Map as MapLibreMap } from "maplibre-gl";
import { BERGEN, createMap, NORWAY } from "./map/createMap";
import { attachVehicleLayers } from "./map/vehicleLayers";
import { InfoCard } from "./ui/InfoCard";
import { LoadStatus } from "./ui/LoadStatus";
import { SPEEDS, SpeedBar } from "./ui/SpeedBar";
import { journeyShapes } from "./vehicles/shapes";
import { loadRecording, type Playback, RecordingMissing, ReplayClock, replaySource } from "./vehicles/replay";
import { vehicleSource } from "./vehicles/source";
import { VehicleStore } from "./vehicles/store";
import type { Clock, VehicleId, VehicleSource } from "./vehicles/types";

/**
 * Composition root and the only bridge between plain state and Solid. Two signals cross it:
 * the store's `version`, mirrored after each ingest, and the picked vehicle id. The card pulls
 * `store.info()` when either changes, and the selection clears once its vehicle is hidden.
 * The store never imports Solid, and deck never sees a signal.
 */
export function App() {
  let container!: HTMLDivElement;
  let map: MapLibreMap | undefined;
  const params = new URLSearchParams(location.search);
  const live = params.has("live");
  let clock: Clock = { now: () => Date.now(), speed: 1 };
  const store = new VehicleStore({
    elevationAt: (p) => map?.queryTerrainElevation([p[0], p[1]]) ?? null,
    shapeOf: journeyShapes,
  });

  const [version, setVersion] = createSignal(store.version);
  const [selected, setSelected] = createSignal<VehicleId | null>(null);
  const [playback, setPlayback] = createSignal<Playback | null>(live ? null : { kind: "loading" });
  const playing = () => {
    const p = playback();
    return p?.kind === "playing" ? p.clock : null;
  };
  const asked = Number(params.get("speed"));
  const [speed, setSpeed] = createSignal<number>(SPEEDS.find((s) => s === asked) ?? 60);
  const changeSpeed = (s: number) => {
    playing()?.setSpeed(s);
    setSpeed(s);
  };
  const info = createMemo(() => {
    version();
    const id = selected();
    return id ? store.info(id, clock.now()) : null;
  });
  createEffect(() => {
    if (selected() && !info()) setSelected(null);
  });

  onMount(() => {
    map = createMap(container, live ? BERGEN : NORWAY);
    const m = map;
    let detach: (() => void) | undefined;
    let stop: (() => void) | undefined;
    const loading = new AbortController();
    // Browser checks drive the map and store from outside (docs/vehicle-store.md, Answered in M1).
    const expose = () => import.meta.env.DEV && Object.assign(window, { map: m, store, clock });
    const start = (source: VehicleSource) => {
      detach = attachVehicleLayers(m, store, clock, setSelected);
      expose();
      stop = source((reports) => {
        store.ingest(reports, clock.now());
        setVersion(store.version);
      });
    };
    if (live) {
      start(vehicleSource);
    } else {
      const name = params.get("recording") ?? "2026-11-04-morning";
      loadRecording(`/recordings/${name}.ndjson.gz`, loading.signal).then(
        (recording) => {
          const replayClock = new ReplayClock(recording, document.hidden ? 0 : speed());
          clock = replayClock;
          setPlayback({ kind: "playing", clock: replayClock });
          start(replaySource(recording, replayClock));
        },
        (err) => {
          if (loading.signal.aborted) return;
          console.error("recording failed to load", err);
          setPlayback({ kind: "failed", name, missing: err instanceof RecordingMissing });
        },
      );
    }
    // A hidden tab gets no frames, so a running clock would hand every report it missed to one frame.
    const onVisibility = () => playing()?.setSpeed(document.hidden ? 0 : speed());
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      loading.abort();
      stop?.();
      detach?.();
      m.remove();
    });
  });

  return (
    <>
      <div ref={container} class="map" />
      <InfoCard info={info()} onClose={() => setSelected(null)} />
      <LoadStatus playback={playback()} />
      <Show when={playing()}>
        <SpeedBar speed={speed()} onSpeed={changeSpeed} />
      </Show>
    </>
  );
}
