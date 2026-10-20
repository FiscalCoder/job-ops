import type { DatabaseSync } from "node:sqlite";
import type { Ats } from "../ats.js";

/** Application-form payloads as fetched by the extension, per posting on each system. */

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
    `select * from form_schemas where ats = ? and board = ? and posting_id = ? and fetched_at >= datetime('now', ?)`,
  );
  const anyStmt = db.prepare(
    "select * from form_schemas where ats = ? and board = ? and posting_id = ?",
  );
  const upsertStmt = db.prepare(
    `insert into form_schemas (ats, board, posting_id, payload_json, schema_hash, fetched_at)
     values (?, ?, ?, ?, ?, datetime('now'))
     on conflict(ats, board, posting_id) do update set payload_json = excluded.payload_json,
       schema_hash = excluded.schema_hash, fetched_at = excluded.fetched_at`,
  );

  return {
    getFresh(ats: Ats, token: string, postingId: string): StoredSchema | null {
      return toSchema(
        freshStmt.get(ats, token, postingId, `-${SCHEMA_FRESH_DAYS} days`) as
          | SchemaRow
          | undefined,
      );
    },
    /** Latest stored schema regardless of age (plans can still be built from it). */
    getAny(ats: Ats, token: string, postingId: string): StoredSchema | null {
      return toSchema(
        anyStmt.get(ats, token, postingId) as SchemaRow | undefined,
      );
    },
    save(
      ats: Ats,
      token: string,
      postingId: string,
      payload: unknown,
      hash: string,
    ): void {
      upsertStmt.run(ats, token, postingId, JSON.stringify(payload), hash);
    },
  };
}

export type FormSchemasRepo = ReturnType<typeof createFormSchemasRepo>;
