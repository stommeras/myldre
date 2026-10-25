import { expect, it, vi } from "vitest";
import type { VehicleReport } from "./types";

const sink = vi.hoisted(() => ({ next: (_msg: unknown) => {} }));
vi.mock("graphql-ws", () => ({
  createClient: () => ({
    subscribe: (_: unknown, s: typeof sink) => {
      sink.next = s.next;
      return () => {};
    },
    dispose: () => {},
  }),
}));
const { vehicleSource } = await import("./source");

const wire = (over: object) => ({
  vehicleId: "1",
  codespace: { codespaceId: "SKY" },
  lastUpdated: "2026-10-25T14:26:04.367Z",
  location: { latitude: 60.39, longitude: 5.3 },
  bearing: 370,
  vehicleStatus: null,
  mode: "BUS",
  delay: 12,
  destinationName: "Sentrum",
  line: { publicCode: "3" },
  ...over,
});

it("parses wire vehicles into reports", () => {
  const got: VehicleReport[] = [];
  vehicleSource((r) => got.push(...r));
  sink.next({
    data: {
      vehicles: [
        wire({}),
        wire({ vehicleId: "2", vehicleStatus: "COMPLETED", mode: "TRAM", bearing: null, line: null }),
        wire({ vehicleId: "3", location: { latitude: null, longitude: 5.3 } }),
        wire({ vehicleId: "4", codespace: null }),
      ],
    },
  });
  expect(got).toEqual([
    {
      id: "SKY:1",
      recordedAt: Date.parse("2026-10-25T14:26:04.367Z"),
      position: [5.3, 60.39],
      bearing: 10,
      journeyEnded: false,
      mode: "bus",
      journey: { line: "3", destination: "Sentrum", delaySeconds: 12 },
    },
    expect.objectContaining({ id: "SKY:2", journeyEnded: true, mode: "other", bearing: null, journey: null }),
  ]);
});
