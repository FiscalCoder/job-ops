import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/** Company apply links captured from LinkedIn by the extension (history; Job Ops holds the current one). */

export interface CapturedLink {
  readonly jobId: string;
  readonly sourceUrl: string;
  readonly capturedUrl: string;
  readonly savedUrl: string;
  readonly capturedAt: string;
}

interface Row {
  job_id: string;
  source_url: string;
  captured_url: string;
  decoded_url: string | null;
  captured_at: string;
}

export function createCapturedLinksRepo(db: DatabaseSync) {
  const addStmt = db.prepare(
    "insert into captured_links (user_id, job_id, source_url, captured_url, decoded_url) values (?, ?, ?, ?, ?)",
  );
  const recentStmt = db.prepare(
    "select * from captured_links where user_id = ? order by captured_at desc, rowid desc limit ?",
  );
  return {
    add(link: Omit<CapturedLink, "capturedAt">): void {
      addStmt.run(
        currentUser(),
        link.jobId,
        link.sourceUrl,
        link.capturedUrl,
        link.savedUrl,
      );
    },
    recent(limit: number): CapturedLink[] {
      return (recentStmt.all(currentUser(), limit) as unknown as Row[]).map((row) => ({
        jobId: row.job_id,
        sourceUrl: row.source_url,
        capturedUrl: row.captured_url,
        savedUrl: row.decoded_url ?? row.captured_url,
        capturedAt: row.captured_at,
      }));
    },
  };
}

export type CapturedLinksRepo = ReturnType<typeof createCapturedLinksRepo>;
