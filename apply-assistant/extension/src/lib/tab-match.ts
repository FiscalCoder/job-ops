import type { QueueItem } from "./api";

/**
 * Which queued job a tab is the application page of, so the side panel can offer to fill the
 * page you're already on (say LinkedIn's Apply took you there) instead of opening a new tab.
 */

/** Greenhouse serves the same posting on both hosts. */
const SAME_HOST: Record<string, string> = {
  "boards.greenhouse.io": "job-boards.greenhouse.io",
};

/** host + path, lower-cased, without query, fragment or trailing slash. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    return `${SAME_HOST[host] ?? host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether two addresses show the same posting: the same page, or a company careers page with
 * Greenhouse's embed for the same job (Toast sends ".../jobs?gh_jid=1" on to
 * ".../jobs/senior-engineer?gh_jid=1").
 */
export function samePosting(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    const [job, other] = [x, y].map((u) => u.searchParams.get("gh_jid"));
    // One careers page lists many jobs: the gh_jid says which.
    if (job !== null || other !== null)
      return (
        job === other && x.hostname.toLowerCase() === y.hostname.toLowerCase()
      );
  } catch {
    return false;
  }
  const key = pageKey(a);
  return key !== null && key === pageKey(b);
}

/**
 * The queued job whose matched posting this page is: the posting itself or a page under it
 * (Ashby's /application, Lever's /apply).
 */
export function jobForTab(
  url: string | undefined,
  items: readonly QueueItem[],
): QueueItem | null {
  const here = url ? pageKey(url) : null;
  if (!here) return null;
  for (const item of items) {
    if (item.target.status !== "matched" || !item.target.postingUrl) continue;
    const posting = pageKey(item.target.postingUrl);
    if (posting && (here === posting || here.startsWith(`${posting}/`)))
      return item;
  }
  return null;
}
