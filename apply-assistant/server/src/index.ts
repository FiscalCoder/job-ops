import { mkdirSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { JobOpsClient } from "./jobops/client.js";
import { openStore } from "./store/db.js";
import { createRunsRepo } from "./store/runs-repo.js";
import { createTraceStore } from "./store/trace-store.js";
import { createUserSettingsRepo } from "./store/user-settings-repo.js";
import { backfillRunCosts, createSpendService } from "./usage/spend-service.js";

const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const db = openStore(path.join(config.dataDir, "apply.db"));
const log = (line: string) => console.log(line);
const trace = createTraceStore({
  db,
  dir: path.join(config.dataDir, "traces"),
  log,
});
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const prune = () => {
  try {
    const dropped = trace.prune();
    if (dropped.events || dropped.snapshots)
      log(
        `[trace] pruned ${dropped.events} events, ${dropped.snapshots} snapshots`,
      );
  } catch (error) {
    log(`[trace] prune failed: ${String(error)}`);
  }
};
prune();
// One-off, idempotent: store Claude's cost for finished runs that never had it.
try {
  const runsRepo = createRunsRepo(db);
  const filled = backfillRunCosts(
    db,
    createSpendService({
      runs: runsRepo,
      trace,
      settings: createUserSettingsRepo(db),
    }),
    runsRepo,
  );
  if (filled) log(`[usage] stored Claude's cost for ${filled} finished run(s)`);
} catch (error) {
  log(`[usage] cost backfill failed: ${String(error)}`);
}
setInterval(prune, PRUNE_EVERY_MS).unref();
const app = createApp({
  jobOps: new JobOpsClient(config.jobOpsBaseUrl),
  db,
  authCacheSeconds: config.authCacheSeconds,
  claude: {
    messages: config.claude.apiKey
      ? new Anthropic({ apiKey: config.claude.apiKey }).messages
      : null,
    messagesFor: (apiKey) => new Anthropic({ apiKey }).messages,
    mapModel: config.claude.mapModel,
    draftModel: config.claude.draftModel,
  },
  log,
  trace,
});

const server = app.listen(config.port, () => {
  console.log(
    `[apply-assistant] listening on :${config.port}, Job Ops at ${config.jobOpsBaseUrl}, Claude ${config.claude.mapModel} / ${config.claude.draftModel}, server key ${config.claude.apiKey ? "set (the admin's)" : "not set"}`,
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
