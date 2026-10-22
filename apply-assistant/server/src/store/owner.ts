import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/**
 * Whose data a request reads and writes: the signed-in Job Ops user, set by the auth
 * middleware for the whole request. Everything a user saves or looks up (answers, limits,
 * runs, traces, boards, forms, Claude's answers, site steps, their Claude key) is theirs alone.
 */

interface Owner {
  readonly id: string;
  /** Job Ops' admin: the person who runs this server (its own Claude key is theirs). */
  readonly isSystemAdmin: boolean;
}

const owner = new AsyncLocalStorage<Owner>();

export function runAsUser<T>(
  user: string | { readonly id: string; readonly isSystemAdmin?: boolean },
  work: () => T,
): T {
  const who =
    typeof user === "string"
      ? { id: user, isSystemAdmin: false }
      : { id: user.id, isSystemAdmin: user.isSystemAdmin === true };
  return owner.run(who, work);
}

/** The signed-in user; throws outside a request, so data is never read or written unowned. */
export function currentUser(): string {
  const who = owner.getStore();
  if (!who) throw new Error("No signed-in user for this request");
  return who.id;
}

export const currentUserOrNull = (): string | null =>
  owner.getStore()?.id ?? null;

export const currentUserIsAdmin = (): boolean =>
  owner.getStore()?.isSystemAdmin === true;

/** Tables with a user_id column; rows from before there were users have user_id ''. */
const OWNED_TABLES = [
  "answer_bank",
  "learned_answers",
  "company_limits",
  "runs",
  "trace_events",
  "trace_snapshots",
  "captured_links",
  "ats_boards",
  "form_schemas",
  "claude_answers",
  "site_recipes",
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
