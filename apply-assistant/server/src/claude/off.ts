import type { QuestionAnswerer } from "./answerer.js";

const NO_CLAUDE = "Claude isn't set up on the server";

/** Why Claude can't be used for the signed-in user right now; null when it can. */
export function claudeOff(answerer: QuestionAnswerer | null): string | null {
  if (!answerer) return NO_CLAUDE;
  return answerer.unavailable?.() ?? null;
}
