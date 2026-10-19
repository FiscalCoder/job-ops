import type { DatabaseSync } from "node:sqlite";

export interface Answer {
  readonly key: string;
  readonly value: string;
  readonly isProtected: boolean;
  readonly notes: string | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface AnswerInput {
  readonly key: string;
  readonly value: string;
  readonly isProtected: boolean;
  readonly notes?: string | null;
  readonly updatedBy: string;
}

interface AnswerRow {
  key: string;
  value: string;
  is_protected: number;
  notes: string | null;
  updated_by: string;
  updated_at: string;
}

const toAnswer = (row: AnswerRow): Answer => ({
  key: row.key,
  value: row.value,
  isProtected: row.is_protected === 1,
  notes: row.notes,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});

export function createAnswerBankRepo(db: DatabaseSync) {
  const getStmt = db.prepare("select * from answer_bank where key = ?");
  const listStmt = db.prepare("select * from answer_bank order by key");
  const upsertStmt = db.prepare(
    `insert into answer_bank (key, value, is_protected, notes, updated_by, updated_at)
     values (?, ?, ?, ?, ?, datetime('now'))
     on conflict(key) do update set value = excluded.value, is_protected = excluded.is_protected,
       notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );

  return {
    get(key: string): Answer | null {
      const row = getStmt.get(key) as AnswerRow | undefined;
      return row ? toAnswer(row) : null;
    },
    list(): Answer[] {
      return (listStmt.all() as unknown as AnswerRow[]).map(toAnswer);
    },
    upsert(input: AnswerInput): Answer {
      const key = input.key.trim();
      if (!key) throw new Error("Answer key must not be empty");
      upsertStmt.run(
        key,
        input.value,
        input.isProtected ? 1 : 0,
        input.notes ?? null,
        input.updatedBy,
      );
      const saved = getStmt.get(key) as AnswerRow;
      return toAnswer(saved);
    },
  };
}

export type AnswerBankRepo = ReturnType<typeof createAnswerBankRepo>;
