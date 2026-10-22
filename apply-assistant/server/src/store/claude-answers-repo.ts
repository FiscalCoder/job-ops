import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/**
 * Claude's answers, keyed by a hash of everything that went into them (question, job, resume,
 * the saved answers sent, model, prompt version). Plans are rebuilt often; an unchanged question
 * is never paid for twice.
 */

interface Row {
  answer_json: string;
}

export function createClaudeAnswersRepo(db: DatabaseSync) {
  const getStmt = db.prepare(
    "select answer_json from claude_answers where user_id = ? and cache_key = ?",
  );
  const putStmt = db.prepare(
    `insert into claude_answers (user_id, cache_key, answer_json, model) values (?, ?, ?, ?)
     on conflict(user_id, cache_key) do update set answer_json = excluded.answer_json,
       model = excluded.model, created_at = datetime('now')`,
  );
  return {
    get(cacheKey: string): unknown {
      const row = getStmt.get(currentUser(), cacheKey) as Row | undefined;
      return row ? (JSON.parse(row.answer_json) as unknown) : null;
    },
    save(cacheKey: string, answer: unknown, model: string): void {
      putStmt.run(currentUser(), cacheKey, JSON.stringify(answer), model);
    },
  };
}

export type ClaudeAnswersRepo = ReturnType<typeof createClaudeAnswersRepo>;
