import type { Color, Layer } from "@deck.gl/core";
import { TripsLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { ScenegraphLayer } from "@deck.gl/mesh-layers";
import type { Map as MapLibreMap, MapSourceDataEvent } from "maplibre-gl";
import { TRAIL_MS, type Frame, type TrailPath, type VehicleStore, type VehiclePose } from "../vehicles/store";
import type { Clock, Mode, VehicleId } from "../vehicles/types";

const GENERIC_MODEL = "/models/generic.glb";
/** The nose is glTF +Z, which faces south after the 90° roll. Checked by eye with side views at bearings 90 and 225. */
const MODEL_YAW_OFFSET = 180;
/** Glowing accents on the dark base, one per mode. */
const GLOW: Record<Mode, Color> = {
  bus: [255, 170, 60],
  coach: [255, 120, 80],
  ferry: [80, 200, 255],
  train: [190, 130, 255],
  other: [230, 230, 230],
};
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
  clock: Clock,
  onPick: (id: VehicleId | null) => void,
): () => void {
  // TripsLayer timestamps are float32 on the GPU, and epoch ms don't fit. Times go to deck as
  // seconds since attach. This is the only place that conversion exists.
  const t0 = clock.now();
  const seconds = (epochMs: number) => (epochMs - t0) / 1000;
  const overlay = new MapLibreOverlay({
    interleaved: true,
    layers: [],
    onClick: (info) => onPick((info.object as VehiclePose | undefined)?.id ?? null),
  });
  map.addControl(overlay);

  // Terrain z: each new report samples its own z in the store. When DEM tiles arrive the store
  // re-samples older points over the next frames. Not gated on `idle`, which fires every frame
  // because deck repaints every frame.
  const onSourceData = (e: MapSourceDataEvent) => {
    if (e.tile && e.sourceId === map.getTerrain()?.source) store.terrainChanged();
  };
  map.on("sourcedata", onSourceData);

  // ponytail: always-on rAF. Something is always tweening with ~1200 vehicles. Pause on
  // document.hidden if battery matters.
  // M6 follow camera: take a `followed: () => VehicleId | null` here and jumpTo its pose from `f`.
  let raf = requestAnimationFrame(function tick() {
    const now = clock.now();
    overlay.setProps({ layers: vehicleLayers(store.frame(now), map.getZoom(), seconds(now), seconds) });
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
function vehicleLayers({ poses, trails }: Frame, zoom: number, nowSeconds: number, seconds: (epochMs: number) => number): Layer[] {
  const models = modelOpacity(zoom);
  // No beforeId: vehicles draw above the basemap labels (SPIKES.md, deck.gl#10700).
  // M3: one ScenegraphLayer per model, from a Record<Mode, url>, each fed poses filtered by mode.
  return [
    new TripsLayer<TrailPath>({
      id: "trails",
      data: trails,
      // A trail is never a loop. Without "open", deck treats a path that ends where it starts
      // (a parked vehicle) as closed, changes its vertex count, and overflows the timestamps.
      // Open paths skip normalization, so they have to be flat.
      _pathType: "open",
      getPath: (d) => d.path.flat(),
      getTimestamps: (d) => d.times.map(seconds),
      getColor: (d) => GLOW[d.mode],
      currentTime: nowSeconds,
      trailLength: TRAIL_MS / 1000,
      fadeTrail: true,
      widthMinPixels: 2,
    }),
    new ScatterplotLayer<VehiclePose>({
      id: "dots",
      data: poses,
      visible: models < 1,
      opacity: 1 - models,
      getPosition: (d) => d.position,
      getFillColor: (d) => GLOW[d.mode],
      radiusUnits: "pixels",
      getRadius: 3,
      billboard: true,
      pickable: true,
    }),
    new ScenegraphLayer<VehiclePose>({
      id: "models",
      data: poses,
      visible: models > 0,
      opacity: models,
      scenegraph: GENERIC_MODEL,
      sizeScale: 3,
      sizeMinPixels: 1.5,
      _lighting: "pbr",
      getPosition: (d) => d.position,
      getOrientation: (d) => [0, MODEL_YAW_OFFSET - d.bearing, 90],
      getColor: (d) => GLOW[d.mode],
      pickable: true,
    }),
  ];
}

/** 0 at DOTS_ZOOM and below, 1 at MODELS_ZOOM and above, smoothstep between. */
function modelOpacity(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - DOTS_ZOOM) / (MODELS_ZOOM - DOTS_ZOOM)));
  return t * t * (3 - 2 * t);
}
