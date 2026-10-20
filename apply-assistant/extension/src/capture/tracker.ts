import { linkedInJobIdOf } from "../../../server/src/capture/linkedin";

/**
 * Follows the tab that opens when you click Apply on a LinkedIn job, using only the addresses
 * the tabs navigate to (webNavigation). Nothing reads or changes LinkedIn's pages. Pure, so the
 * background script only wires browser events to it.
 */

export { linkedInJobIdOf };

export interface PendingCapture {
  readonly linkedinJobId: string;
  /** First company address the new tab reached (LinkedIn's redirect decoded). */
  readonly first: string | null;
  /** Latest company address, where the tab settled. */
  readonly last: string | null;
}

export interface CaptureReport {
  readonly linkedinJobId: string;
  readonly applyUrl: string;
  readonly finalUrl: string | null;
}

const isLinkedIn = (host: string) => /(^|\.)linkedin\.com$/i.test(host);

/**
 * The company address a navigation leads to: LinkedIn's externalApply / redirect links are
 * decoded, other LinkedIn pages give null, and any other web address is returned as-is.
 */
export function companyTargetOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!isLinkedIn(parsed.hostname)) return url;
  const inner = parsed.searchParams.get("url");
  if (!inner) return null;
  try {
    const target = new URL(inner);
    return /^https?:$/.test(target.protocol) && !isLinkedIn(target.hostname)
      ? target.toString()
      : null;
  } catch {
    return null;
  }
}

/** A new tab opened from a LinkedIn tab (or LinkedIn's externalApply link): start following it. */
export function startCapture(
  openedUrl: string,
  sourceJobId: string | null,
): PendingCapture | null {
  const linkedinJobId = linkedInJobIdOf(openedUrl) ?? sourceJobId;
  if (!linkedinJobId) return null;
  const target = companyTargetOf(openedUrl);
  return { linkedinJobId, first: target, last: target };
}

/** The followed tab moved on; LinkedIn hops in between are ignored. */
export function followed(pending: PendingCapture, url: string): PendingCapture {
  const target = companyTargetOf(url);
  if (!target) return pending;
  return { ...pending, first: pending.first ?? target, last: target };
}

export function toReport(pending: PendingCapture): CaptureReport | null {
  return pending.first
    ? {
        linkedinJobId: pending.linkedinJobId,
        applyUrl: pending.first,
        finalUrl: pending.last !== pending.first ? pending.last : null,
      }
    : null;
}
