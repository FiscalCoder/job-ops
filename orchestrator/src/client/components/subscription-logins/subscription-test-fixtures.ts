import type { AuthUser } from "@client/api/auth";
import type {
  ClaudeAuthStatus,
  CodexAuthConnectionStatus,
  LlmAuthStatus,
} from "@client/api/llm-auth";
import type { JobOpsAppStatusResponse } from "@shared/types";

export const localAppStatus: JobOpsAppStatusResponse = {
  appMode: "local",
  capabilities: {
    hostedSignups: false,
    platformLlm: false,
    quotas: false,
    userEditableLlmSettings: true,
  },
  hostedTenantConfigured: false,
};

export const signedInUser: AuthUser = {
  id: "user-2",
  username: "member",
  displayName: null,
  isSystemAdmin: false,
  isDisabled: false,
  hasPassword: true,
  workspaceId: "tenant_default",
  workspaceName: "JobOps",
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

const missingClaude: ClaudeAuthStatus = {
  connected: false,
  source: null,
  createdAt: null,
  expiresAt: null,
  state: "missing",
  login: null,
};

const missingCodex: CodexAuthConnectionStatus = {
  connected: false,
  state: "missing",
  lastRefreshAt: null,
  login: null,
};

export function makeStatus(
  overrides: {
    claude?: Partial<ClaudeAuthStatus>;
    codex?: Partial<CodexAuthConnectionStatus>;
    fallbackEnabled?: boolean;
  } = {},
): LlmAuthStatus {
  const claude = { ...missingClaude, ...overrides.claude };
  const codex = { ...missingCodex, ...overrides.codex };
  return {
    claude,
    codex,
    subscriptionFallback: {
      enabled: overrides.fallbackEnabled ?? true,
      available: claude.connected && codex.connected,
    },
  };
}

export const connectedClaude: Partial<ClaudeAuthStatus> = {
  connected: true,
  source: "setup-token",
  createdAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2027-11-01T00:00:00.000Z",
  state: "ok",
};

export const connectedCodex: Partial<CodexAuthConnectionStatus> = {
  connected: true,
  state: "ok",
  lastRefreshAt: "2026-11-20T10:00:00.000Z",
};
