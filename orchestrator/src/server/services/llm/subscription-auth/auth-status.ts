import * as settingsRepo from "@server/repositories/settings";
import { settingsRegistry } from "@shared/settings-registry";
import { resetCodexSession } from "../codex/client";
import {
  type CodexDeviceAuthSnapshot,
  consumeCompletedCodexDeviceAuth,
  getCodexDeviceAuthSnapshot,
} from "../codex/login";
import {
  type ClaudeLoginSnapshot,
  getClaudeLoginSnapshot,
} from "./claude-login";
import type { CliAuthScope } from "./scope";
import {
  type ClaudeConnection,
  type CodexConnection,
  readClaudeConnection,
  readCodexConnection,
} from "./status";

/** Shape returned by every /api/llm-auth endpoint except /claude/test. */
export type CodexLoginView = Readonly<{
  status: "starting" | "running" | "failed";
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  message: string | null;
}>;

export type LlmAuthStatus = Readonly<{
  claude: ClaudeConnection & { login: ClaudeLoginSnapshot | null };
  codex: CodexConnection & { login: CodexLoginView | null };
  subscriptionFallback: { enabled: boolean; available: boolean };
}>;

async function readFallbackEnabled(): Promise<boolean> {
  try {
    const raw = await settingsRepo.getSetting("subscriptionFallback");
    return (
      settingsRegistry.subscriptionFallback.parse(raw ?? undefined) ??
      settingsRegistry.subscriptionFallback.default()
    );
  } catch {
    return settingsRegistry.subscriptionFallback.default();
  }
}

/**
 * The device-code flow finishes in the background; once it reports
 * "completed" the user's app-server is restarted so it picks up auth.json.
 */
async function resolveCodexLogin(
  scope: CliAuthScope,
  override?: CodexDeviceAuthSnapshot,
): Promise<CodexLoginView | null> {
  const snapshot = override ?? getCodexDeviceAuthSnapshot(scope);
  if (snapshot.status === "completed") {
    if (consumeCompletedCodexDeviceAuth(scope)) {
      await resetCodexSession(scope);
    }
    return null;
  }
  if (snapshot.status === "idle") return null;
  return {
    status: snapshot.status,
    verificationUrl: snapshot.verificationUrl,
    userCode: snapshot.userCode,
    expiresAt: snapshot.expiresAt,
    message: snapshot.message,
  };
}

export async function getLlmAuthStatus(
  scope: CliAuthScope,
  overrides: {
    claudeLogin?: ClaudeLoginSnapshot | null;
    codexLogin?: CodexDeviceAuthSnapshot;
  } = {},
): Promise<LlmAuthStatus> {
  const codexLogin = await resolveCodexLogin(scope, overrides.codexLogin);
  const [claude, codex, fallbackEnabled] = await Promise.all([
    readClaudeConnection(scope),
    readCodexConnection(scope),
    readFallbackEnabled(),
  ]);
  const claudeLogin =
    overrides.claudeLogin !== undefined
      ? overrides.claudeLogin
      : getClaudeLoginSnapshot(scope);
  return {
    claude: { ...claude, login: claudeLogin },
    codex: { ...codex, login: codexLogin },
    subscriptionFallback: {
      enabled: fallbackEnabled,
      available: claude.connected && codex.connected,
    },
  };
}
