import { mkdirSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { JobOpsClient } from "./jobops/client.js";
import { openStore } from "./store/db.js";

const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const db = openStore(path.join(config.dataDir, "apply.db"));
const app = createApp({
  jobOps: new JobOpsClient(config.jobOpsBaseUrl),
  db,
  authCacheSeconds: config.authCacheSeconds,
  claude: config.claude
    ? {
        messages: new Anthropic({ apiKey: config.claude.apiKey }).messages,
        mapModel: config.claude.mapModel,
        draftModel: config.claude.draftModel,
      }
    : null,
  log: (line) => console.log(line),
});

const server = app.listen(config.port, () => {
  console.log(
    `[apply-assistant] listening on :${config.port}, Job Ops at ${config.jobOpsBaseUrl}, Claude ${config.claude ? `on (${config.claude.mapModel} / ${config.claude.draftModel})` : "off (no ANTHROPIC_API_KEY)"}`,
  );
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
