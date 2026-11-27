import { logger } from "@infra/logger";
import * as settingsRepo from "@server/repositories/settings";
import {
  type ClaudeCliEffort,
  DEFAULT_CLAUDE_CLI_EFFORT,
  parseClaudeCliEffortOrNull,
} from "@shared/settings-registry";
import { loadClaudeToken } from "./claude-token-store";
import { buildCliEnv, type CliAuthScope, getCliAuthScope } from "./scope";

export const CLAUDE_LOGIN_REQUIRED_MESSAGE =
  "Claude subscription is not logged in. Connect your Claude subscription in Settings → AI provider.";

export type ClaudeCliRuntime = Readonly<{
  env: NodeJS.ProcessEnv;
  cwd: string;
}>;

function buildExpiredMessage(expiresAt: string): string {
  return `Claude login expired on ${expiresAt.slice(0, 10)}. Reconnect your Claude subscription in Settings → AI provider.`;
}

/**
 * Env + working dir for one `claude -p` call, using ONLY the current user's
 * stored subscription token. Missing or expired logins throw messages that
 * `isConfigurationFailure` recognises, so scoring pauses for the user.
 */
export async function resolveClaudeCliRuntimeForScope(
  scope: CliAuthScope,
): Promise<ClaudeCliRuntime> {
  const stored = await loadClaudeToken(scope);
  if (!stored) throw new Error(CLAUDE_LOGIN_REQUIRED_MESSAGE);
  if (Date.parse(stored.metadata.expiresAt) <= Date.now()) {
    throw new Error(buildExpiredMessage(stored.metadata.expiresAt));
  }
  return {
    env: buildCliEnv(scope, { CLAUDE_CODE_OAUTH_TOKEN: stored.token }),
    cwd: scope.workDir,
  };
}

export async function resolveClaudeCliRuntime(): Promise<ClaudeCliRuntime> {
  return await resolveClaudeCliRuntimeForScope(getCliAuthScope());
}

export async function resolveClaudeCliEffort(): Promise<ClaudeCliEffort> {
  try {
    const raw = await settingsRepo.getSetting("claudeCliEffort");
    return parseClaudeCliEffortOrNull(raw) ?? DEFAULT_CLAUDE_CLI_EFFORT;
  } catch (error) {
    logger.warn("Could not read claudeCliEffort; using default", {
      message: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_CLAUDE_CLI_EFFORT;
  }
}
