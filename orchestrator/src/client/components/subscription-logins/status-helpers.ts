import type {
  ClaudeAuthStatus,
  CodexAuthConnectionStatus,
  LlmAuthStatus,
} from "@client/api/llm-auth";

export const FAST_POLL_MS = 3_000;
export const SLOW_POLL_MS = 30_000;

export type BadgeTone = "ok" | "warn" | "error" | "idle";

export interface StateBadgeView {
  label: string;
  tone: BadgeTone;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, DATE_FORMAT);
}

export function formatDateTime(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    ...DATE_FORMAT,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function getClaudeBadge(claude: ClaudeAuthStatus): StateBadgeView {
  switch (claude.state) {
    case "ok": {
      const expires = formatDate(claude.expiresAt);
      return {
        label: expires ? `Connected · expires ${expires}` : "Connected",
        tone: "ok",
      };
    }
    case "expiring":
      return { label: "Expiring soon", tone: "warn" };
    case "expired":
      return { label: "Expired", tone: "error" };
    default:
      return { label: "Not connected", tone: "idle" };
  }
}

export function getCodexBadge(
  codex: CodexAuthConnectionStatus,
): StateBadgeView {
  switch (codex.state) {
    case "ok":
      return { label: "Connected", tone: "ok" };
    case "expiring":
      return { label: "Expiring soon", tone: "warn" };
    default:
      return { label: "Not connected", tone: "idle" };
  }
}

export function getClaudeSourceLabel(
  source: ClaudeAuthStatus["source"],
): string | null {
  if (source === "setup-token") return "Signed in from Job Ops";
  if (source === "pasted") return "Pasted token";
  return null;
}

export function isCodexLoginActive(codex: CodexAuthConnectionStatus): boolean {
  const status = codex.login?.status;
  return status === "starting" || status === "running";
}

export function isClaudeLoginBusy(claude: ClaudeAuthStatus): boolean {
  const status = claude.login?.status;
  return status === "starting" || status === "submitting";
}

/** Poll quickly while a device-code login is running, slowly while a Claude
 * sign-in waits for its code (so an expired session shows up), else stop. */
export function getPollInterval(
  status: LlmAuthStatus | undefined,
): number | false {
  if (!status) return false;
  if (isCodexLoginActive(status.codex) || isClaudeLoginBusy(status.claude)) {
    return FAST_POLL_MS;
  }
  if (status.claude.login?.status === "awaiting_code") return SLOW_POLL_MS;
  return false;
}

export function needsAttention(status: LlmAuthStatus | undefined): {
  label: string;
  tone: "warn" | "error";
} | null {
  if (!status) return null;
  if (status.claude.state === "expired") {
    return { label: "Claude login expired", tone: "error" };
  }
  if (status.claude.state === "expiring") {
    return { label: "Claude login expiring", tone: "warn" };
  }
  if (status.codex.state === "expiring") {
    return { label: "ChatGPT login expiring", tone: "warn" };
  }
  return null;
}

/** Codex returns a hint when device-code login is turned off in ChatGPT. */
export function mentionsDeviceCodeSetting(
  message: string | null | undefined,
): boolean {
  return Boolean(message && /device[\s-]*code/i.test(message));
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
