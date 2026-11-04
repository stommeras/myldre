/**
 * Domain vocabulary shared by the source, the store and the layers (see GLOSSARY.md).
 * No wire types live here. The source parses its wire format into these.
 */

declare const vehicleIdBrand: unique symbol;
/** A physical vehicle's identity, stable across journeys. Only the source's parser mints one. */
export type VehicleId = string & { readonly [vehicleIdBrand]: true };

declare const journeyIdBrand: unique symbol;
/** Entur's service journey id, e.g. `SKY:ServiceJourney:24-202789-20949097`. Only the source's parser mints one. */
export type JourneyId = string & { readonly [journeyIdBrand]: true };

/** [longitude, latitude] in degrees. A tuple so it goes straight into deck.gl accessors. */
export type LngLat = readonly [lng: number, lat: number];

/** [lng, lat, z]. z is metres from `map.queryTerrainElevation()`, exaggeration included. */
export type Position3 = readonly [lng: number, lat: number, z: number];

/**
 * Picks the 3D model. `other` covers everything without its own model (tram, metro, ...).
 */
export type Mode = "bus" | "coach" | "ferry" | "train" | "other";

/** The trip a vehicle runs right now. What the info card shows. */
export interface Journey {
  /** Public line code, e.g. "3". */
  line: string;
  destination: string | null;
  /** Positive means late. */
  delaySeconds: number | null;
}

/**
 * One full state of one vehicle at one moment. Full, never a delta: a source that receives
 * deltas expands them before emitting. There is no `speed` field. Speed is derived from
 * consecutive positions, so there is one way to get it.
 */
export interface VehicleReport {
  id: VehicleId;
  /** When the vehicle recorded this state, epoch ms (Entur `lastUpdated`). Same clock as `Date.now()`. */
  recordedAt: number;
  position: LngLat;
  /** Degrees clockwise from north, or null when the vehicle didn't say. */
  bearing: number | null;
  /**
   * The journey is COMPLETED or CANCELLED. An unknown or null status is `false`, because a null
   * status counts as alive. The parser owns the status enum. The store owns what "ended" means.
   */
  journeyEnded: boolean;
  mode: Mode;
  journey: Journey | null;
  /** The service journey, or null when the feed didn't name one. Names the route shape. */
  journeyId: JourneyId | null;
}

/**
 * Resolves a journey to its route shape, the journey pattern's `pointsOnLink` decoded to lng/lat.
 * Resolves null when the journey has no shape, and the store doesn't ask again while it keeps that
 * journey's entry. Rejects on a transient failure. The store asks again for an unanswered or rejected
 * journey 30 s after the request, then after 60 s, 120 s and so on up to 10 minutes. Should settle
 * within 10 s. Implemented once, by `shapes.ts`.
 */
export type ShapeLookup = (journey: JourneyId) => Promise<readonly LngLat[] | null>;

/**
 * Where vehicle reports come from: the one seam between a wire format and the app.
 * Implemented once, by `source.ts`. M4 rewrites that file for the relay and nothing else changes.
 *
 * Calling it connects. `onReports` receives batches of full domain states. The returned function
 * disconnects. A source reconnects on its own and never surfaces wire types.
 *
 * The contract is loose on purpose, because the store absorbs it: reports may come in any order,
 * may repeat (reconnect bursts), and may include older states of a vehicle (the relay's trail
 * history, sent as ordinary reports in the snapshot batch). Filtering stale vehicles is optional.
 * The store applies the stale rule either way.
 */
export type VehicleSource = (onReports: (reports: VehicleReport[]) => void) => () => void;

/** The app's "now", epoch ms. */
export interface Clock { now(): number; readonly speed: number }
