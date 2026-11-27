/**
 * Search terms for internship-only boards (Internshala, Unstop).
 *
 * Those boards already return only internships, and they treat each word as a
 * separate keyword: "Marketing Intern" also matches "Accounts Intern". So the
 * internship words are dropped and the remaining keywords de-duplicated
 * ("Marketing Intern" and "Marketing Internship" both become "Marketing").
 */

const INTERNSHIP_WORDS =
  /\b(?:intern|interns|internship|internships|trainee|trainees|summer|winter)\b/gi;

export function toInternshipKeyword(term: string): string {
  return term
    .replace(INTERNSHIP_WORDS, " ")
    .replace(/[^\p{L}\p{N}&+#./ -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keywords for `terms`, in order, without blanks or repeats (case-insensitive). */
export function toInternshipKeywords(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const keyword = toInternshipKeyword(term);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

/** True when a posting title says it is an internship. */
export function isInternshipTitle(title: string | null | undefined): boolean {
  return /\b(?:intern|interns|internship|internships)\b/i.test(title ?? "");
}
