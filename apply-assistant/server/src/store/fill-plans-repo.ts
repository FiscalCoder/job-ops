import type { DatabaseSync } from "node:sqlite";
import type { FillPlan, PlanSummary } from "../plan/planner.js";

/** The latest fill plan per Job Ops job. */

export interface StoredPlan {
  readonly plan: FillPlan;
  readonly builtAt: string;
}

interface PlanRow {
  job_id: string;
  plan_json: string;
  built_at: string;
}

export function createFillPlansRepo(db: DatabaseSync) {
  const getStmt = db.prepare("select * from fill_plans where job_id = ?");
  const allStmt = db.prepare("select * from fill_plans");
  const upsertStmt = db.prepare(
    `insert into fill_plans (job_id, schema_hash, plan_json, auto_count, needs_you_count, est_minutes, built_at)
     values (?, ?, ?, ?, ?, ?, datetime('now'))
     on conflict(job_id) do update set schema_hash = excluded.schema_hash, plan_json = excluded.plan_json,
       auto_count = excluded.auto_count, needs_you_count = excluded.needs_you_count,
       est_minutes = excluded.est_minutes, built_at = excluded.built_at`,
  );

  const toStored = (row: PlanRow): StoredPlan => ({
    plan: JSON.parse(row.plan_json) as FillPlan,
    builtAt: row.built_at,
  });

  return {
    get(jobId: string): StoredPlan | null {
      const row = getStmt.get(jobId) as PlanRow | undefined;
      return row ? toStored(row) : null;
    },
    save(jobId: string, plan: FillPlan): void {
      upsertStmt.run(
        jobId,
        plan.schemaHash,
        JSON.stringify(plan),
        plan.summary.auto,
        plan.summary.needsYou,
        plan.summary.estMinutes,
      );
    },
    jobIds(): string[] {
      return (allStmt.all() as unknown as PlanRow[]).map((r) => r.job_id);
    },
    summaries(): Map<string, { summary: PlanSummary; builtAt: string }> {
      return new Map(
        (allStmt.all() as unknown as PlanRow[]).map((row) => {
          const stored = toStored(row);
          return [
            row.job_id,
            { summary: stored.plan.summary, builtAt: stored.builtAt },
          ];
        }),
      );
    },
  };
}

export type FillPlansRepo = ReturnType<typeof createFillPlansRepo>;
