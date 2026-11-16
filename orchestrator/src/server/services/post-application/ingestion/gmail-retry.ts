/**
 * Fork-only: Gmail answers a burst of requests with 403 rateLimitExceeded (or 429), which
 * dropped messages from a sync. Those are retried after a short wait; anything else is
 * returned as it came. Kept out of gmail-api.ts so upstream changes there merge cleanly.
 */

export interface GmailReply {
  readonly response: Response;
  readonly data: unknown;
}

export const GMAIL_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

/** Google's own words for a failure: the Gmail API's reason, or the token endpoint's error. */
export function googleErrorReason(data: unknown): string | null {
  const error = record(data)?.error;
  if (typeof error === "string") {
    const description = record(data)?.error_description;
    return typeof description === "string" && description
      ? `${error}: ${description}`
      : error;
  }
  const details = record(error);
  if (!details) return null;
  const first = Array.isArray(details.errors) ? record(details.errors[0]) : null;
  const reason = first?.reason ?? details.status ?? details.message;
  return typeof reason === "string" && reason ? reason : null;
}

/** " Google said: …" for an error message, or nothing when Google gave no reason. */
export function googleReasonSuffix(data: unknown): string {
  const reason = googleErrorReason(data);
  return reason ? ` Google said: ${reason}` : "";
}

function retryable(reply: GmailReply): boolean {
  const { status } = reply.response;
  if (status === 429 || status === 503) return true;
  return (
    status === 403 && RATE_LIMIT_REASONS.has(googleErrorReason(reply.data) ?? "")
  );
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withGmailRetry(
  attempt: () => Promise<GmailReply>,
  sleep: (ms: number) => Promise<void> = wait,
  delays: readonly number[] = GMAIL_RETRY_DELAYS_MS,
): Promise<GmailReply> {
  let reply = await attempt();
  for (const delay of delays) {
    if (!retryable(reply)) return reply;
    await sleep(delay);
    reply = await attempt();
  }
  return reply;
}
