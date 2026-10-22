import type { DatabaseSync } from "node:sqlite";
import { currentUser } from "./owner.js";

/**
 * Steps that set a field on a company's own form (worked out by Claude, then checked on the
 * page), kept per site and question so the next application there runs them without Claude.
 * Your answer is never stored in them: it's "{value}".
 */

export interface RecipeStep {
  readonly action: "click" | "type" | "press" | "pick" | "wait";
  readonly value: string;
}

export interface SiteRecipe {
  readonly host: string;
  readonly labelKey: string;
  readonly label: string;
  readonly steps: readonly RecipeStep[];
  readonly worked: number;
  readonly failed: number;
  readonly updatedAt: string;
}

interface Row {
  host: string;
  label_key: string;
  label: string;
  steps_json: string;
  worked: number;
  failed: number;
  updated_at: string;
}

/** "Date of birth *" and "date of birth" are the same question. */
export const labelKey = (label: string) =>
  label
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 200);

const toRecipe = (row: Row): SiteRecipe => ({
  host: row.host,
  labelKey: row.label_key,
  label: row.label,
  steps: JSON.parse(row.steps_json) as RecipeStep[],
  worked: row.worked,
  failed: row.failed,
  updatedAt: row.updated_at,
});

export function createSiteRecipesRepo(db: DatabaseSync) {
  const worked = db.prepare(
    `insert into site_recipes (user_id, host, label_key, label, steps_json, worked, failed)
     values (?, ?, ?, ?, ?, 1, 0)
     on conflict(user_id, host, label_key) do update set label = excluded.label,
       steps_json = excluded.steps_json, worked = worked + 1, updated_at = datetime('now')`,
  );
  const failed = db.prepare(
    `update site_recipes set failed = failed + 1, updated_at = datetime('now')
     where user_id = ? and host = ? and label_key = ?`,
  );
  const byHost = db.prepare(
    "select * from site_recipes where user_id = ? and host = ? order by label_key",
  );
  const one = db.prepare(
    "select * from site_recipes where user_id = ? and host = ? and label_key = ?",
  );

  return {
    forHost(host: string): SiteRecipe[] {
      return (byHost.all(currentUser(), host) as unknown as Row[]).map(toRecipe);
    },
    /** A run's result with a recipe (or with Claude's steps, which become the recipe). */
    record(input: {
      host: string;
      label: string;
      steps: readonly RecipeStep[];
      ok: boolean;
    }): SiteRecipe | null {
      const user = currentUser();
      const key = labelKey(input.label);
      if (input.ok)
        worked.run(user, input.host, key, input.label, JSON.stringify(input.steps));
      else failed.run(user, input.host, key);
      const row = one.get(user, input.host, key) as Row | undefined;
      return row ? toRecipe(row) : null;
    },
  };
}

export type SiteRecipesRepo = ReturnType<typeof createSiteRecipesRepo>;
