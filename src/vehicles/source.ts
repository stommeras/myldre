/**
 * Entur direct (M1 to M3): one graphql-ws subscription, batches of up to 20 full vehicle states.
 * In M4 this file is rewritten in place for the relay. It keeps exporting `vehicleSource`, and no
 * other file changes. The wire format lives in `entur.ts`, which replay and the recorder share.
 */
import { createClient } from "graphql-ws";
import { parseVehicle, QUERY, URL, type WireVehicle } from "./entur";
import type { VehicleSource } from "./types";

/** M1: Bergen. M2: null, all of Norway. */
const BBOX: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null = {
  minLat: 60.25,
  minLon: 5.15,
  maxLat: 60.55,
  maxLon: 5.5,
};

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
