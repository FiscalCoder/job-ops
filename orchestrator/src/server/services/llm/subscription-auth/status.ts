import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@infra/logger";
import {
  type ClaudeTokenSource,
  readClaudeTokenMetadata,
} from "./claude-token-store";
import type { CliAuthScope } from "./scope";

/**
 * Connection state for the user's subscription logins. Only metadata is read:
 * the Claude token stays sealed, and from Codex's auth.json only the presence
 * of tokens and the `last_refresh` timestamp are looked at.
 */
export type SubscriptionState = "missing" | "ok" | "expiring" | "expired";
export type SubscriptionProvider = "claude_cli" | "codex";

export type ClaudeConnection = Readonly<{
  connected: boolean;
  source: ClaudeTokenSource | null;
  createdAt: string | null;
  expiresAt: string | null;
  state: SubscriptionState;
}>;

export type CodexConnection = Readonly<{
  connected: boolean;
  state: Exclude<SubscriptionState, "expired">;
  lastRefreshAt: string | null;
}>;

const DAY_MS = 86_400_000;
export const CLAUDE_EXPIRING_WINDOW_DAYS = 14;
export const CODEX_STALE_REFRESH_DAYS = 25;
const CODEX_AUTH_FILENAME = "auth.json";

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = [
  "claude_cli",
  "codex",
];

export function isSubscriptionProvider(
  provider: string | null | undefined,
): provider is SubscriptionProvider {
  return provider === "claude_cli" || provider === "codex";
}

export function classifyClaudeTokenState(
  expiresAt: string | null,
  now: Date = new Date(),
): SubscriptionState {
  if (!expiresAt) return "missing";
  const remainingMs = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "expired";
  return remainingMs <= CLAUDE_EXPIRING_WINDOW_DAYS * DAY_MS
    ? "expiring"
    : "ok";
}

export async function readClaudeConnection(
  scope: CliAuthScope,
  now: Date = new Date(),
): Promise<ClaudeConnection> {
  let metadata: Awaited<ReturnType<typeof readClaudeTokenMetadata>> = null;
  try {
    metadata = await readClaudeTokenMetadata(scope);
  } catch (error) {
    logger.warn("Stored Claude login metadata is unreadable", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const state = classifyClaudeTokenState(metadata?.expiresAt ?? null, now);
  return {
    connected: state === "ok" || state === "expiring",
    source: metadata?.source ?? null,
    createdAt: metadata?.createdAt ?? null,
    expiresAt: metadata?.expiresAt ?? null,
    state,
  };
}

type CodexAuthSummary = {
  hasCredentials: boolean;
  lastRefreshAt: string | null;
};

async function readCodexAuthSummary(
  scope: CliAuthScope,
): Promise<CodexAuthSummary | null> {
  let raw: string;
  try {
    raw = await readFile(join(scope.codexHome, CODEX_AUTH_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokens = parsed.tokens;
    const hasTokens =
      typeof tokens === "object" &&
      tokens !== null &&
      Object.keys(tokens).length > 0;
    const hasApiKey =
      typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY !== "";
    const lastRefresh =
      typeof parsed.last_refresh === "string" &&
      Number.isFinite(Date.parse(parsed.last_refresh))
        ? new Date(parsed.last_refresh).toISOString()
        : null;
    return {
      hasCredentials: hasTokens || hasApiKey,
      lastRefreshAt: lastRefresh,
    };
  } catch {
    return null;
  }
}

export async function readCodexConnection(
  scope: CliAuthScope,
  now: Date = new Date(),
): Promise<CodexConnection> {
  const summary = await readCodexAuthSummary(scope);
  if (!summary?.hasCredentials) {
    return { connected: false, state: "missing", lastRefreshAt: null };
  }
  const ageMs = summary.lastRefreshAt
    ? now.getTime() - Date.parse(summary.lastRefreshAt)
    : Number.POSITIVE_INFINITY;
  return {
    connected: true,
    state: ageMs > CODEX_STALE_REFRESH_DAYS * DAY_MS ? "expiring" : "ok",
    lastRefreshAt: summary.lastRefreshAt,
  };
}

/** Whether the user has a usable (present, unexpired) login for `provider`. */
export async function isSubscriptionConnected(
  scope: CliAuthScope,
  provider: SubscriptionProvider,
  now: Date = new Date(),
): Promise<boolean> {
  const connection =
    provider === "claude_cli"
      ? await readClaudeConnection(scope, now)
      : await readCodexConnection(scope, now);
  return connection.connected;
}
