import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

/**
 * Apply Copilot. Talks to your apply-assistant server and does every third-party lookup from
 * this browser (your IP), never from the server.
 */
export default defineConfig({
  manifest: {
    name: "Apply Copilot",
    description:
      "Greenhouse lookups and supervised applying for your Job Ops queue.",
    permissions: ["storage", "alarms", "sidePanel"],
    host_permissions: [
      "https://apply.hueint.com/*",
      "https://boards-api.greenhouse.io/*",
      "https://job-boards.greenhouse.io/*",
      "https://job-boards.eu.greenhouse.io/*",
      "https://boards.greenhouse.io/*",
      "https://grnh.se/*",
      "https://autocomplete.clearbit.com/*",
    ],
    // Company careers pages (embedded Greenhouse boards): asked for once, from the side panel.
    optional_host_permissions: ["https://*/*"],
    action: { default_title: "Apply Copilot" },
    side_panel: { default_path: "sidepanel.html" },
  },
  vite: () => ({
    resolve: {
      alias: {
        // Upstream Job Ops package, imported read-only (no copy, no edits).
        "@career-boards/greenhouse": fileURLToPath(
          new URL(
            "../../career-boards/greenhouse/src/index.ts",
            import.meta.url,
          ),
        ),
      },
    },
  }),
});
