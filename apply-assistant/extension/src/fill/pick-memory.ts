import type { RunEvent, Step } from "./supervisor";

/**
 * Claude's picks from lists are remembered and reused (server: choice-picks-repo.ts). One you
 * correct is forgotten, so a wrong pick isn't repeated on the next form: you edit the value it
 * planned, fill the field yourself, or change it on the page while paused.
 */

/** Filled (or planned) by a list pick: Claude's, or one remembered from before. */
const LIST_PICK = /Claude picked|as before for this answer|picked ".*" as before/i;

export function isListPick(step: Step): boolean {
  return LIST_PICK.test(step.result ?? "") || LIST_PICK.test(step.entry.reason ?? "");
}

const text = (value: Step["value"]): string =>
  (Array.isArray(value) ? (value[0] ?? "") : (value ?? "")).toString().trim();

/** The value a list pick put in that this event corrects; null when it corrects none. */
export function pickToForget(event: RunEvent, step: Step | undefined): string | null {
  if (!step || !isListPick(step)) return null;
  const value = text(step.value);
  if (!value) return null;
  if (event.type === "i-did-it") return value;
  if (event.type === "edit") return text(event.value) === value ? null : value;
  return null;
}
