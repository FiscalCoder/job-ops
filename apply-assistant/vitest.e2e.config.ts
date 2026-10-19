import { defineConfig } from "vitest/config";

/** Browser tests for the web page. Needs Playwright's Chromium (installed at the repo root). */
export default defineConfig({
  test: {
    include: ["server/e2e/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
