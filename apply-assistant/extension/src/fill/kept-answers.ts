import type { ApplyClient } from "../lib/api";
import { selectionMatches } from "./options";
import type { PlanEntry, Step } from "./supervisor";

/**
 * Claude's choices you kept: a choice Claude made for a question (not a saved answer it pointed
 * to, not a draft, not an unsure one), still showing on the page while you reviewed it, in an
 * application you then submitted. Remembered like your own answers, so the next form asking the
 * same question needs no Claude. An answer you gave yourself is never replaced by one of these.
 */

const CHOICE_TYPES = new Set(["select", "multiselect"]);

export function keepable(step: Step): boolean {
  const { entry } = step;
  return (
    step.state === "done" &&
    step.decision !== "edited" &&
    step.decision !== "you-did-it" &&
    step.value !== null &&
    CHOICE_TYPES.has(entry.type) &&
    /^claude:/.test(entry.source) &&
    !entry.source.includes("→ bank:") &&
    !/ draft$/.test(entry.source) &&
    !entry.check &&
    entry.actionClass !== "protected" &&
    entry.section !== "demographic" &&
    entry.section !== "compliance"
  );
}

/** The field still shows the value it was filled with. */
export function stillShows(
  shown: string,
  value: string | readonly string[],
): boolean {
  const values = typeof value === "string" ? [value] : value;
  return values.length > 0 && values.every((v) => selectionMatches(shown, v));
}

interface Kept {
  readonly label: string;
  readonly type: string;
  readonly value: string | readonly string[];
}

export class KeptAnswers {
  private readonly kept = new Map<string, Kept>();

  /** Looks at the page as you review it: what still shows Claude's choice. */
  async note(
    steps: readonly Step[],
    readBack: (entry: PlanEntry) => Promise<string>,
  ): Promise<void> {
    for (const step of steps) {
      if (!keepable(step) || step.value === null) continue;
      const key = step.entry.label;
      const shown = await readBack(step.entry).catch(() => "");
      if (stillShows(shown, step.value))
        this.kept.set(key, { label: key, type: step.entry.type, value: step.value });
      else this.kept.delete(key);
    }
  }

  get size(): number {
    return this.kept.size;
  }

  /** You submitted: each kept choice is remembered. Returns how many were. */
  async remember(client: ApplyClient, jobId: string): Promise<number> {
    let saved = 0;
    for (const answer of this.kept.values()) {
      const ok = await client
        .learn({ jobId, ...answer, how: "accepted" })
        .then(() => true)
        .catch(() => false);
      if (ok) saved += 1;
    }
    return saved;
  }
}
