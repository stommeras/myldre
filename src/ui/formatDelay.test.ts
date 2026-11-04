import { describe, expect, it } from "vitest";
import { formatDelay } from "./formatDelay";

describe("formatDelay", () => {
  it.each([
    [180, "+3 min"],
    [0, "i rute"],
    [-20, "i rute"],
    [-60, "-1 min"],
    [150, "+3 min"],
    [89, "+1 min"],
    [-90, "-2 min"],
    [90, "+2 min"],
    [-150, "-3 min"],
    [null, "ukjent forsinkelse"],
  ])("%s -> %s", (seconds, expected) => {
    expect(formatDelay(seconds)).toBe(expected);
  });
});
