import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/**
 * Whose data a request reads and writes: the signed-in Job Ops user, set by the auth
 * middleware for the whole request. Each user's answer bank, remembered answers, company
 * limits, runs, traces and captured links are theirs alone.
 */

const owner = new AsyncLocalStorage<string>();

export function runAsUser<T>(userId: string, work: () => T): T {
  return owner.run(userId, work);
}

/** The signed-in user; throws outside a request, so data is never read or written unowned. */
export function currentUser(): string {
  const userId = owner.getStore();
  if (!userId) throw new Error("No signed-in user for this request");
  return userId;
}

export const currentUserOrNull = (): string | null => owner.getStore() ?? null;

/** Tables with a user_id column; rows from before there were users have user_id ''. */
const OWNED_TABLES = [
  "answer_bank",
  "learned_answers",
  "company_limits",
  "runs",
  "trace_events",
  "trace_snapshots",
  "captured_links",
] as const;

/**
 * Gives rows from before apply-assistant had users (all one person's) to that person: Job Ops'
 * admin, on their first request. Returns how many rows changed.
 */
export function claimUnowned(db: DatabaseSync, userId: string): number {
  let changed = 0;
  db.exec("begin");
  try {
    for (const table of OWNED_TABLES)
      changed += Number(
        db
          .prepare(`update ${table} set user_id = ? where user_id = ''`)
          .run(userId).changes,
      );
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return changed;
}
