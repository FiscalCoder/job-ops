/** Timing and option matching that every driver (and site help) shares. */

export const OPTION_WAIT_MS = 5_000;
export const POLL_MS = 120;
export const FORM_WAIT_MS = 15_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Dropdown option ranking: exact > starts-with > whole word > contains. Among options starting
 * with your answer, one where it's followed by punctuation ("Bengaluru, Karnataka", "India +91")
 * is the place itself; one where another word follows ("Bengaluru Rural") ranks just below.
 */
export function rankOption(label: string, wanted: string): number {
  const s = label.toLowerCase().replace(/\s+/g, " ").trim();
  const w = wanted.toLowerCase().replace(/\s+/g, " ").trim();
  if (!w) return 9;
  if (s === w) return 0;
  if (s.startsWith(w)) return /^ [\p{L}\p{N}]/u.test(s.slice(w.length)) ? 1.5 : 1;
  const words = (t: string) => ` ${t.replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (words(s).includes(words(w))) return 2;
  if (s.includes(w)) return 3;
  return 9;
}

export function bestOption(
  labels: readonly string[],
  wanted: string,
): number | null {
  const ranked = labels
    .map((label, index) => ({ index, rank: rankOption(label, wanted) }))
    .filter((r) => r.rank < 9)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (labels[a.index]?.length ?? 0) - (labels[b.index]?.length ?? 0),
    );
  return ranked[0]?.index ?? null;
}

/**
 * Read-back for a dropdown: some widgets show only part of the chosen option (the phone
 * country picker shows "+91" for "India +91"), so either containing the other counts.
 */
export function selectionMatches(shown: string, picked: string): boolean {
  const a = shown.trim().toLowerCase();
  const b = picked.trim().toLowerCase();
  // Nothing shown means nothing was chosen (e.g. text typed but the menu never closed).
  if (!a) return false;
  return a === b || b.includes(a) || a.includes(b);
}
