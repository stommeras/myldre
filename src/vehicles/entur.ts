/**
 * The Entur vehicles wire format and the recording line format built on it. Wire types stay in
 * here. The live source, the replay loader and the recorder all go through this module.
 */
import type { JourneyId, Mode, VehicleId, VehicleReport } from "./types";

/** The browser can't set headers on a WebSocket, so the client name rides on the URL (SPIKES.md). */
export const URL = "wss://api.entur.io/realtime/v2/vehicles/subscriptions?ET-Client-Name=steff-myldre";

/** The spike's query, trimmed to what we parse, plus `destinationName` (in the live schema). */
export const QUERY = /* GraphQL */ `
  subscription Vehicles($bbox: BoundingBox) {
    vehicles(boundingBox: $bbox) {
      vehicleId mode vehicleStatus lastUpdated bearing delay destinationName
      location { latitude longitude }
      line { publicCode }
      codespace { codespaceId }
      serviceJourney { id }
    }
  }
`;

/** Wire shape. Everything nullable because it's untrusted input. */
export interface WireVehicle {
  vehicleId?: string | null;
  codespace?: { codespaceId?: string | null } | null;
  lastUpdated?: string | null;
  location?: { latitude?: number | null; longitude?: number | null } | null;
  bearing?: number | null;
  vehicleStatus?: string | null;
  mode?: string | null;
  delay?: number | null;
  destinationName?: string | null;
  line?: { publicCode?: string | null } | null;
  serviceJourney?: { id?: string | null } | null;
}

/** One recording line, newline included: `[arrivalMs, wire]`, with the wire vehicle exactly as received. */
export function encodeLine(arrivalMs: number, wire: unknown): string {
  return JSON.stringify([arrivalMs, wire]) + "\n";
}

/** The reports in one recording line. [] for a blank line or one whose record doesn't parse. Throws on bad JSON. */
export function decodeLine(line: string): { arrivalMs: number; report: VehicleReport }[] {
  if (!line) return [];
  const [arrivalMs, wire] = JSON.parse(line) as [number, unknown];
  if (typeof wire !== "object" || wire === null) return [];
  return parseVehicle(wire as WireVehicle).map((report) => ({ arrivalMs, report }));
}

/**
 * Wire to domain. Drops a record missing id, codespace, time or position. Each operator picks its
 * own vehicle ids, so the id is prefixed with the codespace, e.g. `SKY:101`.
 * Returns [] or [report] for flatMap.
 */
export function parseVehicle(w: WireVehicle): VehicleReport[] {
  const recordedAt = Date.parse(w.lastUpdated ?? "");
  const lat = w.location?.latitude;
  const lng = w.location?.longitude;
  const codespace = w.codespace?.codespaceId;
  if (!w.vehicleId || !codespace || !Number.isFinite(recordedAt) || !isFiniteNumber(lat) || !isFiniteNumber(lng)) return [];
  const line = w.line?.publicCode;
  const journeyId = w.serviceJourney?.id;
  return [
    {
      id: `${codespace}:${w.vehicleId}` as VehicleId,
      recordedAt,
      position: [lng, lat],
      bearing: isFiniteNumber(w.bearing) ? ((w.bearing % 360) + 360) % 360 : null,
      journeyEnded: w.vehicleStatus === "COMPLETED" || w.vehicleStatus === "CANCELLED",
      mode: parseMode(w.mode),
      journey: line
        ? { line, destination: w.destinationName ?? null, delaySeconds: isFiniteNumber(w.delay) ? w.delay : null }
        : null,
      journeyId: journeyId ? (journeyId as JourneyId) : null,
    },
  ];
}

/** Entur's VehicleModeEnumeration. TRAM, METRO, AIR and TAXI fall through to `other`. */
const MODES = new Map<string, Mode>([
  ["BUS", "bus"],
  ["COACH", "coach"],
  ["FERRY", "ferry"],
  ["RAIL", "train"],
]);

function parseMode(mode: string | null | undefined): Mode {
  return MODES.get(mode ?? "") ?? "other";
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
