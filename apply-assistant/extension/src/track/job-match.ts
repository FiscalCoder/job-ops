import { linkedInJobIdOf } from "../capture/tracker";
import type { QueueItem } from "../lib/api";
import { pageKey, jobForTab as postingFor } from "../lib/tab-match";

/**
 * Which queued job a web address belongs to (APPLY_TRACE_AND_KIT_PLAN.md §T3):
 * - its matched posting, or a page under it ("posting": it can be filled);
 * - its LinkedIn job, on a job page or a search page showing it ("linkedin");
 * - its listing or saved application page, such as a Naukri job ("listing").
 */

/** "tracked": the tab was opened for the job, or from a tab that was. */
export type MatchHow = "posting" | "linkedin" | "listing" | "tracked";

export interface JobMatch {
  readonly item: QueueItem;
  readonly how: MatchHow;
}

export function jobForAddress(
  url: string,
  items: readonly QueueItem[],
): JobMatch | null {
  const posting = postingFor(url, items);
  if (posting) return { item: posting, how: "posting" };

  const linkedIn = linkedInJobIdOf(url);
  if (linkedIn) {
    const item = items.find(
      (i) =>
        (i.jobUrl && linkedInJobIdOf(i.jobUrl) === linkedIn) ||
        (i.applicationLink && linkedInJobIdOf(i.applicationLink) === linkedIn),
    );
    return item ? { item, how: "linkedin" } : null;
  }

  const here = pageKey(url);
  if (!here) return null;
  const item = items.find(
    (i) =>
      (i.jobUrl && pageKey(i.jobUrl) === here) ||
      (i.applicationLink && pageKey(i.applicationLink) === here),
  );
  return item ? { item, how: "listing" } : null;
}

/** Pages worth remembering a tab's address for: job listings and application systems. */
const JOB_PAGE =
  /(^|\.)(linkedin\.com\/jobs|naukri\.com\/job-listings|greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|icims\.com|taleo\.net|successfactors\.(com|eu)|workable\.com|jobvite\.com|bamboohr\.com|recruitee\.com|personio\.(de|com)|teamtailor\.com)/i;

export function isJobPage(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      /^https?:$/.test(u.protocol) &&
      JOB_PAGE.test(`${u.hostname}${u.pathname}`)
    );
  } catch {
    return false;
  }
}

/** A confirmation page after you submitted (URL or page text). */
export const CONFIRMATION_TEXT =
  /thank you for (applying|your application|your interest)|thanks for applying|application (has been |was )?(successfully )?(submitted|received|sent)|we('ve| have) received your application|your application is (in|complete)/i;
export const CONFIRMATION_PATH =
  /\/(confirmation|thank-?you|thanks|application-submitted|submitted|success)(\/|$|\?)/i;
