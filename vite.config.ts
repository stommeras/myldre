import { configDefaults, defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: { environment: "node", exclude: [...configDefaults.exclude, ".claude/**"] },
});
