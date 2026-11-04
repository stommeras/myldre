import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { MODEL } from "./vehicleLayers";

test("every mode's model file exists in public/", () => {
  for (const url of Object.values(MODEL)) expect(existsSync(`public${url}`), url).toBe(true);
});
