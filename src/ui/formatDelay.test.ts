import { describe, expect, it } from "vitest";
import { formatDelay } from "./formatDelay";

describe("formatDelay", () => {
  it.each([
    [180, "+3 min"],
    [0, "on time"],
    [-20, "on time"],
    [-60, "-1 min"],
    [150, "+3 min"],
    [89, "+1 min"],
    [null, "delay unknown"],
  ])("%s -> %s", (seconds, expected) => {
    expect(formatDelay(seconds)).toBe(expected);
  });
});
