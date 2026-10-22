import type { CompanyLimit } from "../store/company-limits-repo.js";
import { employerKey } from "./text.js";

/** One of your applications, as Job Ops has it. */
export interface PastApplication {
  readonly jobId: string;
  readonly title: string;
  readonly employer: string;
  readonly appliedAt: string;
}

/** Where you stand with a limited company: what you've used of its window, and when it frees. */
export interface CompanyWindow {
  /** The limit's id (to change or remove it). */
  readonly id: number;
  readonly name: string;
  readonly maxApplications: number;
  readonly windowDays: number;
  readonly note: string;
  /** Your applications there inside the window, most recent first. */
  readonly used: readonly { jobId: string; title: string; appliedAt: string }[];
  /** No application left inside the window. */
  readonly full: boolean;
  /** When the next one frees up (the oldest inside the window ages out), if full. */
  readonly nextOpen: string | null;
}

const DAY_MS = 86_400_000;

/** The limit for an employer: its key starts with the limit's ("Amazon Web Services" → Amazon). */
export function limitFor(
  employer: string,
  limits: readonly CompanyLimit[],
): CompanyLimit | null {
  const key = employerKey(employer);
  if (!key) return null;
  return (
    limits
      .filter((l) => l.companyKey && key.startsWith(l.companyKey))
      .sort((a, b) => b.companyKey.length - a.companyKey.length)[0] ?? null
  );
}

export function companyWindow(
  limit: CompanyLimit,
  applications: readonly PastApplication[],
  now: Date,
): CompanyWindow {
  const since = now.getTime() - limit.windowDays * DAY_MS;
  const used = applications
    .filter((a) => {
      const at = Date.parse(a.appliedAt);
      return (
        Number.isFinite(at) &&
        at >= since &&
        limitFor(a.employer, [limit]) !== null
      );
    })
    .sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt));
  const full = used.length >= limit.maxApplications;
  // Full: the application that frees a place is the one that would leave the window first.
  const freeing = used[limit.maxApplications - 1];
  return {
    id: limit.id,
    name: limit.name,
    maxApplications: limit.maxApplications,
    windowDays: limit.windowDays,
    note: limit.note,
    used: used.map(({ jobId, title, appliedAt }) => ({ jobId, title, appliedAt })),
    full,
    nextOpen:
      full && freeing
        ? new Date(Date.parse(freeing.appliedAt) + limit.windowDays * DAY_MS)
            .toISOString()
            .slice(0, 10)
        : null,
  };
}
