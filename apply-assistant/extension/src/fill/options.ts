/** Timing and option matching that every driver (and site help) shares. */

export const OPTION_WAIT_MS = 5_000;
export const POLL_MS = 120;
export const FORM_WAIT_MS = 15_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const digits = (s: string) => s.replace(/\D/g, "");

/** At most a country code in front: "+91 79048 95653" shows "7904895653", "4000004000000" doesn't show "4000000". */
const MAX_PREFIX_DIGITS = 3;

/** The field holds the same number: its digits, give or take a country code in front. */
export function sameNumber(shown: string, wanted: string): boolean {
  const got = digits(shown);
  const want = digits(wanted);
  return (
    want.length > 0 &&
    got.endsWith(want) &&
    got.length - want.length <= MAX_PREFIX_DIGITS
  );
}

/** A numbers-only field kept just the number of the answer ("4000000" for "4000000 INR per year"). */
export const keptNumber = (shown: string, wanted: string): boolean =>
  shown.trim() !== "" &&
  !/[a-z]/i.test(shown) &&
  digits(wanted).length > 0 &&
  digits(shown) === digits(wanted);

const WORD_CHAR = /[\p{L}\p{N}]/u;
/** What a word can't start right after ("DR.Mr." is one word). */
const JOINS_BEFORE = /[\p{L}\p{N}.]/u;

/**
 * `part` appears in `whole` as whole words: "+91" in "India +91", but not "male" in "female",
 * "+91" in "+9+91" or "Mr." in "DR.Mr.".
 */
export function containsWords(whole: string, part: string): boolean {
  if (!part) return false;
  for (
    let at = whole.indexOf(part);
    at >= 0;
    at = whole.indexOf(part, at + 1)
  ) {
    const before = whole[at - 1] ?? " ";
    const after = whole[at + part.length] ?? " ";
    if (!JOINS_BEFORE.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
}

/**
 * Dropdown option ranking: exact > starts-with > whole word > contains (as whole words, so
 * "Male" never picks "Female"). Among options starting with your answer, one where it's
 * followed by punctuation ("Bengaluru, Karnataka", "India +91") is the place itself; one
 * where another word follows ("Bengaluru Rural") ranks just below.
 */
export function rankOption(label: string, wanted: string): number {
  const s = label.toLowerCase().replace(/\s+/g, " ").trim();
  const w = wanted.toLowerCase().replace(/\s+/g, " ").trim();
  if (!w) return 9;
  if (s === w) return 0;
  if (s.startsWith(w))
    return /^ [\p{L}\p{N}]/u.test(s.slice(w.length)) ? 1.5 : 1;
  const words = (t: string) => ` ${t.replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (words(s).includes(words(w))) return 2;
  if (containsWords(s, w)) return 3;
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

/** Words that don't change what a choice means ("Bachelor of Science" = "Bachelors Science"). */
const SMALL_WORDS = new Set(["and", "the", "of", "in", "for", "with", "a", "an", "&"]);

const wordSet = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}+#]+/u)
      .filter((w) => w && !SMALL_WORDS.has(w))
      .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)),
  );

/**
 * The same words in any order ("Management Information Systems" for "Information System
 * Management"): plurals and small words aside, none more and none fewer.
 */
export function sameWords(label: string, wanted: string): boolean {
  const a = wordSet(label);
  const b = wordSet(wanted);
  return a.size > 0 && a.size === b.size && [...a].every((w) => b.has(w));
}

/**
 * Among every choice seen (across searches), the one that is your answer: as the list words
 * it (bestOption), else the same words in another order. Null when none is: Claude picks then.
 */
export function bestFound(found: readonly string[], wanted: string): string | null {
  const index = bestOption(found, wanted);
  if (index !== null) return found[index] ?? null;
  return found.find((label) => sameWords(label, wanted)) ?? null;
}

/** An answer's words worth searching a list for on their own ("Machine", "Learning"). */
export function searchWords(wanted: string, max = 4): string[] {
  return [
    ...new Set(
      wanted
        .split(/[^\p{L}\p{N}+#.]+/u)
        .filter((w) => w.length > 2 && !SMALL_WORDS.has(w.toLowerCase())),
    ),
  ].slice(0, max);
}

/**
 * Read-back for a dropdown: some widgets show only part of the chosen option (the phone
 * country picker shows "+91" for "India +91"), so either containing the other as whole
 * words counts ("Female" doesn't show "Male").
 */
export function selectionMatches(shown: string, picked: string): boolean {
  const a = shown.trim().toLowerCase();
  const b = picked.trim().toLowerCase();
  // Nothing shown means nothing was chosen (e.g. text typed but the menu never closed).
  if (!a) return false;
  return a === b || containsWords(b, a) || containsWords(a, b);
}
