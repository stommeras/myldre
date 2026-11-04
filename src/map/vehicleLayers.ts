import type { Color, Layer } from "@deck.gl/core";
import { TripsLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { ScenegraphLayer } from "@deck.gl/mesh-layers";
import type { Map as MapLibreMap, MapSourceDataEvent } from "maplibre-gl";
import { TRAIL_MS, type Frame, type TrailPath, type VehicleStore, type VehiclePose } from "../vehicles/store";
import type { Clock, Mode, VehicleId } from "../vehicles/types";

export const MODEL: Record<Mode, string> = {
  bus: "/models/bus.glb",
  coach: "/models/bus.glb",
  ferry: "/models/ferry.glb",
  train: "/models/train.glb",
  other: "/models/generic.glb",
};
const MODEL_URLS = [...new Set(Object.values(MODEL))];
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
const DOT_PX = { far: { zoom: 4.7, px: 1.6 }, near: { zoom: 11.6, px: 3 } };
const HALO_SCALE = 4;
const PICK_RADIUS_PX = 8;
const TRAIL_WALL_MS = 15_000;
const MIN_TRAIL_MS = 2 * 60_000;
const DIM_AFTER_STILL_MS = 60_000;
const EASE_TAU_MS = 400;
const ADDITIVE_NO_DEPTH = {
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
  // TripsLayer timestamps are float32 on the GPU, and epoch ms don't fit.
  const t0 = clock.now();
  const seconds = (epochMs: number) => (epochMs - t0) / 1000;
  const overlay = new MapLibreOverlay({
    interleaved: true,
    pickingRadius: PICK_RADIUS_PX,
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

  let moved = new Map<VehicleId, Moved>();
  let wallAt = performance.now();

  // ponytail: always-on rAF. Something is always tweening with ~1200 vehicles. Pause on
  // document.hidden if battery matters.
  // M6 follow camera: take a `followed: () => VehicleId | null` here and jumpTo its pose from `f`.
  let raf = requestAnimationFrame(function tick() {
    const now = clock.now();
    const wall = performance.now();
    const ease = 1 - Math.exp(-(wall - wallAt) / EASE_TAU_MS);
    wallAt = wall;
    const frame = store.frame(now);
    const next = new Map<VehicleId, Moved>();
    for (const { id, position: [lng, lat] } of frame.poses) {
      next.set(id, easeLook(moved.get(id), lng, lat, now, ease));
    }
    moved = next;
    overlay.setProps({ layers: vehicleLayers(frame, (id) => moved.get(id) ?? HIDDEN, map.getZoom(), seconds(now), seconds, trailLengthMs(clock.speed)) });
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
  lookOf: (id: VehicleId) => Look,
  zoom: number,
  nowSeconds: number,
  seconds: (epochMs: number) => number,
  trailMs: number,
): Layer[] {
  const models = modelOpacity(zoom);
  const { far, near } = DOT_PX;
  const dot = mix(far.px, near.px, Math.min(1, Math.max(0, (zoom - far.zoom) / (near.zoom - far.zoom))));
  // No beforeId: vehicles draw above the basemap labels (SPIKES.md, deck.gl#10700).
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
      parameters: ADDITIVE_NO_DEPTH,
    }),
    new ScatterplotLayer<VehiclePose>({
      id: "halo",
      data: poses,
      visible: models < 1,
      opacity: 1 - models,
      getPosition: (d) => d.position,
      getFillColor: (d) => {
        const { dim, fadeIn } = lookOf(d.id);
        return tint(d.mode, mix(60, 15, dim) * fadeIn);
      },
      radiusUnits: "pixels",
      getRadius: dot * HALO_SCALE,
      billboard: true,
      parameters: ADDITIVE_NO_DEPTH,
    }),
    new ScatterplotLayer<VehiclePose>({
      id: "dots",
      data: poses,
      visible: models < 1,
      opacity: 1 - models,
      getPosition: (d) => d.position,
      getFillColor: (d) => core(d.mode, lookOf(d.id)),
      radiusUnits: "pixels",
      getRadius: dot,
      billboard: true,
      pickable: true,
      parameters: ADDITIVE_NO_DEPTH,
    }),
    ...MODEL_URLS.map(
      (url) =>
        new ScenegraphLayer<VehiclePose>({
          id: `models:${url}`,
          data: poses.filter((d) => MODEL[d.mode] === url),
          visible: models > 0,
          opacity: models,
          scenegraph: url,
          sizeScale: 3,
          sizeMinPixels: 1.5,
          _lighting: "pbr",
          getPosition: (d) => d.position,
          getOrientation: (d) => [0, MODEL_YAW_OFFSET - d.bearing, 90],
          getColor: (d) => GLOW[d.mode],
          pickable: true,
        }),
    ),
  ];
}

interface Moved {
  lng: number;
  lat: number;
  stillSince: number;
  dim: number;
  fadeIn: number;
}

type Look = Pick<Moved, "dim" | "fadeIn">;
const HIDDEN: Look = { dim: 0, fadeIn: 0 };

const MOVING_CORE = [255, 245, 225, 255] as const;

function tint(mode: Mode, alpha: number): Color {
  const [r, g, b] = GLOW[mode];
  return [r, g, b, alpha];
}

function core(mode: Mode, { dim, fadeIn }: Look): Color {
  const [r, g, b] = GLOW[mode];
  return [mix(MOVING_CORE[0], r, dim), mix(MOVING_CORE[1], g, dim), mix(MOVING_CORE[2], b, dim), mix(255, 90, dim) * fadeIn];
}

function easeLook(last: Moved | undefined, lng: number, lat: number, now: number, ease: number): Moved {
  const stillSince = last && last.lng === lng && last.lat === lat ? last.stillSince : now;
  const dim = now - stillSince > DIM_AFTER_STILL_MS ? 1 : 0;
  if (!last) return { lng, lat, stillSince, dim, fadeIn: 0 };
  return { lng, lat, stillSince, dim: mix(last.dim, dim, ease), fadeIn: mix(last.fadeIn, 1, ease) };
}

function trailLengthMs(speed: number): number {
  return Math.min(TRAIL_MS, Math.max(MIN_TRAIL_MS, speed * TRAIL_WALL_MS));
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0 at DOTS_ZOOM and below, 1 at MODELS_ZOOM and above, smoothstep between. */
function modelOpacity(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - DOTS_ZOOM) / (MODELS_ZOOM - DOTS_ZOOM)));
  return t * t * (3 - 2 * t);
}
