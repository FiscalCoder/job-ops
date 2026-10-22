/** Text helpers for matching a Job Ops job to its Greenhouse posting. Pure functions. */

const TITLE_SYNONYMS: readonly [RegExp, string][] = [
  [/\bsr\b\.?/g, "senior"],
  [/\bjr\b\.?/g, "junior"],
  [/\bsde\b/g, "software development engineer"],
  [/\bswe\b/g, "software engineer"],
  [/\bfull[\s-]?stack\b/g, "fullstack"],
  [/\bfront[\s-]?end\b/g, "frontend"],
  [/\bback[\s-]?end\b/g, "backend"],
];

const titleTokens = (title: string): string[] => {
  const lowered = TITLE_SYNONYMS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    title.toLowerCase(),
  );
  return lowered
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 || /^[0-9]$/.test(token));
};

/** Share of words the two titles have in common (0..1), relative to the longer title. */
export function titleScore(a: string, b: string): number {
  const left = new Set(titleTokens(a));
  const right = new Set(titleTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared / Math.max(left.size, right.size);
}

const LEGAL_SUFFIXES =
  /\b(private|pvt|limited|ltd|llp|llc|inc|incorporated|corp|corporation|co|company|gmbh|ag|bv|plc|sa|india|global|holdings)\b/g;

/** Stable key for an employer name, used to cache its Greenhouse board. */
export function employerKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, "")
    .trim();
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&amp;": "&",
};

/** Greenhouse returns job content as escaped HTML; turn it (or plain HTML) into plain text. */
const decode = (html: string): string => {
  let decoded = html;
  for (let i = 0; i < 2; i++)
    decoded = decoded.replace(
      /&(lt|gt|quot|#39|nbsp|amp);/g,
      (m) => ENTITIES[m] ?? m,
    );
  return decoded;
};

export function htmlToText(html: string): string {
  return decode(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A resume entry's description as its points, one per line: a bullet list numbered
 * ("1. …"), paragraphs as they are.
 */
export function htmlToPoints(html: string): string {
  const decoded = decode(html);
  const items = [...decoded.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => htmlToText(m[1] ?? ""))
    .filter(Boolean);
  if (items.length > 1)
    return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  return decoded
    .split(/<\/p>|<br\s*\/?>|<\/li>/i)
    .map(htmlToText)
    .filter(Boolean)
    .join("\n");
}

const SHINGLE = 3;

const shingles = (text: string): Set<string> => {
  const words = htmlToText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= words.length; i++)
    out.add(words.slice(i, i + SHINGLE).join(" "));
  return out;
};

/**
 * How much of the shorter description appears in the longer one (0..1), on 3-word shingles.
 * Containment instead of Jaccard, so extra boilerplate on one side doesn't hide a match.
 */
export function descriptionSimilarity(a: string, b: string): number {
  const left = shingles(a);
  const right = shingles(b);
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] =
    left.size <= right.size ? [left, right] : [right, left];
  const shared = [...small].filter((s) => large.has(s)).length;
  return shared / small.size;
}

const LEVEL_WORDS = new Set([
  "intern",
  "junior",
  "associate",
  "mid",
  "senior",
  "staff",
  "principal",
  "lead",
  "head",
  "director",
  "manager",
  "vp",
  "i",
  "ii",
  "iii",
  "iv",
  "v",
]);
const NUMERIC_LEVEL: Record<string, string> = {
  "1": "i",
  "2": "ii",
  "3": "iii",
  "4": "iv",
  "5": "v",
};

/** Seniority markers in a title ("Senior", "Staff", "II"…); numeric levels map to roman. */
export function titleLevels(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/\bsr\b\.?/g, "senior")
    .replace(/\bjr\b\.?/g, "junior")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((w) => NUMERIC_LEVEL[w] ?? w);
  return new Set(words.filter((w) => LEVEL_WORDS.has(w)));
}

/** True when both titles state a level and they share none (e.g. Senior vs Staff, II vs III). */
export function levelsConflict(a: string, b: string): boolean {
  const left = titleLevels(a);
  const right = titleLevels(b);
  if (left.size === 0 || right.size === 0) return false;
  return ![...left].some((level) => right.has(level));
}
