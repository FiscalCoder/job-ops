import type { DatabaseSync } from "node:sqlite";

/** Greenhouse form payloads (`?questions=true`) as fetched by the extension, per posting. */

export interface StoredSchema {
  readonly payload: unknown;
  readonly hash: string;
  readonly fetchedAt: string;
}

interface SchemaRow {
  payload_json: string;
  schema_hash: string;
  fetched_at: string;
}

/** Forms change rarely; re-fetch after this many days so a changed form is picked up. */
export const SCHEMA_FRESH_DAYS = 3;

const toSchema = (row: SchemaRow | undefined): StoredSchema | null =>
  row
    ? {
        payload: JSON.parse(row.payload_json) as unknown,
        hash: row.schema_hash,
        fetchedAt: row.fetched_at,
      }
    : null;

export function createFormSchemasRepo(db: DatabaseSync) {
  const freshStmt = db.prepare(
    `select * from form_schemas where gh_token = ? and gh_job_id = ? and fetched_at >= datetime('now', ?)`,
  );
  const anyStmt = db.prepare(
    "select * from form_schemas where gh_token = ? and gh_job_id = ?",
  );
  const upsertStmt = db.prepare(
    `insert into form_schemas (gh_token, gh_job_id, payload_json, schema_hash, fetched_at)
     values (?, ?, ?, ?, datetime('now'))
     on conflict(gh_token, gh_job_id) do update set payload_json = excluded.payload_json,
       schema_hash = excluded.schema_hash, fetched_at = excluded.fetched_at`,
  );

  return {
    getFresh(token: string, ghJobId: string): StoredSchema | null {
      return toSchema(
        freshStmt.get(token, ghJobId, `-${SCHEMA_FRESH_DAYS} days`) as
          | SchemaRow
          | undefined,
      );
    },
    /** Latest stored schema regardless of age (plans can still be built from it). */
    getAny(token: string, ghJobId: string): StoredSchema | null {
      return toSchema(anyStmt.get(token, ghJobId) as SchemaRow | undefined);
    },
    save(token: string, ghJobId: string, payload: unknown, hash: string): void {
      upsertStmt.run(token, ghJobId, JSON.stringify(payload), hash);
    },
  };
}

export type FormSchemasRepo = ReturnType<typeof createFormSchemasRepo>;
