import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/** Supervised fill runs and every action in them (what was proposed, who decided, what happened). */

export type RunOutcome = "submitted" | "aborted";

export interface Run {
  readonly id: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: RunOutcome | null;
  readonly interventions: number;
}

export interface RunAction {
  readonly seq: number;
  readonly actionClass: string;
  readonly fieldRef: string;
  readonly valueMasked: string | null;
  readonly source: string | null;
  readonly decision: string;
  readonly decidedBy: string;
  readonly result: string;
}

export class RunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

interface RunRow {
  id: string;
  job_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: RunOutcome | null;
  interventions: number;
}

interface ActionRow {
  seq: number;
  action_class: string;
  field_ref: string;
  value_masked: string | null;
  source: string | null;
  decision: string;
  decided_by: string;
  result: string;
}

const toRun = (row: RunRow): Run => ({
  id: row.id,
  jobId: row.job_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  outcome: row.outcome,
  interventions: row.interventions,
});

const toAction = (row: ActionRow): RunAction => ({
  seq: row.seq,
  actionClass: row.action_class,
  fieldRef: row.field_ref,
  valueMasked: row.value_masked,
  source: row.source,
  decision: row.decision,
  decidedBy: row.decided_by,
  result: row.result,
});

export function createRunsRepo(db: DatabaseSync) {
  // Each user's own runs (see owner.ts).
  const insertRun = db.prepare(
    "insert into runs (id, user_id, job_id) values (?, ?, ?)",
  );
  const getRun = db.prepare("select * from runs where user_id = ? and id = ?");
  const allRuns = db.prepare(
    "select * from runs where user_id = ? order by started_at, rowid",
  );
  const runsByJob = db.prepare(
    "select * from runs where user_id = ? and job_id = ? order by started_at desc, rowid desc",
  );
  const insertAction = db.prepare(
    `insert into run_actions (run_id, seq, action_class, field_ref, value_masked, source, decision, decided_by, result)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const actionsOf = db.prepare(
    "select * from run_actions where run_id = ? order by seq",
  );
  const abandonOpen = db.prepare(
    "update runs set ended_at = datetime('now'), outcome = 'aborted' where user_id = ? and job_id = ? and ended_at is null",
  );
  const finish = db.prepare(
    "update runs set ended_at = datetime('now'), outcome = ?, interventions = ? where id = ? and ended_at is null",
  );

  const get = (id: string): Run | null => {
    const row = getRun.get(currentUser(), id) as RunRow | undefined;
    return row ? toRun(row) : null;
  };
  /** A run's actions; none for a run that isn't yours. */
  const actions = (id: string): RunAction[] =>
    get(id)
      ? (actionsOf.all(id) as unknown as ActionRow[]).map(toAction)
      : [];
  /** The run if it exists and is still open; throws if it already finished. */
  const openRun = (id: string): Run | null => {
    const run = get(id);
    if (run?.endedAt)
      throw new RunConflictError("This run has already finished");
    return run;
  };

  return {
    create(jobId: string): Run {
      const id = randomUUID();
      // A run left open (the panel closed, the browser quit) can't continue: close it first.
      const user = currentUser();
      abandonOpen.run(user, jobId);
      insertRun.run(id, user, jobId);
      return get(id) as Run;
    },
    get,
    actions,
    all(): Run[] {
      return (allRuns.all(currentUser()) as unknown as RunRow[]).map(toRun);
    },
    listByJob(jobId: string): Run[] {
      return (runsByJob.all(currentUser(), jobId) as unknown as RunRow[]).map(
        toRun,
      );
    },
    /** null when the run doesn't exist. */
    addAction(runId: string, action: RunAction): RunAction | null {
      if (!openRun(runId)) return null;
      try {
        insertAction.run(
          runId,
          action.seq,
          action.actionClass,
          action.fieldRef,
          action.valueMasked,
          action.source,
          action.decision,
          action.decidedBy,
          action.result,
        );
      } catch (error) {
        if (String(error).includes("UNIQUE"))
          throw new RunConflictError(`Step ${action.seq} is already logged`);
        throw error;
      }
      return action;
    },
    /** null when the run doesn't exist. */
    complete(
      runId: string,
      outcome: RunOutcome,
    ): { run: Run; actions: RunAction[] } | null {
      if (!openRun(runId)) return null;
      const logged = actions(runId);
      const interventions = logged.filter((a) => a.decidedBy === "you").length;
      finish.run(outcome, interventions, runId);
      return { run: get(runId) as Run, actions: logged };
    },
  };
}

export type RunsRepo = ReturnType<typeof createRunsRepo>;
