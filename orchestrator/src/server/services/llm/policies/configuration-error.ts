/**
 * Subscription CLI (Claude Code) messages meaning the stored login is gone,
 * expired or revoked. Re-running the call cannot fix these; the user has to
 * reconnect in Settings. Anchored to the CLI's own phrases: generic markers
 * such as "API Error: 401" / "authentication_error" are only trusted when the
 * Claude CLI client classified them from its error field (status 401, with a
 * "login expired" message).
 */
const SUBSCRIPTION_LOGIN_FAILURE_PATTERNS: readonly RegExp[] = [
  /\blogin expired\b/i,
  /login reached its time limit/i,
  /please run \/login/i,
  /oauth token (has expired|revoked|was revoked)/i,
  /invalid (bearer|oauth) token/i,
];

/**
 * Failures that mean the LLM integration itself is misconfigured: a missing
 * API key, credentials the provider rejects, or a CLI provider that is not
 * logged in. These are the only failures worth pausing a run over and sending
 * the user to Settings → Integrations; every other failure is a per-request
 * fault (provider blip, malformed completion, rate limit) that changing
 * settings cannot fix.
 */
export function isConfigurationFailure(message: string): boolean {
  return (
    message.includes("not configured") ||
    /LLM API error: 40[13]\b/.test(message) ||
    /not (authenticated|logged in)/i.test(message) ||
    SUBSCRIPTION_LOGIN_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
  );
}
