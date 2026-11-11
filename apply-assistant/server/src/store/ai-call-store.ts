import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AiCallContext } from "../claude/ai-context.js";
import type { ClaudeUsage } from "../claude/pricing.js";
import { currentUser, currentUserOrNull } from "./owner.js";

/**
 * Every Claude call, end to end: what it was for (job, run, step, field, purpose), the model,
 * tokens, cost and time (a row in ai_calls), and what was sent and what came back (a gzipped
 * JSON file; images sent are saved once each, by content hash, and referenced from it).
 *
 * Kept: the full send-and-reply for PAYLOAD_RETAIN_DAYS (dropped earlier, once the job is
 * applied, for calls whose step went fine: see applied-cleanup.ts), rows for ROW_RETAIN_DAYS.
 */

export const PAYLOAD_RETAIN_DAYS = 90;
export const ROW_RETAIN_DAYS = 365;

export interface AiCallInput {
  readonly context: AiCallContext;
  readonly model: string;
  readonly request: unknown;
  readonly response?: unknown;
  readonly error?: string;
  readonly stopReason?: string | null;
  readonly usage?: ClaudeUsage;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly durationMs: number;
}

export interface AiCallMeta {
  readonly id: string;
  readonly jobId: string | null;
  readonly runId: string | null;
  readonly stepSeq: number | null;
  readonly label: string | null;
  readonly purpose: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cost: number | null;
  readonly durationMs: number;
  readonly stopReason: string | null;
  readonly error: string | null;
  /** False once the send-and-reply was dropped (only the numbers are left). */
  readonly hasPayload: boolean;
  readonly createdAt: string;
}

export interface AiCallPayload {
  readonly request: unknown;
  readonly response: unknown;
  readonly error: string | null;
}

interface CallRow {
  id: string;
  user_id: string;
  job_id: string | null;
  run_id: string | null;
  step_seq: number | null;
  field_label: string | null;
  purpose: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  duration_ms: number;
  stop_reason: string | null;
  error: string | null;
  payload_file: string | null;
  image_files: string | null;
  created_at: string;
}

const toMeta = (row: CallRow): AiCallMeta => ({
  id: row.id,
  jobId: row.job_id,
  runId: row.run_id,
  stepSeq: row.step_seq,
  label: row.field_label,
  purpose: row.purpose,
  model: row.model,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cost: row.cost,
  durationMs: row.duration_ms,
  stopReason: row.stop_reason,
  error: row.error,
  hasPayload: row.payload_file !== null,
  createdAt: row.created_at,
});

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Base64 images in a request, swapped for the file each one is saved in. */
function extractImages(
  value: unknown,
  save: (data: string, mediaType: string) => string,
): unknown {
  if (Array.isArray(value)) return value.map((item) => extractImages(item, save));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (
    record.type === "base64" &&
    typeof record.data === "string" &&
    typeof record.media_type === "string" &&
    record.media_type.startsWith("image/")
  ) {
    const { data, ...rest } = record;
    return { ...rest, file: save(data, record.media_type), bytes: Math.floor((data.length * 3) / 4) };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, extractImages(item, save)]),
  );
}

export interface AiCallStoreOptions {
  readonly db: DatabaseSync;
  /** Folder for the send-and-reply files and images. */
  readonly dir: string;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export function createAiCallStore(options: AiCallStoreOptions) {
  const { db, dir } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  const insert = db.prepare(
    `insert into ai_calls (id, user_id, job_id, run_id, step_seq, field_label, purpose, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, duration_ms,
       stop_reason, error, payload_file, image_files, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ofJob = db.prepare(
    "select * from ai_calls where user_id = ? and job_id = ? order by created_at, id",
  );
  const byId = db.prepare("select * from ai_calls where user_id = ? and id = ?");
  const clearPayload = db.prepare(
    "update ai_calls set payload_file = null, image_files = null where id = ?",
  );
  const imageUses = db.prepare(
    "select count(*) as n from ai_calls where image_files like ?",
  );

  const remove = (file: string) => {
    try {
      rmSync(path.join(dir, file), { force: true });
    } catch (error) {
      log(`[ai-calls] couldn't remove ${file}: ${String(error)}`);
    }
  };

  /** Drops a call's files; an image another call still references stays. */
  const dropFiles = (rows: readonly CallRow[]) => {
    const images = new Set<string>();
    for (const row of rows) {
      clearPayload.run(row.id);
      if (row.payload_file) remove(row.payload_file);
      for (const image of JSON.parse(row.image_files ?? "[]") as string[]) images.add(image);
    }
    for (const image of images) {
      const { n } = imageUses.get(`%"${image}"%`) as { n: number };
      if (n === 0) remove(image);
    }
  };

  return {
    /** Never throws: logging a call must not break the call. */
    record(input: AiCallInput): string | null {
      const user = currentUserOrNull();
      if (!user) return null;
      try {
        mkdirSync(dir, { recursive: true });
        const id = randomUUID();
        const images: string[] = [];
        const request = extractImages(input.request, (data, mediaType) => {
          const name = `img-${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${EXTENSIONS[mediaType] ?? "bin"}`;
          if (!existsSync(path.join(dir, name)))
            writeFileSync(path.join(dir, name), Buffer.from(data, "base64"));
          if (!images.includes(name)) images.push(name);
          return name;
        });
        const payloadFile = `${id}.json.gz`;
        writeFileSync(
          path.join(dir, payloadFile),
          gzipSync(
            JSON.stringify({
              request,
              response: input.response ?? null,
              error: input.error ?? null,
            }),
          ),
        );
        const { context, usage } = input;
        insert.run(
          id,
          user,
          context.jobId ?? null,
          context.runId ?? null,
          context.stepSeq ?? null,
          context.label ?? null,
          context.purpose,
          input.model,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          input.cacheReadTokens ?? null,
          input.cacheWriteTokens ?? null,
          usage?.cost ?? null,
          Math.max(0, Math.round(input.durationMs)),
          input.stopReason ?? null,
          input.error?.slice(0, 1000) ?? null,
          payloadFile,
          JSON.stringify(images),
          now().toISOString(),
        );
        return id;
      } catch (error) {
        log(`[ai-calls] couldn't log a ${input.context.purpose} call: ${String(error)}`);
        return null;
      }
    },

    /** The signed-in user's calls for a job, oldest first. */
    callsOfJob(jobId: string): AiCallMeta[] {
      return (ofJob.all(currentUser(), jobId) as unknown as CallRow[]).map(toMeta);
    },

    /** What was sent and what came back; null when unknown or already dropped. */
    readPayload(id: string): AiCallPayload | null {
      const row = byId.get(currentUser(), id) as unknown as CallRow | undefined;
      if (!row?.payload_file) return null;
      try {
        return JSON.parse(
          gunzipSync(readFileSync(path.join(dir, row.payload_file))).toString("utf8"),
        ) as AiCallPayload;
      } catch {
        return null;
      }
    },

    /** Drops the send-and-reply of a job's calls that `keep` turns down; returns how many. */
    dropPayloadsOfJob(
      userId: string,
      jobId: string,
      keep: (call: AiCallMeta) => boolean,
    ): number {
      const rows = (ofJob.all(userId, jobId) as unknown as CallRow[]).filter(
        (row) => row.payload_file !== null && !keep(toMeta(row)),
      );
      dropFiles(rows);
      return rows.length;
    },

    /** Drops send-and-replies past PAYLOAD_RETAIN_DAYS and rows past ROW_RETAIN_DAYS. */
    prune(): { payloads: number; rows: number } {
      const at = (days: number) => new Date(now().getTime() - days * 86_400_000).toISOString();
      const stale = db
        .prepare("select * from ai_calls where payload_file is not null and created_at < ?")
        .all(at(PAYLOAD_RETAIN_DAYS)) as unknown as CallRow[];
      dropFiles(stale);
      const rows = db.prepare("delete from ai_calls where created_at < ?").run(at(ROW_RETAIN_DAYS));
      return { payloads: stale.length, rows: Number(rows.changes) };
    },
  };
}

export type AiCallStore = ReturnType<typeof createAiCallStore>;
