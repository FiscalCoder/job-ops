import { fetchApi } from "./core";

/**
 * Fork: per-user subscription logins (Claude subscription via Claude Code,
 * ChatGPT via Codex). Every route acts on the signed-in caller only.
 * Tokens and sign-in codes are sent once and never read back.
 */

export type ClaudeConnectionState = "missing" | "ok" | "expiring" | "expired";
export type CodexConnectionState = "missing" | "ok" | "expiring";

export interface ClaudeLoginView {
  status: "starting" | "awaiting_code" | "submitting" | "failed" | "expired";
  signInUrl: string | null;
  startedAt: string;
  expiresAt: string;
  message: string | null;
}

export interface CodexLoginView {
  status: "starting" | "running" | "failed";
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  message: string | null;
}

export interface ClaudeAuthStatus {
  connected: boolean;
  source: "setup-token" | "pasted" | null;
  createdAt: string | null;
  expiresAt: string | null;
  state: ClaudeConnectionState;
  login: ClaudeLoginView | null;
}

export interface CodexAuthConnectionStatus {
  connected: boolean;
  state: CodexConnectionState;
  lastRefreshAt: string | null;
  login: CodexLoginView | null;
}

export interface LlmAuthStatus {
  claude: ClaudeAuthStatus;
  codex: CodexAuthConnectionStatus;
  subscriptionFallback: { enabled: boolean; available: boolean };
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/** /claude/code may attach the result of a first real call. */
export interface ClaudeCodeSubmitResult extends LlmAuthStatus {
  verification?: ConnectionTestResult;
}

const BASE = "/llm-auth";

function post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  return fetchApi<T>(`${BASE}${path}`, {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export function getLlmAuthStatus(): Promise<LlmAuthStatus> {
  return fetchApi<LlmAuthStatus>(`${BASE}/status`);
}

export function startClaudeLogin(): Promise<LlmAuthStatus> {
  return post<LlmAuthStatus>("/claude/start");
}

export function submitClaudeLoginCode(
  code: string,
): Promise<ClaudeCodeSubmitResult> {
  return post<ClaudeCodeSubmitResult>("/claude/code", { code });
}

export function saveClaudeToken(token: string): Promise<LlmAuthStatus> {
  return post<LlmAuthStatus>("/claude/token", { token });
}

export function testClaudeConnection(): Promise<ConnectionTestResult> {
  return post<ConnectionTestResult>("/claude/test");
}

export function disconnectClaude(): Promise<LlmAuthStatus> {
  return post<LlmAuthStatus>("/claude/disconnect");
}

export function startCodexLogin(input?: {
  forceRestart?: boolean;
}): Promise<LlmAuthStatus> {
  return post<LlmAuthStatus>("/codex/start", {
    forceRestart: input?.forceRestart ?? false,
  });
}

export function disconnectCodex(): Promise<LlmAuthStatus> {
  return post<LlmAuthStatus>("/codex/disconnect");
}
