import type { ApplyClient } from "./api";
import { type LookupDeps, type PendingLookup, runTask } from "./lookups";

/**
 * One lookup pass: ask the server what to look up, do it, report back. A match produces a
 * follow-up task (fetch the form), so a pass runs a few rounds until nothing new appears.
 * Tasks that failed recently are skipped for a day instead of being retried every run.
 */

export interface RunLine {
  readonly employer: string;
  readonly title: string;
  readonly task: string;
  readonly outcome: string;
}

export interface RunSummary {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lines: readonly RunLine[];
  readonly skipped: number;
  readonly error?: string;
}

export interface WorkerDeps {
  readonly client: ApplyClient;
  readonly fetch: typeof fetch;
  readonly pause: () => Promise<void>;
  readonly now: () => Date;
  /** Keys of tasks that failed recently (persisted by the caller). */
  readonly recentFailures: Map<string, number>;
}

const MAX_ROUNDS = 3;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const FAILURE = /unreachable|couldn't|doesn't lead/;

export const taskKey = (p: PendingLookup) => `${p.jobId}:${p.task.type}`;

export async function runLookups(deps: WorkerDeps): Promise<RunSummary> {
  const startedAt = deps.now().toISOString();
  const lines: RunLine[] = [];
  let skipped = 0;
  const lookupDeps: LookupDeps = {
    fetch: deps.fetch,
    pause: deps.pause,
    submit: (result) => deps.client.submit(result),
  };
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const now = deps.now().getTime();
      const pending = (await deps.client.pending()).filter((p) => {
        const failedAt = deps.recentFailures.get(taskKey(p));
        const wait = failedAt !== undefined && now - failedAt < RETRY_AFTER_MS;
        if (wait && round === 0) skipped++;
        return !wait;
      });
      if (pending.length === 0) break;
      for (const p of pending) {
        let outcome: string;
        try {
          outcome = await runTask(lookupDeps, p);
        } catch (error) {
          outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (FAILURE.test(outcome) || outcome.startsWith("error"))
          deps.recentFailures.set(taskKey(p), deps.now().getTime());
        else deps.recentFailures.delete(taskKey(p));
        lines.push({
          employer: p.employer,
          title: p.title,
          task: p.task.type,
          outcome,
        });
      }
    }
  } catch (error) {
    return {
      startedAt,
      finishedAt: deps.now().toISOString(),
      lines,
      skipped,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { startedAt, finishedAt: deps.now().toISOString(), lines, skipped };
}
