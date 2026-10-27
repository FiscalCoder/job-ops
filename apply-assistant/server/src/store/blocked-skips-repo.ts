import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/** A job that blocking a company skipped, and the status it goes back to on unblock. */
export interface BlockedSkip {
  readonly keyword: string;
  readonly jobId: string;
  readonly previousStatus: "ready" | "discovered";
}

interface Row {
  keyword: string;
  job_id: string;
  previous_status: string;
}

const toSkip = (row: Row): BlockedSkip => ({
  keyword: row.keyword,
  jobId: row.job_id,
  previousStatus: row.previous_status === "discovered" ? "discovered" : "ready",
});

/** The signed-in user's skips (see owner.ts); keywords are kept lowercase. */
export function createBlockedSkipsRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `insert into blocked_skips (user_id, keyword, job_id, previous_status) values (?, ?, ?, ?)
     on conflict(user_id, keyword, job_id) do nothing`,
  );
  const byKeyword = db.prepare(
    "select * from blocked_skips where user_id = ? and keyword = ? order by created_at",
  );
  const counts = db.prepare(
    "select keyword, count(*) as n from blocked_skips where user_id = ? group by keyword",
  );
  const removeKeyword = db.prepare(
    "delete from blocked_skips where user_id = ? and keyword = ?",
  );
  const saveUntil = db.prepare(
    `insert into blocked_until (user_id, keyword, until) values (?, ?, ?)
     on conflict(user_id, keyword) do update set until = excluded.until`,
  );
  const allUntil = db.prepare(
    "select keyword, until from blocked_until where user_id = ?",
  );
  const removeUntil = db.prepare(
    "delete from blocked_until where user_id = ? and keyword = ?",
  );

  return {
    add(skip: BlockedSkip): void {
      insert.run(
        currentUser(),
        skip.keyword.toLowerCase(),
        skip.jobId,
        skip.previousStatus,
      );
    },
    forKeyword(keyword: string): BlockedSkip[] {
      return (
        byKeyword.all(currentUser(), keyword.toLowerCase()) as unknown as Row[]
      ).map(toSkip);
    },
    /** How many jobs each blocked keyword skipped. */
    counts(): Map<string, number> {
      return new Map(
        (
          counts.all(currentUser()) as unknown as {
            keyword: string;
            n: number;
          }[]
        ).map((r) => [r.keyword, Number(r.n)]),
      );
    },
    /** When a block ends (ISO time); null blocks it for good. */
    setUntil(keyword: string, until: string | null): void {
      if (until) saveUntil.run(currentUser(), keyword.toLowerCase(), until);
      else removeUntil.run(currentUser(), keyword.toLowerCase());
    },
    /** Each timed block's end, by keyword. */
    untils(): Map<string, string> {
      return new Map(
        (
          allUntil.all(currentUser()) as unknown as {
            keyword: string;
            until: string;
          }[]
        ).map((r) => [r.keyword, r.until]),
      );
    },
    clear(keyword: string): void {
      removeKeyword.run(currentUser(), keyword.toLowerCase());
      removeUntil.run(currentUser(), keyword.toLowerCase());
    },
  };
}

export type BlockedSkipsRepo = ReturnType<typeof createBlockedSkipsRepo>;
