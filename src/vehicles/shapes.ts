import type { JourneyId, LngLat, ShapeLookup } from "./types";

const ENDPOINT = "https://api.entur.io/journey-planner/v3/graphql";
/** Starting values. Tune if Entur answers 429 or a batch takes over 2 s. */
const MAX_ALIASES_PER_POST = 50;
const POST_TIMEOUT_MS = 10_000;

interface Waiter {
  journey: JourneyId;
  resolve: (shape: readonly LngLat[] | null) => void;
  reject: (reason: unknown) => void;
}

/** Wire shape of the GraphQL response, read defensively as `unknown`. */
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;

/** Precision-5 Google polyline (lat then lng) to [lng, lat]. Throws on a malformed string. */
function decode(s: string): LngLat[] {
  if (!/^[?-~]*$/.test(s)) throw new Error("bad polyline characters");
  const out: LngLat[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let r = 0;
    let shift = 0;
    let b: number;
    do {
      if (i >= s.length) throw new Error("truncated polyline");
      b = s.charCodeAt(i++) - 63;
      r += (b & 31) * 2 ** shift;
      shift += 5;
    } while (b >= 32);
    return r % 2 ? -(r + 1) / 2 : r / 2;
  };
  while (i < s.length) {
    lat += next();
    lng += next();
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

function shapeOf(node: unknown): readonly LngLat[] | null {
  if (!isObject(node) || !isObject(node.journeyPattern)) return null;
  const link = node.journeyPattern.pointsOnLink;
  if (!isObject(link) || typeof link.points !== "string") return null;
  const shape = decode(link.points);
  return shape.length > 0 ? shape : null;
}

/** One POST for the batch. Settles every waiter. */
async function send(batch: Waiter[]): Promise<void> {
  const query = `{ ${batch
    .map((w, i) => `j${i}: serviceJourney(id: ${JSON.stringify(w.journey)}) { journeyPattern { pointsOnLink { points } } }`)
    .join(" ")} }`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "ET-Client-Name": "steff-myldre", "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`Journey Planner HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isObject(body)) throw new Error("Journey Planner returned a non-object body");
    const data = isObject(body.data) ? body.data : null;
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const failed = new Set<string>();
    for (const e of errors) {
      const head = isObject(e) && Array.isArray(e.path) ? e.path[0] : undefined;
      if (typeof head === "string") failed.add(head);
    }
    // An error with no alias path can't be pinned on one journey, so it fails them all.
    const unattributed = errors.some((e) => !isObject(e) || !Array.isArray(e.path) || typeof e.path[0] !== "string");
    if (data === null || unattributed) {
      throw new Error(`Journey Planner error: ${JSON.stringify(errors).slice(0, 200)}`);
    }
    batch.forEach((w, i) => {
      const alias = `j${i}`;
      try {
        if (failed.has(alias)) throw new Error(`Journey Planner error for ${w.journey}`);
        if (!(alias in data)) throw new Error(`Journey Planner omitted ${w.journey}`);
        w.resolve(shapeOf(data[alias]));
      } catch (e) {
        w.reject(e);
      }
    });
  } catch (e) {
    for (const w of batch) w.reject(e);
  } finally {
    clearTimeout(timer);
  }
}

const queue: Waiter[] = [];
let inFlight = false;
let scheduled = false;

function pump(): void {
  if (inFlight || queue.length === 0) return;
  inFlight = true;
  const batch = queue.splice(0, MAX_ALIASES_PER_POST);
  void send(batch).finally(() => {
    inFlight = false;
    pump();
  });
}

const fetchShape: ShapeLookup = (journey) =>
  new Promise((resolve, reject) => {
    queue.push({ journey, resolve, reject });
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  });

// ponytail: unbounded, about one polyline per journey seen. Evict by age if a long session grows it.
const shapeByJourney = new Map<JourneyId, Promise<readonly LngLat[] | null>>();

export const journeyShapes: ShapeLookup = (journey) => {
  let shape = shapeByJourney.get(journey);
  if (!shape) {
    shape = fetchShape(journey);
    shape.catch(() => shapeByJourney.delete(journey));
    shapeByJourney.set(journey, shape);
  }
  return shape;
};
