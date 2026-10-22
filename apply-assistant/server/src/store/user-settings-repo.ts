import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/** The signed-in user's own settings: their Claude (Anthropic) API key. Never sent back whole. */

interface Row {
  anthropic_key: string | null;
}

export function createUserSettingsRepo(db: DatabaseSync) {
  const getStmt = db.prepare(
    "select anthropic_key from user_settings where user_id = ?",
  );
  const setStmt = db.prepare(
    `insert into user_settings (user_id, anthropic_key, updated_at) values (?, ?, datetime('now'))
     on conflict(user_id) do update set anthropic_key = excluded.anthropic_key, updated_at = excluded.updated_at`,
  );

  return {
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
