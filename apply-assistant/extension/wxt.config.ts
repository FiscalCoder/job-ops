import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

/**
 * Apply Copilot. Talks to your apply-assistant server and does every third-party lookup from
 * this browser (your IP), never from the server.
 */
const NODE_ONLY = fileURLToPath(
  new URL("./src/stubs/node-only.ts", import.meta.url),
);

export default defineConfig({
  manifest: {
    name: "Apply Copilot",
    description:
      "Job-board lookups (Greenhouse, Ashby), LinkedIn apply-link capture and supervised applying for your Job Ops queue.",
    // debugger: trusted typing/clicking on the form (React forms ignore synthetic input).
    // webNavigation: tab addresses only, to follow the tab LinkedIn's Apply button opens.
    permissions: [
      "storage",
      "alarms",
      "sidePanel",
      "debugger",
      "webNavigation",
    ],
    host_permissions: [
      "https://apply.hueint.com/*",
      "https://boards-api.greenhouse.io/*",
      "https://job-boards.greenhouse.io/*",
      "https://job-boards.eu.greenhouse.io/*",
      "https://boards.greenhouse.io/*",
      "https://grnh.se/*",
      "https://api.ashbyhq.com/*",
      "https://jobs.ashbyhq.com/*",
      "https://autocomplete.clearbit.com/*",
    ],
    // Company careers pages (embedded Greenhouse boards): asked for once, from the side panel.
    optional_host_permissions: ["https://*/*"],
    action: { default_title: "Apply Copilot" },
    side_panel: { default_path: "sidepanel.html" },
  },
  vite: () => ({
    resolve: {
      alias: [
        // puppeteer-core lazily imports its Node launcher; never used when attaching to a tab.
        { find: "@puppeteer/browsers", replacement: NODE_ONLY },
        {
          find: /^\.\.\/node\/(LaunchOptions|NodeWebSocketTransport)\.js$/,
          replacement: NODE_ONLY,
        },
        // Upstream Job Ops package, imported read-only (no copy, no edits).
        {
          find: "@career-boards/greenhouse",
          replacement: fileURLToPath(
            new URL(
              "../../career-boards/greenhouse/src/index.ts",
              import.meta.url,
            ),
          ),
        },
      ],
    },
  }),
});
