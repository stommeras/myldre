import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Map as MapLibreMap } from "maplibre-gl";
import { attachVehicleLayers } from "./map/vehicleLayers";
import { InfoCard } from "./ui/InfoCard";
import { vehicleSource } from "./vehicles/source";
import { VehicleStore } from "./vehicles/store";
import type { VehicleId } from "./vehicles/types";

/** Map setup (style, terrain, camera) is outside this sketch. */
declare function createMap(container: HTMLElement): MapLibreMap;

/**
 * Composition root and the only bridge between plain state and Solid. Two signals cross it:
 * the store's `version`, mirrored after each ingest, and the picked vehicle id. The card pulls
 * `store.info()` when either changes. The store never imports Solid, and deck never sees a signal.
 */
export function App() {
  let container!: HTMLDivElement;
  let map: MapLibreMap | undefined;
  const store = new VehicleStore((p) => map?.queryTerrainElevation([p[0], p[1]]) ?? null);

  const [version, setVersion] = createSignal(store.version);
  const [selected, setSelected] = createSignal<VehicleId | null>(null);
  const info = createMemo(() => {
    version();
    const id = selected();
    return id ? store.info(id, Date.now()) : null;
  });

  onMount(() => {
    map = createMap(container);
    const detach = attachVehicleLayers(map, store, setSelected);
    const stop = vehicleSource((reports) => {
      store.ingest(reports, Date.now());
      setVersion(store.version);
    });
    onCleanup(() => {
      stop();
      detach();
      map?.remove();
    });
  });

  return (
    <>
      <div ref={container} class="map" />
      <InfoCard info={info()} onClose={() => setSelected(null)} />
    </>
  );
}
