import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/**
 * Claude's picks from a list, per question and your answer ("Field of Study" + "Information
 * System Management" → "Information Systems"). The same question came back again and again
 * (25 of 43 picks in the traces were repeats); a remembered pick is used without asking Claude,
 * but only where the list shown has that same choice.
 */

/** A question or answer as it's matched: case, punctuation and spacing aside. */
export const normChoiceText = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim()
    .slice(0, 300);

export function createChoicePicksRepo(db: DatabaseSync) {
  const get = db.prepare(
    "select choice from choice_picks where user_id = ? and label_norm = ? and wanted_norm = ?",
  );
  const save = db.prepare(
    `insert into choice_picks (user_id, label_norm, wanted_norm, choice) values (?, ?, ?, ?)
     on conflict (user_id, label_norm, wanted_norm)
     do update set choice = excluded.choice, updated_at = datetime('now')`,
  );
  const used = db.prepare(
    `update choice_picks set uses = uses + 1, updated_at = datetime('now')
     where user_id = ? and label_norm = ? and wanted_norm = ?`,
  );
  const forget = db.prepare(
    "delete from choice_picks where user_id = ? and label_norm = ? and wanted_norm = ?",
  );
  const ofLabel = db.prepare(
    "select wanted_norm, choice from choice_picks where user_id = ? and label_norm = ?",
  );
  const key = (label: string, wanted: string) =>
    [currentUser(), normChoiceText(label), normChoiceText(wanted)] as const;

  return {
    /** The remembered pick for this question and answer; null when there's none. */
    get(label: string, wanted: string): string | null {
      if (!normChoiceText(label) || !normChoiceText(wanted)) return null;
      const row = get.get(...key(label, wanted)) as { choice: string } | undefined;
      return row?.choice ?? null;
    },
    save(label: string, wanted: string, choice: string): void {
      if (!normChoiceText(label) || !normChoiceText(wanted) || !choice.trim()) return;
      save.run(...key(label, wanted), choice.trim().slice(0, 300));
    },
    used(label: string, wanted: string): void {
      used.run(...key(label, wanted));
    },
    forget(label: string, wanted: string): void {
      forget.run(...key(label, wanted));
    },

    /**
     * You corrected a field a remembered (or new) pick filled: that pick is forgotten, matched
     * by your answer or by the choice itself (a pick made when the plan was built shows only the
     * choice). Returns how many were forgotten.
     */
    forgetFor(label: string, value: string): number {
      const user = currentUser();
      const labelNorm = normChoiceText(label);
      const target = normChoiceText(value);
      if (!labelNorm || !target) return 0;
      const rows = ofLabel.all(user, labelNorm) as { wanted_norm: string; choice: string }[];
      let forgotten = 0;
      for (const row of rows)
        if (row.wanted_norm === target || normChoiceText(row.choice) === target) {
          forget.run(user, labelNorm, row.wanted_norm);
          forgotten++;
        }
      return forgotten;
    },
  };
}

export type ChoicePicksRepo = ReturnType<typeof createChoicePicksRepo>;
