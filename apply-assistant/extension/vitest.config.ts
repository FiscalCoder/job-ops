import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@career-boards/greenhouse": fileURLToPath(
        new URL("../../career-boards/greenhouse/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
