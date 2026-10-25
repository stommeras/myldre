import { MapLibreOverlay } from "@deck.gl/maplibre";
import type { Layer } from "@deck.gl/core";
import type { Map as MapLibreMap, MapSourceDataEvent } from "maplibre-gl";
import type { Frame, VehicleStore, VehiclePose } from "../vehicles/store";
import type { VehicleId } from "../vehicles/types";

/**
 * TripsLayer timestamps are float32 on the GPU, and epoch ms don't fit. Times go to deck as
 * seconds since page load. This is the only place that conversion exists.
 */
const T0 = Date.now();
const seconds = (epochMs: number) => (epochMs - T0) / 1000;

const GENERIC_MODEL = "/models/generic.glb";
/** Below DOTS_ZOOM only dots, above MODELS_ZOOM only models, crossfade between. Tune by eye. */
const DOTS_ZOOM = 9;
const MODELS_ZOOM = 11;

/**
 * Draws the store's vehicles on the map and keeps them moving. Everything deck.gl lives here.
 * Nothing in here is reactive. `onPick` is the only way out, called with the clicked vehicle
 * or null for a click on empty map. Returns a detach function.
 */
export function attachVehicleLayers(
  map: MapLibreMap,
  store: VehicleStore,
  onPick: (id: VehicleId | null) => void,
): () => void {
  const overlay = new MapLibreOverlay({
    interleaved: true,
    layers: [],
    onClick: (info) => onPick((info.object as VehiclePose | undefined)?.id ?? null),
  });
  map.addControl(overlay);

  // Terrain z: each new report samples its own z in the store. When DEM tiles arrive the store
  // re-samples older points over the next frames. Not gated on `idle`, which may never fire
  // while deck animates every frame.
  const onSourceData = (e: MapSourceDataEvent) => {
    if (e.tile && e.sourceId === map.getTerrain()?.source) store.terrainChanged();
  };
  map.on("sourcedata", onSourceData);

  // ponytail: always-on rAF. Something is always tweening with ~1200 vehicles. Pause on
  // document.hidden if battery matters.
  // M6 follow camera: take a `followed: () => VehicleId | null` here and jumpTo its pose from `f`.
  let raf = requestAnimationFrame(function tick() {
    const now = Date.now();
    overlay.setProps({ layers: vehicleLayers(store.frame(now), map.getZoom(), now) });
    raf = requestAnimationFrame(tick);
  });

  return () => {
    cancelAnimationFrame(raf);
    map.off("sourcedata", onSourceData);
    map.removeControl(overlay);
  };
}

/**
 * One frame's layers. New layer instances each frame with stable ids, the deck.gl way.
 * `poses` is a new array every frame, so position and orientation are recomputed for every
 * instance. `trails` keeps its reference until a trail changes, so between changes the trail
 * layer only updates its `currentTime` uniform.
 */
function vehicleLayers({ poses, trails }: Frame, zoom: number, now: number): Layer[] {
  const models = modelOpacity(zoom);
  // TODO:
  // new TripsLayer<TrailPath>({ id: "trails", data: trails,
  //   getPath: d => d.path, getTimestamps: d => d.times.map(seconds),
  //   currentTime: seconds(now), trailLength: TRAIL_MS / 1000, fadeTrail: true,
  //   widthMinPixels: 2, getColor: glow by d.mode })
  // new ScatterplotLayer<VehiclePose>({ id: "dots", data: poses, visible: models < 1, opacity: 1 - models,
  //   getPosition: d => d.position, radiusUnits: "pixels", getRadius: 3, billboard: true,
  //   getFillColor: glow by d.mode, pickable: true })
  // new ScenegraphLayer<VehiclePose>({ id: "models", data: poses, visible: models > 0, opacity: models,
  //   scenegraph: GENERIC_MODEL, sizeScale: 3, getPosition: d => d.position,
  //   getOrientation: d => [0, MODEL_YAW_OFFSET - d.bearing, 90], pickable: true })
  // No beforeId: vehicles draw above the basemap labels (SPIKES.md, deck.gl#10700).
  // M3: one ScenegraphLayer per model, from a Record<Mode, url>, each fed poses filtered by mode.
  throw new Error("not implemented");
}

/** 0 at DOTS_ZOOM and below, 1 at MODELS_ZOOM and above, smoothstep between. */
function modelOpacity(zoom: number): number {
  // TODO: t = clamp01((zoom - DOTS_ZOOM) / (MODELS_ZOOM - DOTS_ZOOM)); return t * t * (3 - 2 * t)
  throw new Error("not implemented");
}
