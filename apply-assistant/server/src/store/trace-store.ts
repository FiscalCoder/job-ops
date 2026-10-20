import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Run trace: every event the server, the extension and the page reported for a job, plus DOM
 * and screenshot snapshots (files under <dir>, rows in trace_snapshots). Kept RETAIN_DAYS, with
 * snapshots capped at MAX_SNAPSHOT_BYTES in total (oldest go first).
 */

export const TRACE_SOURCES = ["server", "extension", "page"] as const;
export type TraceSource = (typeof TRACE_SOURCES)[number];
export type SnapshotKind = "dom" | "screenshot";

export const RETAIN_DAYS = 60;
export const MAX_SNAPSHOT_BYTES = 1024 ** 3;

export interface TraceEventInput {
  readonly jobId: string;
  readonly runId?: string | null;
  /** ISO time the event happened (the extension's clock); now when absent. */
  readonly ts?: string;
  readonly source: TraceSource;
  readonly kind: string;
  readonly stepSeq?: number | null;
  readonly message: string;
  readonly data?: unknown;
  readonly snapshotId?: string | null;
}

export interface TraceEvent {
  readonly id: number;
  readonly jobId: string;
  readonly runId: string | null;
  readonly ts: string;
  readonly source: TraceSource;
  readonly kind: string;
  readonly stepSeq: number | null;
  readonly message: string;
  readonly data: unknown;
  readonly snapshotId: string | null;
}

export interface SnapshotMeta {
  readonly id: string;
  readonly jobId: string;
  readonly runId: string | null;
  readonly kind: SnapshotKind;
  readonly reason: string;
  readonly url: string | null;
  readonly bytes: number;
  readonly createdAt: string;
}

export interface TracedJob {
  readonly jobId: string;
  readonly lastTs: string;
  readonly events: number;
  readonly failures: number;
  readonly lastMessage: string;
}

interface EventRow {
  id: number;
  job_id: string;
  run_id: string | null;
  ts: string;
  source: TraceSource;
  kind: string;
  step_seq: number | null;
  message: string;
  data_json: string | null;
  snapshot_id: string | null;
}

interface SnapshotRow {
  id: string;
  job_id: string;
  run_id: string | null;
  kind: SnapshotKind;
  reason: string;
  url: string | null;
  bytes: number;
  file: string;
  created_at: string;
}

/** Event kinds that mean something went wrong (counted as failures in the job list). */
export const FAILURE_KINDS: ReadonlySet<string> = new Set([
  "step-failed",
  "stall",
  "error",
  "console-error",
  "request-failed",
]);

const toEvent = (row: EventRow): TraceEvent => ({
  id: row.id,
  jobId: row.job_id,
  runId: row.run_id,
  ts: row.ts,
  source: row.source,
  kind: row.kind,
  stepSeq: row.step_seq,
  message: row.message,
  data: row.data_json === null ? null : JSON.parse(row.data_json),
  snapshotId: row.snapshot_id,
});

const toMeta = (row: SnapshotRow): SnapshotMeta => ({
  id: row.id,
  jobId: row.job_id,
  runId: row.run_id,
  kind: row.kind,
  reason: row.reason,
  url: row.url,
  bytes: row.bytes,
  createdAt: row.created_at,
});

export interface TraceStoreOptions {
  readonly db: DatabaseSync;
  /** Folder for snapshot files. */
  readonly dir: string;
  readonly now?: () => Date;
  readonly maxSnapshotBytes?: number;
  readonly log?: (line: string) => void;
}

export function createTraceStore(options: TraceStoreOptions) {
  const { db, dir } = options;
  const now = options.now ?? (() => new Date());
  const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES;
  const log = options.log ?? (() => {});
  mkdirSync(dir, { recursive: true });

  const insertEvent = db.prepare(
    `insert into trace_events (job_id, run_id, ts, source, kind, step_seq, message, data_json, snapshot_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSnapshot = db.prepare(
    `insert into trace_snapshots (id, job_id, run_id, kind, reason, url, bytes, file, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const eventsOfJob = db.prepare(
    "select * from trace_events where job_id = ? order by id desc limit ?",
  );
  const eventsOfRun = db.prepare(
    "select * from trace_events where job_id = ? and run_id = ? order by id desc limit ?",
  );
  const snapshotsOfJob = db.prepare(
    "select * from trace_snapshots where job_id = ? order by created_at, id",
  );
  const snapshotById = db.prepare("select * from trace_snapshots where id = ?");
  const recent = db.prepare(
    `select job_id, max(ts) as last_ts, count(*) as events,
            sum(case when kind in (${[...FAILURE_KINDS].map(() => "?").join(",")}) then 1 else 0 end) as failures,
            (select message from trace_events e2 where e2.job_id = e.job_id order by id desc limit 1) as last_message
       from trace_events e group by job_id order by last_ts desc limit ?`,
  );

  const add = (input: TraceEventInput): number => {
    const result = insertEvent.run(
      input.jobId,
      input.runId ?? null,
      input.ts ?? now().toISOString(),
      input.source,
      input.kind,
      input.stepSeq ?? null,
      input.message,
      input.data === undefined ? null : JSON.stringify(input.data),
      input.snapshotId ?? null,
    );
    return Number(result.lastInsertRowid);
  };

  const removeSnapshotFile = (file: string) => {
    try {
      rmSync(path.join(dir, file), { force: true });
    } catch (error) {
      log(`[trace] couldn't remove ${file}: ${String(error)}`);
    }
  };

  return {
    /** Server-side events: never throws, so tracing can't break a request. */
    record(input: Omit<TraceEventInput, "source">): void {
      try {
        add({ ...input, source: "server" });
      } catch (error) {
        log(`[trace] couldn't record "${input.message}": ${String(error)}`);
      }
    },

    addEvents(inputs: readonly TraceEventInput[]): number {
      db.exec("begin");
      try {
        for (const input of inputs) add(input);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return inputs.length;
    },

    /** Stores a snapshot (DOM text is gzipped) and adds a "snapshot" event pointing at it. */
    saveSnapshot(input: {
      jobId: string;
      runId?: string | null;
      kind: SnapshotKind;
      reason: string;
      url?: string | null;
      ts?: string;
      content: Buffer;
    }): SnapshotMeta {
      const id = randomUUID();
      const file = `${id}${input.kind === "dom" ? ".html.gz" : ".jpg"}`;
      const body =
        input.kind === "dom" ? gzipSync(input.content) : input.content;
      writeFileSync(path.join(dir, file), body);
      const createdAt = input.ts ?? now().toISOString();
      try {
        insertSnapshot.run(
          id,
          input.jobId,
          input.runId ?? null,
          input.kind,
          input.reason,
          input.url ?? null,
          body.length,
          file,
          createdAt,
        );
        add({
          jobId: input.jobId,
          runId: input.runId ?? null,
          ts: createdAt,
          source: "extension",
          kind: "snapshot",
          message: `${input.kind === "dom" ? "Page snapshot" : "Screenshot"}: ${input.reason}`,
          data: { kind: input.kind, url: input.url ?? null },
          snapshotId: id,
        });
      } catch (error) {
        removeSnapshotFile(file);
        throw error;
      }
      return toMeta(snapshotById.get(id) as unknown as SnapshotRow);
    },

    /** The snapshot and its content (DOM decompressed), or null when gone. */
    readSnapshot(id: string): { meta: SnapshotMeta; content: Buffer } | null {
      const row = snapshotById.get(id) as SnapshotRow | undefined;
      if (!row) return null;
      try {
        const raw = readFileSync(path.join(dir, row.file));
        return {
          meta: toMeta(row),
          content: row.kind === "dom" ? gunzipSync(raw) : raw,
        };
      } catch {
        return null;
      }
    },

    /** Newest last; at most `limit` (the most recent ones). */
    events(jobId: string, query: { runId?: string; limit?: number } = {}) {
      const limit = query.limit ?? 2000;
      const rows = (query.runId
        ? eventsOfRun.all(jobId, query.runId, limit)
        : eventsOfJob.all(jobId, limit)) as unknown as EventRow[];
      return rows.map(toEvent).reverse();
    },

    snapshots(jobId: string): SnapshotMeta[] {
      return (snapshotsOfJob.all(jobId) as unknown as SnapshotRow[]).map(
        toMeta,
      );
    },

    recentJobs(limit = 50): TracedJob[] {
      return (
        recent.all(...FAILURE_KINDS, limit) as unknown as {
          job_id: string;
          last_ts: string;
          events: number;
          failures: number;
          last_message: string;
        }[]
      ).map((r) => ({
        jobId: r.job_id,
        lastTs: r.last_ts,
        events: r.events,
        failures: r.failures,
        lastMessage: r.last_message,
      }));
    },

    /** Drops events and snapshots older than RETAIN_DAYS, then the oldest snapshots over the cap. */
    prune(): { events: number; snapshots: number } {
      const cutoff = new Date(
        now().getTime() - RETAIN_DAYS * 86_400_000,
      ).toISOString();
      const old = db
        .prepare("select * from trace_snapshots where created_at < ?")
        .all(cutoff) as unknown as SnapshotRow[];
      const all = db
        .prepare(
          "select * from trace_snapshots where created_at >= ? order by created_at desc, id desc",
        )
        .all(cutoff) as unknown as SnapshotRow[];
      let total = 0;
      const overCap = all.filter((row) => {
        total += row.bytes;
        return total > maxSnapshotBytes;
      });
      const doomed = [...old, ...overCap];
      const dropSnapshot = db.prepare(
        "delete from trace_snapshots where id = ?",
      );
      for (const row of doomed) {
        dropSnapshot.run(row.id);
        removeSnapshotFile(row.file);
      }
      const events = db
        .prepare("delete from trace_events where ts < ?")
        .run(cutoff).changes;
      return { events: Number(events), snapshots: doomed.length };
    },
  };
}

export type TraceStore = ReturnType<typeof createTraceStore>;
/** What server code needs to add an event (optional everywhere: tests leave it out). */
export type TraceRecord = TraceStore["record"];
