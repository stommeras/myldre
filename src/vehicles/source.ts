/**
 * Entur direct (M1 to M3): one graphql-ws subscription, batches of up to 20 full vehicle states.
 * In M4 this file is rewritten in place for the relay. It keeps exporting `vehicleSource`, and no
 * other file changes. Wire types stay in here.
 */
import { createClient } from "graphql-ws";
import type { Mode, VehicleId, VehicleReport, VehicleSource } from "./types";

/** The browser can't set headers on a WebSocket, so the client name rides on the URL (SPIKES.md). */
const URL = "wss://api.entur.io/realtime/v2/vehicles/subscriptions?ET-Client-Name=steff-myldre";

/** M1: Bergen. M2: null, all of Norway. */
const BBOX: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null = {
  minLat: 60.25,
  minLon: 5.15,
  maxLat: 60.55,
  maxLon: 5.5,
};

/** The spike's query, trimmed to what we parse, plus `destinationName` (in the live schema). */
const QUERY = /* GraphQL */ `
  subscription Vehicles($bbox: BoundingBox) {
    vehicles(boundingBox: $bbox) {
      vehicleId mode vehicleStatus lastUpdated bearing delay destinationName
      location { latitude longitude }
      line { publicCode }
    }
  }
`;

/** Wire shape. Not exported. Everything nullable because it's untrusted input. */
interface WireVehicle {
  vehicleId?: string | null;
  lastUpdated?: string | null;
  location?: { latitude?: number | null; longitude?: number | null } | null;
  bearing?: number | null;
  vehicleStatus?: string | null;
  mode?: string | null;
  delay?: number | null;
  destinationName?: string | null;
  line?: { publicCode?: string | null } | null;
}

export const vehicleSource: VehicleSource = (onReports) => {
  // graphql-ws re-subscribes after a reconnect. The burst of repeats and stale records that
  // follows is fine: the store dedupes and hides them.
  const client = createClient({ url: URL, retryAttempts: Infinity, shouldRetry: () => true });
  const unsubscribe = client.subscribe<{ vehicles: WireVehicle[] }>(
    { query: QUERY, variables: { bbox: BBOX } },
    {
      next: (msg) => {
        const reports = (msg.data?.vehicles ?? []).flatMap(parseVehicle);
        if (reports.length > 0) onReports(reports);
      },
      error: (err) => console.warn("entur vehicles subscription failed", err),
      complete: () => {},
    },
  );
  return () => {
    unsubscribe();
    void client.dispose();
  };
};

/** Wire to domain. Drops a record missing id, time or position. Returns [] or [report] for flatMap. */
function parseVehicle(w: WireVehicle): VehicleReport[] {
  const recordedAt = Date.parse(w.lastUpdated ?? "");
  const lat = w.location?.latitude;
  const lng = w.location?.longitude;
  if (!w.vehicleId || !Number.isFinite(recordedAt) || !isFiniteNumber(lat) || !isFiniteNumber(lng)) return [];
  const line = w.line?.publicCode;
  return [
    {
      id: w.vehicleId as VehicleId,
      recordedAt,
      position: [lng, lat],
      bearing: isFiniteNumber(w.bearing) ? ((w.bearing % 360) + 360) % 360 : null,
      journeyEnded: w.vehicleStatus === "COMPLETED" || w.vehicleStatus === "CANCELLED",
      mode: parseMode(w.mode),
      journey: line
        ? { line, destination: w.destinationName ?? null, delaySeconds: isFiniteNumber(w.delay) ? w.delay : null }
        : null,
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
