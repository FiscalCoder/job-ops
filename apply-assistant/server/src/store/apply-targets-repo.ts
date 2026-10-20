import type { DatabaseSync } from "node:sqlite";
import type { Ats } from "../ats.js";

export type TargetStatus = "matched" | "possible" | "none" | "closed";

export interface ApplyTarget {
  readonly jobId: string;
  /** The application system the posting is on (the board token and id are that system's). */
  readonly ats: Ats;
  readonly boardToken: string | null;
  readonly postingId: string | null;
  readonly postingUrl: string | null;
  readonly matchMethod: string;
  readonly titleScore: number | null;
  readonly descScore: number | null;
  readonly status: TargetStatus;
}

interface TargetRow {
  job_id: string;
  ats: Ats;
  gh_token: string | null;
  gh_job_id: string | null;
  gh_url: string | null;
  match_method: string;
  title_score: number | null;
  desc_score: number | null;
  status: TargetStatus;
}

const toTarget = (row: TargetRow): ApplyTarget => ({
  jobId: row.job_id,
  ats: row.ats,
  boardToken: row.gh_token,
  postingId: row.gh_job_id,
  postingUrl: row.gh_url,
  matchMethod: row.match_method,
  titleScore: row.title_score,
  descScore: row.desc_score,
  status: row.status,
});

export function createApplyTargetsRepo(db: DatabaseSync) {
  const getStmt = db.prepare("select * from apply_targets where job_id = ?");
  const byStatusStmt = db.prepare(
    "select * from apply_targets where status = ? order by updated_at desc, job_id",
  );
  const upsertStmt = db.prepare(
    `insert into apply_targets (job_id, ats, gh_token, gh_job_id, gh_url, match_method, title_score, desc_score, status, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     on conflict(job_id) do update set ats = excluded.ats, gh_token = excluded.gh_token, gh_job_id = excluded.gh_job_id,
       gh_url = excluded.gh_url, match_method = excluded.match_method, title_score = excluded.title_score,
       desc_score = excluded.desc_score, status = excluded.status, updated_at = excluded.updated_at`,
  );

  const removeStmt = db.prepare("delete from apply_targets where job_id = ?");

  return {
    get(jobId: string): ApplyTarget | null {
      const row = getStmt.get(jobId) as TargetRow | undefined;
      return row ? toTarget(row) : null;
    },
    listByStatus(status: TargetStatus): ApplyTarget[] {
      return (byStatusStmt.all(status) as unknown as TargetRow[]).map(toTarget);
    },
    upsert(target: ApplyTarget): ApplyTarget {
      upsertStmt.run(
        target.jobId,
        target.ats,
        target.boardToken,
        target.postingId,
        target.postingUrl,
        target.matchMethod,
        target.titleScore,
        target.descScore,
        target.status,
      );
      return toTarget(getStmt.get(target.jobId) as TargetRow);
    },
    /** Forget the job's target so the next lookup starts again (a new apply link). */
    remove(jobId: string): void {
      removeStmt.run(jobId);
    },
  };
}

export type ApplyTargetsRepo = ReturnType<typeof createApplyTargetsRepo>;
