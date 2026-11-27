import { getCountryIso2Code } from "./location-support.js";
import type { CreateJobInput } from "./types/jobs.js";

/**
 * Fork-only guards for the fuzzy title+employer dedupe (job-matching.ts): two postings
 * for different levels, or in different known cities, are never the same job. A wrong
 * merge hides a job; a duplicate only shows one twice. Idea from Dossier's src/lib/dedupe.ts.
 */

/** Words that say a level, folded so spellings agree ("sr" = "senior", "ii" = "2"). */
const LEVEL_WORDS: Record<string, string> = {
  intern: "intern", internship: "intern", trainee: "trainee", apprentice: "apprentice",
  student: "student", graduate: "graduate", grad: "graduate", fresher: "graduate",
  junior: "junior", jr: "junior", entry: "entry", associate: "associate",
  mid: "mid", intermediate: "mid",
  senior: "senior", sr: "senior", lead: "lead", principal: "principal", staff: "staff",
  head: "head", director: "director", chief: "chief", vp: "vp", manager: "manager",
  i: "1", ii: "2", iii: "3", iv: "4", v: "5",
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5",
  l1: "1", l2: "2", l3: "3", l4: "4", l5: "5", l6: "6", l7: "7",
};

/** Place words that say nothing about the city. */
const NOT_A_CITY = new Set([
  "remote", "hybrid", "onsite", "on", "site", "office", "in", "from", "home", "wfh",
  "work", "anywhere", "worldwide", "global", "multiple", "locations", "and", "or",
]);

/** Old and new names of the same city. */
const CITY_ALIASES: Record<string, string> = {
  bangalore: "bengaluru", bombay: "mumbai", gurgaon: "gurugram", madras: "chennai",
  calcutta: "kolkata", poona: "pune", trivandrum: "thiruvananthapuram",
};

const words = (value: string | null | undefined): string[] =>
  (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

export function levelsOf(title: string): string {
  const levels = new Set(
    words(title).flatMap((word) => LEVEL_WORDS[word] ?? []),
  );
  return [...levels].sort().join(" ");
}

/** The words of a location that could name a city: no work modes, no countries. */
export function placeWordsOf(location: string | null | undefined): Set<string> {
  return new Set(
    words(location)
      .filter((word) => !NOT_A_CITY.has(word) && !getCountryIso2Code(word))
      .map((word) => CITY_ALIASES[word] ?? word),
  );
}

/** False when the two postings can't be one job: other levels, or places with no word in common. */
export function mayBeSameJob(a: CreateJobInput, b: CreateJobInput): boolean {
  if (levelsOf(a.title) !== levelsOf(b.title)) return false;
  const placesA = placeWordsOf(a.location);
  const placesB = placeWordsOf(b.location);
  if (placesA.size === 0 || placesB.size === 0) return true;
  return [...placesA].some((word) => placesB.has(word));
}
