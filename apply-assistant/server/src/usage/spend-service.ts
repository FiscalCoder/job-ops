import type { DatabaseSync } from "node:sqlite";
import { runAsUser } from "../store/owner.js";
import type { Run, RunsRepo } from "../store/runs-repo.js";
import type { TraceStore } from "../store/trace-store.js";
import type { UserSettingsRepo } from "../store/user-settings-repo.js";
import {
  runSpend,
  type Spend,
  type SpendSummary,
  summaryOf,
} from "./claude-spend.js";

/** Claude spend per run and per user, read from the signed-in user's trace and runs. */

export interface RunCost extends Spend {
  readonly runId: string;
  readonly jobId: string;
}

export interface SpendServiceDeps {
  readonly runs: RunsRepo;
  readonly trace: TraceStore;
  readonly settings: UserSettingsRepo;
  readonly now?: () => number;
}

export function createSpendService({
  runs,
  trace,
  settings,
  now = Date.now,
}: SpendServiceDeps) {
  const runCost = (run: Run): RunCost => ({
    runId: run.id,
    jobId: run.jobId,
    ...runSpend(run.id, trace.claudeUsage(run.jobId), runs.listByJob(run.jobId), now()),
  });

  return {
    runCost,
    /** Stores a finished run's cost in runs.model_cost; returns it. */
    recordRunCost(run: Run): number {
      const { costUsd } = runCost(run);
      runs.setModelCost(run.id, costUsd);
      return costUsd;
    },
    summary(): SpendSummary {
      return summaryOf(trace.claudeUsage(), settings.claudeCredit(), now());
    },
  };
}

export type SpendService = ReturnType<typeof createSpendService>;

/**
 * One-off, idempotent: fills model_cost for every user's finished runs that still have 0.
 * Runs that truly cost nothing stay 0 and are simply looked at again next time. Called once
 * at startup (cheap: one query per user, then the trace of each such run's job).
 * Returns how many runs got a cost.
 */
export function backfillRunCosts(
  db: DatabaseSync,
  service: SpendService,
  runsRepo: RunsRepo,
): number {
  const users = db
    .prepare(
      "select distinct user_id from runs where ended_at is not null and model_cost = 0",
    )
    .all() as { user_id: string }[];
  let filled = 0;
  for (const { user_id } of users)
    runAsUser(user_id, () => {
      for (const run of runsRepo.endedWithoutCost())
        if (service.recordRunCost(run) > 0) filled += 1;
    });
  return filled;
}
