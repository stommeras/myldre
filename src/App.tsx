import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { Map as MapLibreMap } from "maplibre-gl";
import { BERGEN, createMap, NORWAY } from "./map/createMap";
import { attachVehicleLayers } from "./map/vehicleLayers";
import { InfoCard } from "./ui/InfoCard";
import { LoadStatus } from "./ui/LoadStatus";
import { SPEEDS, SpeedBar } from "./ui/SpeedBar";
import { journeyShapes } from "./vehicles/shapes";
import { type Playback, playRecording } from "./vehicles/replay";
import { vehicleSource } from "./vehicles/source";
import { VehicleStore } from "./vehicles/store";
import type { Clock, VehicleId, VehicleSource } from "./vehicles/types";

const WALL: Clock = { now: () => Date.now(), speed: 1 };

/**
 * Composition root and the only bridge between plain state and Solid. Three signals cross it:
 * the store's `version`, mirrored after each ingest, the picked vehicle id, and the playback state.
 * The card pulls `store.info()` when any changes, and the selection clears once its vehicle is hidden.
 * The store never imports Solid, and deck never sees a signal.
 */
export function App() {
  let container!: HTMLDivElement;
  let map: MapLibreMap | undefined;
  const params = new URLSearchParams(location.search);
  const live = params.has("live");
  const store = new VehicleStore({
    elevationAt: (p) => map?.queryTerrainElevation([p[0], p[1]]) ?? null,
    shapeOf: journeyShapes,
  });

  const [version, setVersion] = createSignal(store.version);
  const [selected, setSelected] = createSignal<VehicleId | null>(null);
  const [playback, setPlayback] = createSignal<Playback | null>(null);
  const playing = () => {
    const p = playback();
    return p?.kind === "playing" ? p.clock : null;
  };
  const clock = (): Clock => playing() ?? WALL;
  const asked = Number(params.get("speed"));
  const [speed, setSpeed] = createSignal<number>(SPEEDS.find((s) => s === asked) ?? 60);
  const changeSpeed = (s: number) => {
    playing()?.setSpeed(s);
    setSpeed(s);
  };
  const info = createMemo(() => {
    version();
    const id = selected();
    return id ? store.info(id, clock().now()) : null;
  });
  createEffect(() => {
    if (selected() && !info()) setSelected(null);
  });

  onMount(() => {
    map = createMap(container, live ? BERGEN : NORWAY);
    const m = map;
    let detach: (() => void) | undefined;
    let stop: (() => void) | undefined;
    const start = (source: VehicleSource, clock: Clock) => {
      detach = attachVehicleLayers(m, store, clock, setSelected);
      // Browser checks drive the map and store from outside (docs/vehicle-store.md, Answered in M1).
      if (import.meta.env.DEV) Object.assign(window, { map: m, store, clock });
      stop = source((reports) => {
        store.ingest(reports, clock.now());
        setVersion(store.version);
      });
    };
    let stopLoad: (() => void) | undefined;
    if (live) start(vehicleSource, WALL);
    else {
      stopLoad = playRecording(params.get("recording") ?? "2026-11-04-morning", speed(), (p) => {
        setPlayback(p);
        if (p.kind === "playing") start(p.source, p.clock);
      });
    }
    onCleanup(() => {
      stopLoad?.();
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
