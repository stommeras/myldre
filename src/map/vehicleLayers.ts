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
/** Dot core radius in pixels at all of Norway (zoom 4.7) and at city zoom (11.6), from the swarm prototype. */
const DOT_PX = { far: 1.6, near: 3 };
const HALO_SCALE = 4;
/**
 * A trail fades over this much wall time, clamped to [MIN_TRAIL_MS, TRAIL_MS] of sim time: 2 min at 1x,
 * 150 s at 10x, the store's 5 min from 20x up. Retaining 15 min for 60x, as the prototype drew, cost
 * 40% of the frame rate for slightly longer trails (M8, measured at zoom 6.3). Tune by eye.
 */
const TRAIL_WALL_MS = 15_000;
const MIN_TRAIL_MS = 2 * 60_000;
/** A vehicle whose drawn position hasn't changed for this long, in sim time, dims. */
const STAND_MS = 15_000;
/** Light adds up, so dense places glow brighter. Nothing writes depth, so light shows through terrain edges. */
const ADDITIVE = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one",
  depthCompare: "always",
  depthWriteEnabled: false,
} as const;

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

  // Where each vehicle was last seen moving. Rebuilt every frame, so forgotten vehicles drop out.
  let moved = new Map<VehicleId, { lng: number; lat: number; at: number }>();

  // ponytail: always-on rAF. Something is always tweening with ~1200 vehicles. Pause on
  // document.hidden if battery matters.
  // M6 follow camera: take a `followed: () => VehicleId | null` here and jumpTo its pose from `f`.
  let raf = requestAnimationFrame(function tick() {
    const now = clock.now();
    const frame = store.frame(now);
    const next = new Map<VehicleId, { lng: number; lat: number; at: number }>();
    const standing = new Set<VehicleId>();
    for (const { id, position: [lng, lat] } of frame.poses) {
      const last = moved.get(id);
      const at = last && last.lng === lng && last.lat === lat ? last.at : now;
      next.set(id, { lng, lat, at });
      if (now - at > STAND_MS) standing.add(id);
    }
    moved = next;
    const trailMs = Math.min(TRAIL_MS, Math.max(MIN_TRAIL_MS, clock.speed * TRAIL_WALL_MS));
    overlay.setProps({ layers: vehicleLayers(frame, standing, map.getZoom(), seconds(now), seconds, trailMs) });
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
 * `poses` is a new array every frame, so position, color and orientation are recomputed for every
 * instance. `trails` keeps its reference until a trail changes, so between changes the trail
 * layer only updates its `currentTime` uniform.
 */
function vehicleLayers(
  { poses, trails }: Frame,
  standing: ReadonlySet<VehicleId>,
  zoom: number,
  nowSeconds: number,
  seconds: (epochMs: number) => number,
  trailMs: number,
): Layer[] {
  const models = modelOpacity(zoom);
  const near = Math.min(1, Math.max(0, (zoom - 4.7) / (11.6 - 4.7)));
  const dot = DOT_PX.far + (DOT_PX.near - DOT_PX.far) * near;
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
      trailLength: trailMs / 1000,
      fadeTrail: true,
      widthMinPixels: dot * 0.75,
      opacity: 0.8,
      parameters: ADDITIVE,
    }),
    new ScatterplotLayer<VehiclePose>({
      id: "halo",
      data: poses,
      visible: models < 1,
      opacity: 1 - models,
      getPosition: (d) => d.position,
      getFillColor: (d) => tint(d.mode, standing.has(d.id) ? 15 : 60),
      radiusUnits: "pixels",
      getRadius: dot * HALO_SCALE,
      billboard: true,
      parameters: ADDITIVE,
    }),
    new ScatterplotLayer<VehiclePose>({
      id: "dots",
      data: poses,
      visible: models < 1,
      opacity: 1 - models,
      getPosition: (d) => d.position,
      getFillColor: (d) => (standing.has(d.id) ? tint(d.mode, 90) : [255, 245, 225, 255]),
      radiusUnits: "pixels",
      getRadius: dot,
      billboard: true,
      pickable: true,
      parameters: ADDITIVE,
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

function tint(mode: Mode, alpha: number): Color {
  const [r, g, b] = GLOW[mode];
  return [r, g, b, alpha];
}

/** 0 at DOTS_ZOOM and below, 1 at MODELS_ZOOM and above, smoothstep between. */
function modelOpacity(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - DOTS_ZOOM) / (MODELS_ZOOM - DOTS_ZOOM)));
  return t * t * (3 - 2 * t);
}
