import type { Job } from "@shared/types";
import type { SmartRouterResult } from "./email-router";

/**
 * Fork-only checks around the smart router's job match (kept out of the upstream files so
 * upstream changes to them merge cleanly; gmail-sync.ts calls in here at two points).
 *
 * - An email can only be about an application you'd already made when it arrived.
 * - When the email names a requisition number, it picks between the same company's jobs.
 * - "Complete your application" reminders mean it was never submitted: they come to you
 *   as a suggestion instead of being linked (or ignored) silently.
 */

export type GuardJob = Pick<
  Job,
  | "id"
  | "employer"
  | "title"
  | "appliedAt"
  | "applicationLink"
  | "jobUrl"
  | "jobUrlDirect"
>;

/**
 * Slack for an application marked applied a little after its confirmation arrived. Small on
 * purpose: a re-application 2-3 days after a rejection must not catch that rejection.
 */
export const APPLIED_GRACE_MS = 24 * 60 * 60 * 1000;

/** Below the auto-link threshold in gmail-sync.ts (95): you decide. */
const SUGGESTION_CONFIDENCE_CAP = 94;

/** Jobs the email can be about: applied before it arrived (with grace), or with no applied date. */
export function jobsForEmail<T extends GuardJob>(
  jobs: readonly T[],
  receivedAt: number,
): T[] {
  return jobs.filter((job) => {
    const applied = job.appliedAt ? Date.parse(job.appliedAt) : Number.NaN;
    return !Number.isFinite(applied) || applied <= receivedAt + APPLIED_GRACE_MS;
  });
}

/** Requisition-like numbers: runs of 5+ digits (348254, R-090603 → 090603, R0000367107). */
function numberTokens(text: string): Set<string> {
  return new Set(text.match(/\d{5,}/g) ?? []);
}

function linksOf(job: GuardJob): string {
  return [job.applicationLink, job.jobUrl, job.jobUrlDirect]
    .filter(Boolean)
    .join(" ");
}

const sameEmployer = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The router's pick, or the one other job at the same company whose link carries a number
 * from the email (the requisition id) when the pick's own link doesn't.
 */
export function preferRequisitionMatch(
  chosenId: string | null,
  emailText: string,
  jobs: readonly GuardJob[],
): string | null {
  if (!chosenId) return null;
  const chosen = jobs.find((job) => job.id === chosenId);
  if (!chosen) return chosenId;
  const tokens = numberTokens(emailText);
  if (tokens.size === 0) return chosenId;
  const carries = (job: GuardJob) =>
    [...numberTokens(linksOf(job))].some((t) => tokens.has(t));
  if (carries(chosen)) return chosenId;
  const others = jobs.filter(
    (job) =>
      job.id !== chosenId &&
      sameEmployer(job.employer, chosen.employer) &&
      carries(job),
  );
  return others.length === 1 ? (others[0]?.id ?? chosenId) : chosenId;
}

const UNFINISHED =
  /\bcomplete your application\b|will not be submitted until|finali[sz]e your application|application is (?:almost|not yet) complete|haven'?t (?:finished|completed) your application/i;

/** Reminders that an application was started but never submitted. */
export function looksUnfinished(text: string): boolean {
  return UNFINISHED.test(text);
}

export function guardRouterResult(
  result: SmartRouterResult,
  context: { emailText: string; jobs: readonly GuardJob[] },
): SmartRouterResult {
  const bestMatchId = preferRequisitionMatch(
    result.bestMatchId,
    context.emailText,
    context.jobs,
  );
  const guarded =
    bestMatchId === result.bestMatchId ? result : { ...result, bestMatchId };
  if (!looksUnfinished(context.emailText)) return guarded;
  return {
    ...guarded,
    isRelevant: true,
    stageTarget: "no_change",
    messageType: "other",
    confidence: Math.min(guarded.confidence, SUGGESTION_CONFIDENCE_CAP),
    reason: `Application not submitted yet: finish it on the company's site. ${guarded.reason}`.trim(),
  };
}
