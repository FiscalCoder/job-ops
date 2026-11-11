import type { DatabaseSync } from "node:sqlite";
import type { JobOpsApi } from "../jobops/client.js";
import type { AiCallMeta, AiCallStore } from "./ai-call-store.js";
import { runAsUser } from "./owner.js";
import type { TraceStore } from "./trace-store.js";

/**
 * Once a job is applied (you marked it, a run submitted it, or Job Ops found it applied), its
 * page snapshots and screenshots have done their job: they're deleted. The text trace stays.
 * Claude's send-and-reply files go too, except where something went wrong: those are what show
 * why, so they're kept until the usual age limit (ai-call-store.ts).
 */

/** Job Ops statuses that mean you've applied. */
export const APPLIED_STATUSES = ["applied", "in_progress"] as const;

/** Claude calls that only happen once something got stuck. */
const RESCUE_PURPOSES: ReadonlySet<string> = new Set(["operate", "act-field", "deep-read"]);
const BAD_STOPS: ReadonlySet<string> = new Set(["refusal", "max_tokens"]);
/** Trace events where a field went wrong or you had to do it. */
const PROBLEM_KINDS = ["step-failed", "manual-field", "stall", "error"] as const;
/** Run decisions where Claude's value wasn't used as it was. */
const CHANGED_DECISIONS = ["edited", "you-did-it", "skipped"] as const;
const LABEL_MATCH = 40;

const DEFAULT_SWEEP_MS = 6 * 60 * 60 * 1000;

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export interface CleanupResult {
  readonly snapshots: number;
  readonly payloads: number;
}

export interface AppliedCleanupDeps {
  readonly db: DatabaseSync;
  readonly trace: Pick<TraceStore, "dropSnapshotsOfJob">;
  readonly aiCalls: Pick<AiCallStore, "dropPayloadsOfJob">;
  readonly jobOps?: Pick<JobOpsApi, "listJobs">;
  readonly sweepEveryMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export function createAppliedCleanup(deps: AppliedCleanupDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const sweepEveryMs = deps.sweepEveryMs ?? DEFAULT_SWEEP_MS;
  const lastSweep = new Map<string, number>();
  // Jobs already cleaned (their kept payloads aren't pending again); forgotten on restart,
  // which costs one more pass over them.
  const cleaned = new Set<string>();

  const problemTexts = (userId: string, jobId: string): string[] => {
    const events = db
      .prepare(
        `select message from trace_events where user_id = ? and job_id = ?
           and (kind in (${PROBLEM_KINDS.map(() => "?").join(",")})
                or (kind = 'decision' and json_extract(data_json, '$.type') = 'edit'
                    and json_extract(data_json, '$.value') is not json_extract(data_json, '$.planned')))`,
      )
      .all(userId, jobId, ...PROBLEM_KINDS) as { message: string }[];
    const actions = db
      .prepare(
        `select a.field_ref as message from run_actions a join runs r on r.id = a.run_id
          where r.user_id = ? and r.job_id = ? and a.decision in (${CHANGED_DECISIONS.map(() => "?").join(",")})`,
      )
      .all(userId, jobId, ...CHANGED_DECISIONS) as { message: string | null }[];
    return [...events, ...actions]
      .map((row) => norm(row.message ?? ""))
      .filter(Boolean);
  };

  /** Which of a job's Claude calls to keep the send-and-reply of. */
  const keepFor = (userId: string, jobId: string) => {
    const problems = problemTexts(userId, jobId);
    return (call: AiCallMeta): boolean => {
      if (call.error || (call.stopReason && BAD_STOPS.has(call.stopReason))) return true;
      if (RESCUE_PURPOSES.has(call.purpose)) return true;
      if (!call.label) return false;
      const label = norm(call.label).slice(0, LABEL_MATCH);
      return label.length > 0 && problems.some((text) => text.includes(label));
    };
  };

  const onApplied = (userId: string, jobId: string): CleanupResult => {
    const snapshots = deps.trace.dropSnapshotsOfJob(userId, jobId);
    const payloads = deps.aiCalls.dropPayloadsOfJob(userId, jobId, keepFor(userId, jobId));
    cleaned.add(`${userId} ${jobId}`);
    if (snapshots || payloads)
      log(`[cleanup] job ${jobId} applied: ${snapshots} snapshot(s), ${payloads} Claude payload(s) deleted`);
    return { snapshots, payloads };
  };

  /** A user's jobs that may still have snapshots or Claude payloads to delete. */
  const jobsWithFiles = (userId: string): Set<string> => {
    const ids = (sql: string) =>
      (db.prepare(sql).all(userId) as { job_id: string }[]).map((row) => row.job_id);
    const withPayloads = ids(
      "select distinct job_id from ai_calls where user_id = ? and payload_file is not null and job_id is not null",
    ).filter((jobId) => !cleaned.has(`${userId} ${jobId}`));
    return new Set([
      ...ids("select distinct job_id from trace_snapshots where user_id = ?"),
      ...withPayloads,
    ]);
  };

  return {
    onApplied,

    /**
     * Jobs this server already knows are applied (a submitted run, Marked Applied, or marked
     * applied by hand in the kit), for every user. Safe to run again: done jobs have no files.
     */
    backfill(): number {
      const rows = db
        .prepare(
          `select distinct user_id, job_id from runs where outcome = 'submitted'
           union select distinct user_id, job_id from trace_events where kind = 'marked-applied'
           union select distinct user_id, job_id from trace_events
             where kind = 'kit-outcome' and json_extract(data_json, '$.outcome') = 'applied'`,
        )
        .all() as { user_id: string; job_id: string }[];
      let jobs = 0;
      for (const row of rows) {
        const done = onApplied(row.user_id, row.job_id);
        if (done.snapshots || done.payloads) jobs++;
      }
      return jobs;
    },

    /**
     * Asks Job Ops which of the user's jobs are applied (however that happened) and cleans those
     * up; at most once per sweepEveryMs per user. Never throws.
     */
    async sweep(userId: string, token: string): Promise<number> {
      if (!deps.jobOps || !token) return 0;
      const last = lastSweep.get(userId);
      if (last !== undefined && now() - last < sweepEveryMs) return 0;
      lastSweep.set(userId, now());
      try {
        const pending = jobsWithFiles(userId);
        if (pending.size === 0) return 0;
        const { jobs } = await deps.jobOps.listJobs(token, APPLIED_STATUSES);
        let jobsCleaned = 0;
        for (const job of jobs) {
          if (!pending.has(job.id)) continue;
          const done = runAsUser(userId, () => onApplied(userId, job.id));
          if (done.snapshots || done.payloads) jobsCleaned++;
        }
        return jobsCleaned;
      } catch (error) {
        log(`[cleanup] applied sweep failed: ${String(error)}`);
        return 0;
      }
    },
  };
}

export type AppliedCleanup = ReturnType<typeof createAppliedCleanup>;
