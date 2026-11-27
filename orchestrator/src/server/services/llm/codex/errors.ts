/**
 * Fork: Codex failure with an HTTP-like status so subscription fallback can
 * see ChatGPT plan usage limits. Classification only ever looks at the Codex
 * app-server's own error fields (a failed turn's `error`, a JSON-RPC error
 * response), never at model output.
 */
export class CodexCliError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CodexCliError";
    this.status = status;
  }
}

const CODEX_USAGE_LIMIT_PATTERN =
  /(you'?ve hit your usage limit|usage_limit_reached|usage_limit_exceeded|usageLimitExceeded|usage limit (reached|exceeded))/i;

export function isCodexUsageLimit(
  message: string,
  errorInfo?: unknown,
): boolean {
  const info = typeof errorInfo === "string" ? errorInfo : "";
  return (
    CODEX_USAGE_LIMIT_PATTERN.test(message) ||
    CODEX_USAGE_LIMIT_PATTERN.test(info)
  );
}

/** Build an error from a Codex app-server error field. */
export function codexErrorFromCli(
  message: string,
  errorInfo?: unknown,
): CodexCliError {
  return new CodexCliError(
    message,
    isCodexUsageLimit(message, errorInfo) ? 429 : undefined,
  );
}
