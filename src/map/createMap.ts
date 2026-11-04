import { Map as MapLibreMap, setWorkerUrl, type LayerSpecification, type MapOptions, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** Fjords read flat at 1x. Tune by eye. */
const EXAGGERATION = 1.5;
const BASE = "#04060a";
const WATER = "#0a1624";
const PLACES = new Set(["place_city_large", "place_city", "place_town"]);

type Opening = Pick<MapOptions, "bounds" | "center" | "zoom" | "pitch" | "bearing">;
export const NORWAY: Opening = { bounds: [[4.5, 57.9], [31.2, 71.2]] };
export const BERGEN: Opening = { center: [5.324, 60.393], zoom: 15, pitch: 60, bearing: 20 };

setWorkerUrl(workerUrl);

function swarmLayer(l: LayerSpecification): LayerSpecification[] {
  const id = l.id;
  if (l.type === "background") return [{ ...l, paint: { "background-color": BASE } }];
  if (l.type === "fill") {
    if (id === "water") return [{ ...l, paint: { "fill-color": WATER } }];
    return id === "building" ? [] : [{ ...l, paint: { "fill-color": "#06090e" } }];
  }
  if (l.type === "line") {
    if (id === "waterway") return [{ ...l, paint: { ...l.paint, "line-color": WATER } }];
    if (id.startsWith("highway") && !id.includes("casing")) return [{ ...l, paint: { ...l.paint, "line-color": "#1a2433", "line-opacity": 0.6 } }];
    return [];
  }
  if (l.type === "symbol" && PLACES.has(id)) return [{ ...l, paint: { "text-color": "#3d4d63", "text-halo-color": BASE, "text-halo-width": 1 } }];
  return [];
}

function swarmStyle(_: StyleSpecification | undefined, style: StyleSpecification): StyleSpecification {
  const layers = style.layers.flatMap(swarmLayer);
  layers.splice(layers.findIndex((l) => l.id === "waterway"), 0, {
    id: "hillshade",
    type: "hillshade",
    source: "dem",
    paint: {
      "hillshade-exaggeration": 0.35,
      "hillshade-illumination-anchor": "map",
      "hillshade-shadow-color": "#000",
      "hillshade-highlight-color": "#101a28",
      "hillshade-accent-color": "#000",
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
      "sky-color": "#02040a",
      "horizon-color": "#0c1626",
      "fog-color": "#060b14",
      "fog-ground-blend": 0.25,
      "horizon-fog-blend": 0.8,
      "sky-horizon-blend": 0.5,
      "atmosphere-blend": 0,
    },
  };
}

export function createMap(container: HTMLElement, camera: Opening): MapLibreMap {
  const map = new MapLibreMap({ container, ...camera, maxPitch: 85, canvasContextAttributes: { antialias: true } });
  map.setStyle(STYLE, { transformStyle: swarmStyle });
  return map;
}
