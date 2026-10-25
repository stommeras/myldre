import { Map as MapLibreMap, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** Fjords read flat at 1x. Tune by eye. */
const EXAGGERATION = 1.5;

const MINOR_ROAD = { "line-color": "#3a2a14", "line-opacity": 0.45 };
/** Sodium-lit night, keyed by OpenFreeMap dark's layer ids. */
const PAINT: Record<string, object> = {
  background: { "background-color": "#0b0b0d" },
  water: { "fill-color": "#06161a" },
  waterway: { "line-color": "#06161a" },
  landcover_wood: { "fill-color": "#101210" },
  landuse_park: { "fill-color": "#101210" },
  highway_path: MINOR_ROAD,
  highway_minor: MINOR_ROAD,
  highway_major_casing: MINOR_ROAD,
  highway_motorway_casing: MINOR_ROAD,
  highway_major_inner: { "line-color": "#6a4518", "line-opacity": 0.5 },
  highway_motorway_inner: { "line-color": "#7a5020", "line-opacity": 0.55 },
};
const HIDDEN = new Set([
  "building",
  "highway_name_other",
  "highway_name_motorway",
  "water_name",
  "place_other",
  "place_village",
  "place_suburb",
  "road_oneway",
  "road_oneway_opposite",
  "boundary_state",
]);

setWorkerUrl(workerUrl);

function nightStyle(_: StyleSpecification | undefined, style: StyleSpecification): StyleSpecification {
  const layers = style.layers
    .filter((layer) => !HIDDEN.has(layer.id))
    .map((layer) => (layer.id in PAINT ? { ...layer, paint: { ...layer.paint, ...PAINT[layer.id] } } : layer));
  const at = (id: string) => layers.findIndex((layer) => layer.id === id);
  layers.splice(at("waterway"), 0, {
    id: "hillshade",
    type: "hillshade",
    source: "dem",
    paint: {
      "hillshade-exaggeration": 0.5,
      "hillshade-illumination-anchor": "map",
      "hillshade-shadow-color": "#000",
      "hillshade-highlight-color": "#2a2620",
    },
  });
  layers.splice(at("aeroway-taxiway"), 0, {
    id: "building-3d",
    type: "fill-extrusion",
    source: "openmaptiles",
    "source-layer": "building",
    minzoom: 13,
    paint: {
      "fill-extrusion-color": "#1e1a17",
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.95,
      "fill-extrusion-vertical-gradient": true,
    },
  });
  return {
    ...style,
    layers,
    sources: {
      ...style.sources,
      dem: { type: "raster-dem", tiles: [TERRARIUM], encoding: "terrarium", tileSize: 256, maxzoom: 15 },
    },
    terrain: { source: "dem", exaggeration: EXAGGERATION },
    sky: {
      "sky-color": "#07080d",
      "horizon-color": "#3a2614",
      "fog-color": "#1a120c",
      "fog-ground-blend": 0.25,
      "horizon-fog-blend": 0.8,
      "sky-horizon-blend": 0.5,
      "atmosphere-blend": 0,
    },
    light: { anchor: "viewport", color: "#ffcf9a", intensity: 0.25, position: [1.2, 210, 30] },
  };
}

/** Full-screen night map with terrain, tilted over Bergen centre. */
export function createMap(container: HTMLElement): MapLibreMap {
  const map = new MapLibreMap({
    container,
    center: [5.324, 60.393],
    zoom: 15,
    pitch: 60,
    bearing: 20,
    maxPitch: 85,
    canvasContextAttributes: { antialias: true },
  });
  map.setStyle(STYLE, { transformStyle: nightStyle });
  return map;
}
