import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Map as MapLibreMap } from "maplibre-gl";
import { BERGEN, createMap, NORWAY } from "./map/createMap";
import { attachVehicleLayers } from "./map/vehicleLayers";
import { InfoCard } from "./ui/InfoCard";
import { journeyShapes } from "./vehicles/shapes";
import { loadRecording, ReplayClock, replaySource } from "./vehicles/replay";
import { vehicleSource } from "./vehicles/source";
import { VehicleStore } from "./vehicles/store";
import type { Clock, VehicleId, VehicleSource } from "./vehicles/types";

/**
 * Composition root and the only bridge between plain state and Solid. Two signals cross it:
 * the store's `version`, mirrored after each ingest, and the picked vehicle id. The card pulls
 * `store.info()` when either changes. The store never imports Solid, and deck never sees a signal.
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
  const info = createMemo(() => {
    version();
    const id = selected();
    return id ? store.info(id, clock.now()) : null;
  });

  onMount(() => {
    map = createMap(container, live ? BERGEN : NORWAY);
    const m = map;
    let detach: (() => void) | undefined;
    let stop: (() => void) | undefined;
    let unmounted = false;
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
      const name = params.get("recording") ?? "2026-11-03-evening";
      loadRecording(`/recordings/${name}.ndjson.gz`).then(
        (recording) => {
          if (unmounted) return;
          const replayClock = new ReplayClock(recording, Number(params.get("speed")) || 1);
          clock = replayClock;
          start(replaySource(recording, replayClock));
        },
        (err) => console.error("recording failed to load", err),
      );
    }
    onCleanup(() => {
      unmounted = true;
      stop?.();
      detach?.();
      m.remove();
    });
  });

  return (
    <>
      <div ref={container} class="map" />
      <InfoCard info={info()} onClose={() => setSelected(null)} />
    </>
  );
}
