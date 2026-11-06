import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/** The signed-in user's own settings: their Claude (Anthropic) API key. Never sent back whole. */

interface Row {
  anthropic_key: string | null;
}

/** Claude credit you loaded: an estimate you enter (Anthropic has no API for what's left). */
export interface ClaudeCredit {
  readonly amountUsd: number;
  /** ISO date (YYYY-MM-DD) the credit was loaded or last checked. */
  readonly asOf: string;
}

interface CreditRow {
  claude_credit_usd: number | null;
  claude_credit_as_of: string | null;
}

export function createUserSettingsRepo(db: DatabaseSync) {
  const getStmt = db.prepare(
    "select anthropic_key from user_settings where user_id = ?",
  );
  const setStmt = db.prepare(
    `insert into user_settings (user_id, anthropic_key, updated_at) values (?, ?, datetime('now'))
     on conflict(user_id) do update set anthropic_key = excluded.anthropic_key, updated_at = excluded.updated_at`,
  );

  const creditGet = db.prepare(
    "select claude_credit_usd, claude_credit_as_of from user_settings where user_id = ?",
  );
  const creditSet = db.prepare(
    `insert into user_settings (user_id, claude_credit_usd, claude_credit_as_of, updated_at) values (?, ?, ?, datetime('now'))
     on conflict(user_id) do update set claude_credit_usd = excluded.claude_credit_usd,
       claude_credit_as_of = excluded.claude_credit_as_of, updated_at = excluded.updated_at`,
  );

  return {
    claudeCredit(userId: string = currentUser()): ClaudeCredit | null {
      const row = creditGet.get(userId) as CreditRow | undefined;
      return row?.claude_credit_usd != null && row.claude_credit_as_of
        ? { amountUsd: row.claude_credit_usd, asOf: row.claude_credit_as_of }
        : null;
    },
    /** null clears it. */
    setClaudeCredit(credit: ClaudeCredit | null): void {
      creditSet.run(currentUser(), credit?.amountUsd ?? null, credit?.asOf ?? null);
    },
    claudeKey(userId: string = currentUser()): string | null {
      const row = getStmt.get(userId) as Row | undefined;
      return row?.anthropic_key ?? null;
    },
    /** null removes it. */
    setClaudeKey(key: string | null): void {
      setStmt.run(currentUser(), key);
    },
  };
}

export type UserSettingsRepo = ReturnType<typeof createUserSettingsRepo>;
