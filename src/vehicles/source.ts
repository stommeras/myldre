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

// TODO: copy the exact query and BoundingBox input type from the spike's capture.mjs.
const QUERY = /* GraphQL */ `
  subscription Vehicles($boundingBox: BoundingBox) {
    vehicles(boundingBox: $boundingBox) {
      vehicleId lastUpdated bearing vehicleStatus mode delay destinationName
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
    { query: QUERY, variables: { boundingBox: BBOX } },
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
  // TODO:
  // recordedAt = Date.parse(w.lastUpdated); lat/lon finite; vehicleId non-empty, else return []
  // id = w.vehicleId as VehicleId   (the one cast that mints a VehicleId)
  // bearing = finite w.bearing ? ((w.bearing % 360) + 360) % 360 : null
  // journeyEnded = w.vehicleStatus === "COMPLETED" || w.vehicleStatus === "CANCELLED"  (null → alive)
  // mode = parseMode(w.mode)
  // journey = w.line?.publicCode ? { line, destination: w.destinationName ?? null, delaySeconds: w.delay ?? null } : null
  throw new Error("not implemented");
}

function parseMode(mode: string | null | undefined): Mode {
  // TODO: BUS → bus, COACH → coach, FERRY / WATER → ferry, RAIL → train, anything else → other
  throw new Error("not implemented");
}
