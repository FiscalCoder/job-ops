/**
 * Other ways a dropdown words the same answer: a degree ("B.Tech" listed as "BS", "B.Com" as
 * "Bachelor of Commerce"), an Indian state ("TN"), where you heard of the job ("LinkedIn" as
 * "Linked In"). Used only after the answer itself matched nothing, so no list that words it your
 * way is affected; what's still unmatched goes to Claude, who picks from the list's choices.
 *
 * Degrees: a level ("Bachelor's Degree") only matches the level's own wordings, never a subject
 * degree. Which subject (BS, BA, B.Com, BBA…) is your degree's call: the plan passes your
 * resume's degree along ("B.Com"), and its own group below finds it. Before, "Bachelor's
 * Degree" picked BS for everyone, which was right for an engineer only.
 */

/** Each group: one answer's ways, the likelier ones first (the first that a list has wins). */
const GROUPS: readonly (readonly string[])[] = [
  // Degree levels: wordings of the level itself.
  ["Bachelor's Degree", "Bachelor's", "Bachelors", "Bachelor", "Bachelor Degree", "Undergraduate Degree", "Undergraduate"],
  ["Master's Degree", "Master's", "Masters", "Master", "Master Degree", "Postgraduate Degree", "Post Graduate Degree", "Postgraduate"],
  // Bachelor's subjects. Engineering is a science degree where a list has only BS / BA.
  [
    "B.Tech", "BTech", "B Tech", "Bachelor of Technology", "B.E.", "BE", "Bachelor of Engineering",
    "Bachelor of Science", "BS", "B.S.", "BSc", "B.Sc",
  ],
  ["B.E.", "BE", "Bachelor of Engineering", "B.Tech", "BTech", "Bachelor of Technology", "Bachelor of Science", "BS", "B.S.", "BSc"],
  ["Bachelor of Science", "BS", "B.S.", "BSc", "B.Sc", "B Sc"],
  ["Bachelor of Arts", "BA", "B.A.", "B A"],
  ["Bachelor of Commerce", "B.Com", "BCom", "B Com", "B.Com.", "Bachelor of Commerce (B.Com)"],
  [
    "Bachelor of Business Administration", "BBA", "B.B.A.", "BBM", "Bachelor of Business Management",
    "Bachelor of Management Studies", "BMS", "Bachelor of Business",
  ],
  ["Bachelor of Computer Applications", "BCA", "B.C.A."],
  ["Bachelor of Fine Arts", "BFA", "B.F.A."],
  ["Bachelor of Design", "B.Des", "BDes"],
  ["Bachelor of Mass Media", "BMM", "Bachelor of Journalism and Mass Communication", "BJMC", "Bachelor of Arts"],
  // Master's subjects.
  [
    "M.Tech", "MTech", "M Tech", "Master of Technology", "M.E.", "ME", "Master of Engineering",
    "Master of Science", "MS", "M.S.", "MSc", "M.Sc",
  ],
  ["Master of Science", "MS", "M.S.", "MSc", "M.Sc", "M Sc"],
  ["Master of Arts", "MA", "M.A."],
  ["Master of Commerce", "M.Com", "MCom", "M Com"],
  ["Master of Business Administration", "MBA", "M.B.A.", "PGDM", "Post Graduate Diploma in Management"],
  [
    "PGDM", "Post Graduate Diploma in Management", "Postgraduate Diploma in Management", "PGDBA",
    "Master of Business Administration", "MBA",
  ],
  ["Master of Computer Applications", "MCA", "M.C.A."],
  ["Master of Fine Arts", "MFA", "M.F.A."],
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
  [
    "LinkedIn", "Linked In", "LinkedIn Job Posting", "Job Board", "Online Job Board",
    "Social Media", "Website/Social Media", "Social Media/Website", "Social Networking", "Internet",
  ],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}+']+/gu, " ")
    .trim();

/**
 * The group an answer belongs to, by its whole wording (not a word in it). A wording in several
 * groups ("Bachelor of Science" is also engineering's fallback) belongs to the one where it comes
 * earliest: its own.
 */
const groupOf = (wanted: string): readonly string[] | null => {
  const w = norm(wanted);
  if (!w) return null;
  let best: { group: readonly string[]; at: number } | null = null;
  for (const group of GROUPS) {
    const at = group.findIndex((term) => norm(term) === w);
    if (at >= 0 && (best === null || at < best.at)) best = { group, at };
  }
  return best?.group ?? null;
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
