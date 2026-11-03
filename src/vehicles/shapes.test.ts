import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JourneyId, ShapeLookup } from "./types";

const id = (n: number | string) => `SKY:ServiceJourney:${n}` as JourneyId;
const GOOGLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const reply = (data: object, errors?: object[], status = 200) =>
  new Response(JSON.stringify({ data, errors }), { status });
const node = (points: string) => ({ journeyPattern: { pointsOnLink: { points } } });
const aliases = (call: unknown[]) =>
  [...JSON.parse((call[1] as RequestInit).body as string).query.matchAll(/(j\d+): serviceJourney/g)].map((m) => m[1]);
const echo = (call: unknown[]) => reply(Object.fromEntries(aliases(call).map((a) => [a, node(GOOGLE)])));

const fetchMock = vi.fn();
let journeyShapes: ShapeLookup;
beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  ({ journeyShapes } = await import("./shapes"));
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("decodes a known polyline to lng/lat", async () => {
  fetchMock.mockImplementation(async (...c) => echo(c));
  expect(await journeyShapes(id(1))).toEqual([
    [-120.2, 38.5],
    [-120.95, 40.7],
    [-126.453, 43.252],
  ]);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.entur.io/journey-planner/v3/graphql");
  expect(init.headers).toMatchObject({ "ET-Client-Name": "steff-myldre", "Content-Type": "application/json" });
});

it("batches same-tick calls into one POST with one alias each", async () => {
  fetchMock.mockImplementation(async (...c) => echo(c));
  await Promise.all([journeyShapes(id(1)), journeyShapes(id(2)), journeyShapes(id('a"b'))]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(aliases(fetchMock.mock.calls[0])).toEqual(["j0", "j1", "j2"]);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toContain(JSON.stringify(id('a"b')));
});

it("sends 120 calls as POSTs of 50, 50, 20, each only after the last settles", async () => {
  const gates: Array<() => void> = [];
  fetchMock.mockImplementation(
    (...c) => new Promise<Response>((res) => gates.push(() => res(echo(c)))),
  );
  const all = Promise.all(Array.from({ length: 120 }, (_, i) => journeyShapes(id(i))));
  for (const [n, size] of [[1, 50], [2, 50], [3, 20]]) {
    await vi.waitFor(() => expect(gates.length).toBe(n));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(n);
    expect(aliases(fetchMock.mock.calls[n - 1])).toHaveLength(size);
    gates[n - 1]();
  }
  expect(await all).toHaveLength(120);
});

it("resolves null for a missing pattern or points", async () => {
  fetchMock.mockResolvedValue(reply({ j0: null, j1: { journeyPattern: null }, j2: node("") }));
  expect(await Promise.all([journeyShapes(id(1)), journeyShapes(id(2)), journeyShapes(id(3))])).toEqual([null, null, null]);
});

it("rejects only the alias with a GraphQL error", async () => {
  fetchMock.mockResolvedValue(reply({ j0: node(GOOGLE), j1: null }, [{ message: "boom", path: ["j1", "journeyPattern"] }]));
  const [a, b] = await Promise.allSettled([journeyShapes(id(1)), journeyShapes(id(2))]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("rejected");
});

it("rejects every journey on HTTP 500", async () => {
  fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
  const r = await Promise.allSettled([journeyShapes(id(1)), journeyShapes(id(2))]);
  expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
});

it("aborts a hung POST after 10 s", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(
    (_u, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
  );
  const p = Promise.allSettled([journeyShapes(id(1)), journeyShapes(id(2))]);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await p).map((x) => x.status)).toEqual(["rejected", "rejected"]);
});

it("shares one answer between repeated asks for a journey, and retries after a rejection", async () => {
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
  await expect(journeyShapes(id(1))).rejects.toThrow();
  fetchMock.mockImplementation(async (...c) => echo(c));
  const [a, b] = await Promise.all([journeyShapes(id(1)), journeyShapes(id(1))]);
  expect(await journeyShapes(id(1))).toBe(a);
  expect(b).toBe(a);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
