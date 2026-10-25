import { Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** Fjords read flat at 1x. Tune by eye. */
const EXAGGERATION = 1.5;

setWorkerUrl(workerUrl);

/** Full-screen dark map with terrain, tilted over Bergen. */
export function createMap(container: HTMLElement): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: STYLE,
    center: [5.325, 60.385],
    zoom: 12.5,
    pitch: 60,
    bearing: 20,
    maxPitch: 85,
    canvasContextAttributes: { antialias: true },
  });
  map.on("load", () => {
    map.addSource("dem", { type: "raster-dem", tiles: [TERRARIUM], encoding: "terrarium", tileSize: 256, maxzoom: 15 });
    map.setTerrain({ source: "dem", exaggeration: EXAGGERATION });
    map.addLayer({
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      paint: { "hillshade-exaggeration": 0.6, "hillshade-illumination-anchor": "map", "hillshade-highlight-color": "#556" },
    });
  });
  return map;
}
