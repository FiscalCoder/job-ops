import type { DatabaseSync } from "node:sqlite";

/** employer → Greenhouse board token (or "no board"), so each company is looked up once. */

export interface BoardCacheEntry {
  readonly employerKey: string;
  readonly token: string | null;
  readonly method: string;
  readonly checkedAt: string;
}

interface BoardRow {
  employer_norm: string;
  token: string | null;
  method: string;
  checked_at: string;
}

export const BOARD_CACHE_DAYS = 7;

export function createGhBoardsRepo(db: DatabaseSync) {
  const getStmt = db.prepare(
    `select * from gh_boards where employer_norm = ? and checked_at >= datetime('now', ?)`,
  );
  const upsertStmt = db.prepare(
    `insert into gh_boards (employer_norm, token, method, checked_at) values (?, ?, ?, datetime('now'))
     on conflict(employer_norm) do update set token = excluded.token, method = excluded.method, checked_at = excluded.checked_at`,
  );

  return {
    /** A fresh cache entry (checked within BOARD_CACHE_DAYS), or null if unknown or stale. */
    getFresh(employerKey: string): BoardCacheEntry | null {
      const row = getStmt.get(employerKey, `-${BOARD_CACHE_DAYS} days`) as
        | BoardRow
        | undefined;
      return row
        ? {
            employerKey: row.employer_norm,
            token: row.token,
            method: row.method,
            checkedAt: row.checked_at,
          }
        : null;
    },
    save(employerKey: string, token: string | null, method: string): void {
      upsertStmt.run(employerKey, token, method);
    },
  };
}

export type GhBoardsRepo = ReturnType<typeof createGhBoardsRepo>;
