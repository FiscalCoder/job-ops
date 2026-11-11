/**
 * A text shortened to a field's character limit (its maxlength) the way a person would: at the
 * last full sentence that fits, else at the last whole word. A page left to do it cuts mid-word
 * ("full-stack en"), and the fill then reads back as "didn't stick".
 */

/** A sentence end must leave at least this share of the limit, or a word cut keeps more. */
const MIN_SENTENCE_SHARE = 0.5;

export function fitToLength(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  const head = text.slice(0, max);
  // The text right after the cut: a sentence that ends exactly at the limit is whole.
  const endsAtCut = /[.!?]$/.test(head) && /^(\s|$)/.test(text.slice(max));
  if (endsAtCut) return head.trim();
  let sentenceEnd = -1;
  for (const match of head.matchAll(/[.!?](?=\s)/g)) sentenceEnd = match.index;
  if (sentenceEnd >= 0 && sentenceEnd + 1 >= max * MIN_SENTENCE_SHARE)
    return head.slice(0, sentenceEnd + 1).trim();
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : head;
  return cut.replace(/[\s,;:–—-]+$/u, "").trim();
}
