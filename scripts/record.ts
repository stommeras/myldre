// Records all-Norway vehicle positions for replay (PLAN.md, M8).
// usage: node scripts/record.ts <minutes> <out.ndjson.gz>
// Each line is [arrivalMs, wireVehicle], with wireVehicle exactly as the subscription sent it.
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { createClient } from "graphql-ws";
import { QUERY, URL } from "../src/vehicles/source.ts";

const [minutes, file] = process.argv.slice(2);
if (!Number(minutes) || !file) throw new Error("usage: node scripts/record.ts <minutes> <out.ndjson.gz>");

const gzip = createGzip();
const out = gzip.pipe(createWriteStream(file));
const client = createClient({
  url: URL,
  webSocketImpl: WebSocket,
  retryAttempts: Infinity,
  shouldRetry: () => true,
});
let records = 0;
client.subscribe<{ vehicles: unknown[] }>(
  { query: QUERY, variables: { bbox: null } },
  {
    next: (msg) => {
      const at = Date.now();
      for (const v of msg.data?.vehicles ?? []) gzip.write(JSON.stringify([at, v]) + "\n");
      records += msg.data?.vehicles.length ?? 0;
    },
    error: (err) => console.error("subscription error", err),
    complete: () => {},
  },
);
const log = setInterval(() => console.log(new Date().toISOString(), "records", records), 60_000);
setTimeout(() => {
  clearInterval(log);
  void client.dispose();
  out.on("finish", () => process.exit(0));
  gzip.end();
}, Number(minutes) * 60_000);
