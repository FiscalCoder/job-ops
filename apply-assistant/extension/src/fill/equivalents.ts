/**
 * Other ways a dropdown words the same answer: a degree ("Bachelor's Degree" listed as "BS" or
 * "B.Tech"), an Indian state ("TN"), where you heard of the job ("LinkedIn" as "Linked In").
 * Used only after the answer itself matched nothing, so no list that words it your way is
 * affected; before this, those misses went to Claude (a screenshot-driven takeover).
 */

/** Each group: one answer's ways, the likelier ones first (the first that a list has wins). */
const GROUPS: readonly (readonly string[])[] = [
  // Degrees. An engineering bachelor's ranks BS above BA when a list has only the short forms.
  [
    "Bachelor's Degree", "Bachelor's", "Bachelors", "Bachelor", "Bachelor of Technology", "B.Tech",
    "BTech", "Bachelor of Engineering", "B.E.", "BE", "Bachelor of Science", "BS", "B.S.", "BSc",
    "B.Sc", "Undergraduate Degree", "Undergraduate", "BA", "B.A.",
  ],
  [
    "Master's Degree", "Master's", "Masters", "Master", "Master of Technology", "M.Tech", "MTech",
    "Master of Science", "MS", "M.S.", "MSc", "M.Sc", "Master of Engineering", "M.E.", "MA", "M.A.",
    "Postgraduate Degree", "Post Graduate Degree",
  ],
  [
    "PG Diploma", "Post Graduate Diploma", "Post-Graduate Diploma", "Postgraduate Diploma",
    "Post Graduation Diploma", "PGD", "Graduate Diploma",
  ],
  ["Doctorate", "PhD", "Ph.D.", "Ph.D", "Doctoral Degree", "Doctor of Philosophy"],
  ["High School", "High School Diploma", "HS", "Secondary School", "12th", "Higher Secondary"],
  // Indian states as lists abbreviate them.
  ["Tamil Nadu", "TN", "IN-TN", "Tamilnadu"],
  ["Karnataka", "KA", "IN-KA"],
  ["Telangana", "TG", "TS", "IN-TG"],
  ["Maharashtra", "MH", "IN-MH"],
  ["Kerala", "KL", "IN-KL"],
  ["Andhra Pradesh", "AP", "IN-AP"],
  ["Delhi", "DL", "IN-DL", "New Delhi", "NCT of Delhi", "National Capital Territory of Delhi"],
  ["Haryana", "HR", "IN-HR"],
  ["Uttar Pradesh", "UP", "IN-UP"],
  ["West Bengal", "WB", "IN-WB"],
  ["Gujarat", "GJ", "IN-GJ"],
  // "How did you hear about us?": your answer, then the category a list files it under.
  ["LinkedIn", "Linked In", "LinkedIn Job Posting", "Job Board", "Online Job Board", "Social Media", "Internet"],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}+']+/gu, " ")
    .trim();

/** The group an answer belongs to: by its whole wording, not a word in it. */
const groupOf = (wanted: string): readonly string[] | null => {
  const w = norm(wanted);
  if (!w) return null;
  return GROUPS.find((g) => g.some((term) => norm(term) === w)) ?? null;
};

/** The other wordings of your answer, likelier first (none for an answer not in the table). */
export function equivalentTerms(wanted: string): string[] {
  const group = groupOf(wanted);
  if (!group) return [];
  const w = norm(wanted);
  return group.filter((term) => norm(term) !== w);
}

/**
 * The option that is your answer worded another way: the first equivalent (in the group's
 * order) that some option is, exactly or as its whole wording give or take punctuation
 * ("B.Tech" for "BTech"). Short forms ("BS", "TN") match only a whole option, never a word in
 * a longer one, so "BS" can't pick "BS in Physics, Other".
 */
export function bestEquivalentOption(labels: readonly string[], wanted: string): number | null {
  const terms = equivalentTerms(wanted);
  if (!terms.length) return null;
  const options = labels.map(norm);
  const squash = (s: string) => s.replace(/[^\p{L}\p{N}+]/gu, "");
  for (const term of terms) {
    const t = norm(term);
    const exact = options.findIndex((o) => o === t);
    if (exact >= 0) return exact;
    const loose = options.findIndex((o) => squash(o) === squash(t));
    if (loose >= 0) return loose;
    // A longer wording only for long terms: "Bachelor of Technology (B.Tech)".
    if (t.length >= 6) {
      const within = options.findIndex((o) => ` ${o} `.includes(` ${t} `));
      if (within >= 0) return within;
    }
  }
  return null;
}
