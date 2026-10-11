/**
 * Decide whether a fetched posting page shows an open or a closed job.
 *
 * Only unambiguous signals count as "closed". Anything that could equally be
 * a bot wall, a rate limit or an outage is "unknown", so a job is never
 * expired on weak evidence.
 *
 * Page bodies are untrusted and up to 1MB, so markup is stripped with linear
 * scans (indexOf) rather than regexes that can backtrack quadratically.
 */

export type LivenessState = "live" | "closed" | "unknown";

export interface LivenessVerdict {
  state: LivenessState;
  reason: string;
  /**
   * Set on "unknown" verdicts where the site answered but will never let us
   * verify the posting (login wall, bot wall, app shell). Only these may fall
   * back to expiring a job by age; outages and rate limits may not.
   */
  unverifiable?: boolean;
}

interface LivenessResponse {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  body: string;
  /** Job title as stored; used to confirm the page really shows this job. */
  expectedTitle?: string | null;
}

const CHALLENGE_MARKERS: readonly string[] = [
  "challenges.cloudflare.com",
  "attention required! | cloudflare",
  "verify you are human",
  "verify that you are human",
  "verify you are a human",
  "unusual traffic from your",
];

const CLOSED_PATTERNS: readonly RegExp[] = [
  /no longer accepting applications/,
  /this job (has expired|is expired|has been removed|was removed)/,
  /this (job|position|role|vacancy|posting|listing|opening) (is|has been) (no longer (available|open|active)|closed|filled|expired|removed|taken down)/,
  /this (job|position|role|vacancy|posting|listing|opening) is no longer (available|open|active|accepting)/,
  /(job|position|role|vacancy) (posting |listing )?(has|have) (expired|been filled|been closed)/,
  /(job|posting|listing|vacancy) (you are looking for )?(is )?no longer (available|exists|active)/,
  /applications? (for this (job|position|role) )?(are|is) (now )?closed/,
];

const CLOSED_TITLE_PATTERN = /\b(expired job|job not found|job expired)\b/;

/** Elements whose content is never shown to a visitor as the posting. */
const HIDDEN_ELEMENTS: readonly string[] = [
  "script",
  "style",
  "template",
  "noscript",
];

const LISTING_PATH_PATTERN =
  /^\/?(jobs?|careers?|search|vacancies|openings|positions|remote-jobs)?\/?$/i;

const EXPIRED_QUERY_PATTERN = /expired|expjd/i;

/** Remove everything between `open` and the next `close`, in one pass. */
function removeSpans(text: string, open: string, close: string): string {
  const lowerText = text.toLowerCase();
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = lowerText.indexOf(open, cursor);
    if (start === -1) break;
    const end = lowerText.indexOf(close, start + open.length);
    result += `${text.slice(cursor, start)} `;
    // An unterminated span (e.g. a truncated body) hides the rest of the page.
    if (end === -1) return result;
    cursor = end + close.length;
  }
  return result + text.slice(cursor);
}

function removeHiddenContent(body: string): string {
  return HIDDEN_ELEMENTS.reduce(
    (text, element) => removeSpans(text, `<${element}`, `</${element}>`),
    removeSpans(body, "<!--", "-->"),
  );
}

/** Replace tags with spaces, in one pass. */
function removeTags(markup: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < markup.length) {
    const start = markup.indexOf("<", cursor);
    if (start === -1) break;
    const end = markup.indexOf(">", start + 1);
    if (end === -1) break;
    result += `${markup.slice(cursor, start)} `;
    cursor = end + 1;
  }
  return result + markup.slice(cursor);
}

function collapseText(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&(#39|apos|rsquo|lsquo);/gi, "'")
    .replace(/&[a-z0-9#]{1,10};/gi, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function extractTitle(body: string): string {
  const lowerBody = body.toLowerCase();
  const open = lowerBody.indexOf("<title");
  if (open === -1) return "";
  const contentStart = lowerBody.indexOf(">", open);
  if (contentStart === -1) return "";
  const close = lowerBody.indexOf("</title", contentStart);
  if (close === -1) return "";
  return collapseText(body.slice(contentStart + 1, close));
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function sameSite(a: URL, b: URL): boolean {
  const strip = (hostname: string) => hostname.replace(/^www\./i, "");
  return strip(a.hostname) === strip(b.hostname);
}

/**
 * A posting URL that lands on the same site's home or listing page was
 * redirected away because the posting no longer exists.
 */
function redirectedAwayFromPosting(
  requestedUrl: string,
  finalUrl: string,
): boolean {
  const requested = parseUrl(requestedUrl);
  const final = parseUrl(finalUrl);
  if (!requested || !final) return false;
  if (requested.href === final.href) return false;
  if (!sameSite(requested, final)) return false;

  // Greenhouse sends closed postings back to the board with an error flag.
  if (
    final.searchParams.get("error") === "true" &&
    requested.searchParams.get("error") !== "true"
  ) {
    return true;
  }
  // LinkedIn (trk=expired_jd_redirect) and Naukri (expJD=true) say so outright.
  if (
    EXPIRED_QUERY_PATTERN.test(final.search) &&
    !EXPIRED_QUERY_PATTERN.test(requested.search)
  ) {
    return true;
  }

  return (
    !LISTING_PATH_PATTERN.test(requested.pathname) &&
    LISTING_PATH_PATTERN.test(final.pathname)
  );
}

function isChallengePage(body: string, pageTitle: string): boolean {
  if (pageTitle.startsWith("just a moment")) return true;
  const lowerBody = body.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lowerBody.includes(marker));
}

export function classifyLivenessResponse(
  response: LivenessResponse,
): LivenessVerdict {
  const { status, body } = response;
  const pageTitle = extractTitle(body);

  // Checked first: bot walls answer with any status, including 404.
  if (isChallengePage(body, pageTitle)) {
    return {
      state: "unknown",
      reason: "Blocked by a bot challenge",
      unverifiable: true,
    };
  }

  if (status === 404 || status === 410) {
    return { state: "closed", reason: `Posting returned HTTP ${status}` };
  }

  if (status < 200 || status >= 300) {
    return {
      state: "unknown",
      reason: `Posting returned HTTP ${status}`,
      // A login or bot wall is permanent; rate limits and outages are not.
      unverifiable: status === 401 || status === 403,
    };
  }

  if (redirectedAwayFromPosting(response.requestedUrl, response.finalUrl)) {
    return {
      state: "closed",
      reason: "Posting redirects to the site's listing page",
    };
  }

  if (CLOSED_TITLE_PATTERN.test(pageTitle)) {
    return { state: "closed", reason: `Posting page is titled "${pageTitle}"` };
  }

  const visibleText = collapseText(removeTags(removeHiddenContent(body)));
  const closedMatch = CLOSED_PATTERNS.map((pattern) =>
    pattern.exec(visibleText),
  ).find((match) => match !== null);
  if (closedMatch) {
    return {
      state: "closed",
      reason: `Posting page says: "${closedMatch[0].slice(0, 120)}"`,
    };
  }

  const expectedTitle = collapseText(response.expectedTitle ?? "");
  if (
    expectedTitle &&
    !collapseText(removeTags(body)).includes(expectedTitle)
  ) {
    // Typically a single-page-app shell: reachable, but proves nothing.
    return {
      state: "unknown",
      reason: "Posting page is reachable but does not show the job title",
      unverifiable: true,
    };
  }

  return { state: "live", reason: "Posting page is reachable" };
}
