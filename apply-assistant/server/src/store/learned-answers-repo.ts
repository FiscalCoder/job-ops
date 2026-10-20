import type { DatabaseSync } from "node:sqlite";

/** Answers you gave to form questions, keyed by the normalised question (question-norm.ts). */

export type LearnedHow = "edited" | "typed";

export interface LearnedAnswer {
  readonly id: number;
  readonly questionNorm: string;
  /** The question as the form asked it the last time. */
  readonly label: string;
  readonly fieldType: string;
  readonly value: string | readonly string[];
  /** Edited in the side panel, or typed on the page yourself ("I'll do it"). */
  readonly how: LearnedHow;
  readonly lastJobId: string | null;
  readonly updatedAt: string;
}

interface Row {
  id: number;
  question_norm: string;
  label: string;
  field_type: string;
  answer_json: string;
  how: LearnedHow;
  last_job_id: string | null;
  updated_at: string;
}

const toAnswer = (row: Row): LearnedAnswer => ({
  id: row.id,
  questionNorm: row.question_norm,
  label: row.label,
  fieldType: row.field_type,
  value: JSON.parse(row.answer_json) as string | string[],
  how: row.how,
  lastJobId: row.last_job_id,
  updatedAt: row.updated_at,
});

export function createLearnedAnswersRepo(db: DatabaseSync) {
  const upsertStmt = db.prepare(
    `insert into learned_answers (question_norm, label, field_type, answer_json, how, last_job_id)
     values (?, ?, ?, ?, ?, ?)
     on conflict(question_norm) do update set label = excluded.label, field_type = excluded.field_type,
       answer_json = excluded.answer_json, how = excluded.how, last_job_id = excluded.last_job_id,
       updated_at = datetime('now')`,
  );
  const byNorm = db.prepare(
    "select * from learned_answers where question_norm = ?",
  );
  const all = db.prepare(
    "select * from learned_answers order by updated_at desc, id desc",
  );
  const remove = db.prepare("delete from learned_answers where id = ?");

  return {
    save(input: {
      questionNorm: string;
      label: string;
      fieldType: string;
      value: string | readonly string[];
      how: LearnedHow;
      jobId: string | null;
    }): LearnedAnswer {
      upsertStmt.run(
        input.questionNorm,
        input.label,
        input.fieldType,
        JSON.stringify(input.value),
        input.how,
        input.jobId,
      );
      return toAnswer(byNorm.get(input.questionNorm) as unknown as Row);
    },
    get(questionNorm: string): LearnedAnswer | null {
      const row = byNorm.get(questionNorm) as Row | undefined;
      return row ? toAnswer(row) : null;
    },
    list(): LearnedAnswer[] {
      return (all.all() as unknown as Row[]).map(toAnswer);
    },
    /** True when something was deleted. */
    delete(id: number): boolean {
      return Number(remove.run(id).changes) > 0;
    },
  };
}

export type LearnedAnswersRepo = ReturnType<typeof createLearnedAnswersRepo>;
