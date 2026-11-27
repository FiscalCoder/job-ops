import { truncate } from "../utils/string";

/** Claude CLI failure with an HTTP-like status so fallback/retry logic works. */
export class ClaudeCliError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ClaudeCliError";
    this.status = status;
  }
}

/**
 * Real Claude CLI phrases. Only ever matched against text the CLI itself
 * reported as an error (the result envelope's `result` when `is_error`, or
 * process stderr) — never against model output, which can quote job ads.
 */
const USAGE_LIMIT_PATTERN =
  /(Claude AI usage limit reached|you'?ve hit your (usage )?limit|usage limit reached|API Error: 429|rate_limit_error)/i;
const AUTH_FAILURE_PATTERN =
  /(OAuth token has expired|OAuth token revoked|invalid (bearer|oauth) token|Login expired|reached its time limit|please run \/login|not logged in|API Error: 401|authentication_error)/i;

/** Phrase `isConfigurationFailure` recognises, so a run pauses for the user. */
const AUTH_FAILURE_PREFIX =
  "Claude login expired or was rejected — reconnect your Claude subscription in Settings → AI provider.";

export function classifyClaudeCliFailure(
  cliErrorText: string,
): 429 | 401 | undefined {
  if (USAGE_LIMIT_PATTERN.test(cliErrorText)) return 429;
  if (AUTH_FAILURE_PATTERN.test(cliErrorText)) return 401;
  return undefined;
}

/** Build an error from text the CLI reported as its own error. */
export function claudeCliErrorFromCli(cliErrorText: string): ClaudeCliError {
  const status = classifyClaudeCliFailure(cliErrorText);
  if (status === 401) {
    return new ClaudeCliError(
      `${AUTH_FAILURE_PREFIX} (${truncate(cliErrorText, 200)})`,
      401,
    );
  }
  return new ClaudeCliError(cliErrorText, status);
}

/**
 * Wrap any failure. Errors that did not come from `claudeCliErrorFromCli`
 * are never classified: their text may include model output.
 */
export function toClaudeCliError(error: unknown): ClaudeCliError {
  if (error instanceof ClaudeCliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ClaudeCliError(message);
}

export function getLlmErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
