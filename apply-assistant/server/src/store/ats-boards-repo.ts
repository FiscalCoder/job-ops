import type { DatabaseSync } from "node:sqlite";
import { ATS_LIST, type Ats } from "../ats.js";

/**
 * employer → its job board (application system + board token), or "no board", looked up once.
 * A "no board" answer only holds for the systems that were searched: when a system is added,
 * those employers are looked up again.
 */

export interface BoardCacheEntry {
  readonly employerKey: string;
  /** Null together with token when no supported system has a board for this employer. */
  readonly ats: Ats | null;
  readonly token: string | null;
  readonly method: string;
  readonly checkedAt: string;
}

interface BoardRow {
  employer_norm: string;
  ats: Ats | null;
  token: string | null;
  method: string;
  checked_at: string;
  searched: string | null;
}

const coversAllSystems = (searched: string | null) => {
  const done = new Set((searched ?? "").split(","));
  return ATS_LIST.every((ats) => done.has(ats));
};

export const BOARD_CACHE_DAYS = 7;

export function createAtsBoardsRepo(db: DatabaseSync) {
  const getStmt = db.prepare(
    `select * from ats_boards where employer_norm = ? and checked_at >= datetime('now', ?)`,
  );
  const upsertStmt = db.prepare(
    `insert into ats_boards (employer_norm, ats, token, method, searched, checked_at) values (?, ?, ?, ?, ?, datetime('now'))
     on conflict(employer_norm) do update set ats = excluded.ats, token = excluded.token,
       method = excluded.method, searched = excluded.searched, checked_at = excluded.checked_at`,
  );

  return {
    /** A fresh cache entry (checked within BOARD_CACHE_DAYS), or null if unknown or stale. */
    getFresh(employerKey: string): BoardCacheEntry | null {
      const row = getStmt.get(employerKey, `-${BOARD_CACHE_DAYS} days`) as
        | BoardRow
        | undefined;
      if (row && !row.token && !coversAllSystems(row.searched)) return null;
      return row
        ? {
            employerKey: row.employer_norm,
            ats: row.token ? row.ats : null,
            token: row.token,
            method: row.method,
            checkedAt: row.checked_at,
          }
        : null;
    },
    save(
      employerKey: string,
      board: { ats: Ats; token: string } | null,
      method: string,
    ): void {
      upsertStmt.run(
        employerKey,
        board?.ats ?? null,
        board?.token ?? null,
        method,
        ATS_LIST.join(","),
      );
    },
  };
}

export type AtsBoardsRepo = ReturnType<typeof createAtsBoardsRepo>;
