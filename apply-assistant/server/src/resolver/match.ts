import { descriptionSimilarity, levelsConflict, titleScore } from "./text.js";

export interface BoardJob {
  readonly id: string;
  readonly title: string;
  readonly location: string;
  readonly url: string;
}

export interface JobToMatch {
  readonly title: string;
  readonly location: string;
  readonly description: string;
}

export type MatchResult =
  | { status: "need-details"; ghJobIds: string[] }
  | {
      status: "matched" | "possible";
      job: BoardJob;
      titleScore: number;
      descScore: number | null;
    }
  | { status: "none"; reason: string };

export const TITLE_CANDIDATE_MIN = 0.6;
export const DESC_MATCH_MIN = 0.55;
export const DESC_POSSIBLE_MIN = 0.3;
const MAX_CANDIDATES = 5;

const locationFit = (wanted: string, offered: string): number => {
  const words = wanted
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2);
  const target = offered.toLowerCase();
  return words.some((w) => target.includes(w))
    ? 1
    : /remote|anywhere/.test(target)
      ? 0.5
      : 0;
};

/**
 * Picks the Greenhouse posting that is the same job: title candidates first, then the
 * description check (needs `details`: Greenhouse content per candidate id), location as tie-break.
 */
export function matchOnBoard(
  job: JobToMatch,
  board: readonly BoardJob[],
  details: Readonly<Record<string, string>>,
): MatchResult {
  const candidates = board
    .map((b) => ({ b, t: titleScore(job.title, b.title) }))
    .filter(({ t }) => t >= TITLE_CANDIDATE_MIN)
    .sort((x, y) => y.t - x.t)
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0)
    return { status: "none", reason: "no title match on board" };

  const missing = candidates
    .filter(({ b }) => details[b.id] === undefined)
    .map(({ b }) => b.id);
  if (missing.length > 0) return { status: "need-details", ghJobIds: missing };

  if (!job.description.trim()) {
    const best = candidates[0];
    return best
      ? { status: "possible", job: best.b, titleScore: best.t, descScore: null }
      : { status: "none", reason: "no candidates" };
  }

  const scored = candidates
    .map(({ b, t }) => ({
      b,
      t,
      d: descriptionSimilarity(job.description, details[b.id] ?? ""),
      l: locationFit(job.location, b.location),
    }))
    .sort((x, y) => y.d - x.d || y.l - x.l || y.t - x.t);
  const best = scored[0];
  if (!best) return { status: "none", reason: "no candidates" };

  // Postings whose description clears the match bar are the same job family (e.g. Senior and
  // Staff versions, or one role posted in several cities): the closest title wins, then location.
  // Below the bar, fall back to near-ties on description.
  const pool =
    best.d >= DESC_MATCH_MIN
      ? scored.filter((s) => s.d >= DESC_MATCH_MIN)
      : scored.filter((s) => Math.abs(s.d - best.d) < 0.05);
  const pick =
    [...pool].sort((x, y) => y.t - x.t || y.l - x.l || y.d - x.d)[0] ?? best;

  // A different seniority level is a different job you may or may not want (e.g. the Senior
  // posting closed and only Staff is open): never auto-match it, let the user decide.
  const sameLevel = !levelsConflict(job.title, pick.b.title);
  if (pick.d >= DESC_MATCH_MIN && sameLevel)
    return {
      status: "matched",
      job: pick.b,
      titleScore: pick.t,
      descScore: pick.d,
    };
  if (pick.d >= DESC_MATCH_MIN)
    return {
      status: "possible",
      job: pick.b,
      titleScore: pick.t,
      descScore: pick.d,
    };
  // A matching title alone is never enough: generic titles ("Senior Software Engineer") repeat
  // across different jobs on the same board, so the description decides.
  if (pick.d >= DESC_POSSIBLE_MIN)
    return {
      status: "possible",
      job: pick.b,
      titleScore: pick.t,
      descScore: pick.d,
    };
  return { status: "none", reason: "descriptions differ" };
}
