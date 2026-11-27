/**
 * Finds what a Claude-written text claims that its sources don't back: names and acronyms,
 * numbers (years, percentages, counts) and credentials ("certified"). Plain code, no AI.
 * A safety net for drafted answers: what it finds is filled anyway and listed at review.
 *
 * Ported from Dossier's src/lib/ai/fact-guard.ts (github.com/AienTech/dossier, AGPL-3.0),
 * without its profile-specific parts.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  hundred: 100,
};

const MONTHS_AND_DAYS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

/** Capitalised mid-sentence, but not names. */
const NOT_NAMES = new Set([
  "i",
  "i'm",
  "i’m",
  "i've",
  "i’ve",
  "i'd",
  "i’d",
  "i'll",
  "i’ll",
  "ok",
]);

/** Everyday acronyms that are vocabulary, not claims. shortcut: a fixed list; extend it when reviews show noise. */
const COMMON_ACRONYMS = new Set([
  "api",
  "ui",
  "ux",
  "ai",
  "ml",
  "llm",
  "saas",
  "b2b",
  "b2c",
  "ceo",
  "cto",
  "hr",
  "it",
  "qa",
  "ci",
  "cd",
  "us",
  "usa",
  "uk",
  "eu",
  "faq",
  "kpi",
  "okr",
  "roi",
  "sla",
  "sdk",
  "url",
  "json",
  "html",
  "css",
]);

/** Credentials said in words rather than as an acronym. */
const CREDENTIAL =
  /\b(certified|certification|certificate|licensed|license|accredited|chartered)\b/gi;

/** A number as people write it: "4,000+", "120k", "30%", "2.5", "12". */
const NUMBER =
  /(?<![\p{L}\p{N}])(\d{1,3}(?:[,.   ]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|m)?%?(?![\p{L}\p{N}])/giu;

/** A number's value, whatever its formatting: "4,000+" and "4000" are the same. */
function numberValue(digits: string, suffix: string | undefined): number {
  const thousands = /^\d{1,3}(?:[,.   ]\d{3})+$/.test(digits);
  const value = thousands
    ? Number(digits.replace(/[^\d]/g, ""))
    : Number(digits.replace(",", "."));
  const scale =
    suffix?.toLowerCase() === "k"
      ? 1_000
      : suffix?.toLowerCase() === "m"
        ? 1_000_000
        : 1;
  return value * scale;
}

function numbersIn(text: string): { raw: string; value: number }[] {
  const found = [...text.matchAll(NUMBER)].map((match) => ({
    raw: match[0].trim(),
    value: numberValue(match[1] ?? "", match[2]),
  }));
  for (const match of text.matchAll(/\b([a-z]+)\b/gi)) {
    const word = match[1] ?? "";
    const value = NUMBER_WORDS[word.toLowerCase()];
    if (value !== undefined) found.push({ raw: word, value });
  }
  return found;
}

/** Everything a claim may be backed by, lowercased for lookups. */
export interface FactSources {
  readonly text: string;
  readonly words: ReadonlySet<string>;
  readonly numbers: ReadonlySet<number>;
}

/** `word` without any of `marks` at its end (a loop: a pattern is slow on long runs). */
function trimEnd(word: string, marks: string): string {
  let end = word.length;
  while (end > 0 && marks.includes(word.charAt(end - 1))) end--;
  return word.slice(0, end);
}

export function factSources(parts: readonly string[]): FactSources {
  const text = parts.join("\n").toLowerCase();
  return {
    text,
    words: new Set(
      text
        .match(/[\p{L}\p{N}][\p{L}\p{N}&'’.+#-]*/gu)
        ?.map((word) => trimEnd(word, ".'’")) ?? [],
    ),
    numbers: new Set(numbersIn(text).map((number) => number.value)),
  };
}

/** Where sentences start: capitals there are grammar, not names. */
function sentenceStarts(text: string): Set<number> {
  const starts = new Set<number>([0]);
  for (const match of text
    .trimEnd()
    .matchAll(/(?:[.!?:;]["”’)]?\s+|\n)\s*(?:[-*•·]\s+)?(?=\S)/g))
    starts.add(match.index + match[0].length);
  return starts;
}

/** What in `text` the sources don't back, in order, once each. */
export function unverifiedFacts(text: string, sources: FactSources): string[] {
  const flags: string[] = [];
  const flag = (value: string) => {
    if (!flags.includes(value)) flags.push(value);
  };

  // Names: capitalised words that don't start a sentence, and acronyms anywhere.
  const starts = sentenceStarts(text);
  for (const match of text.matchAll(/[\p{Lu}][\p{L}\p{N}&'’+#-]*/gu)) {
    const word = trimEnd(match[0].replace(/['’]s$/, ""), "-'’");
    const lower = word.toLowerCase();
    const acronym = (word.match(/\p{Lu}/gu)?.length ?? 0) >= 2;
    if (starts.has(match.index) && !acronym) continue;
    if (NOT_NAMES.has(lower) || MONTHS_AND_DAYS.has(lower)) continue;
    // "APIs" is the plural of "API".
    const singular =
      acronym && /\p{Lu}s$/u.test(word) ? lower.slice(0, -1) : lower;
    if (COMMON_ACRONYMS.has(singular)) continue;
    if (
      [lower, singular].some(
        (w) => sources.words.has(w) || sources.text.includes(w),
      )
    )
      continue;
    flag(word);
  }

  for (const number of numbersIn(text)) {
    if (sources.numbers.has(number.value)) continue;
    // "one of the…", "a single…" aren't claims.
    if (/^[a-z]+$/i.test(number.raw) && number.value <= 2) continue;
    flag(number.raw);
  }

  for (const match of text.matchAll(CREDENTIAL)) {
    const word = match[1] ?? "";
    if (!sources.text.includes(word.toLowerCase().slice(0, 7))) flag(word);
  }
  return flags;
}
