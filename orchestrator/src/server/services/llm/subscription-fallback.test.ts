import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliAuthScope } from "./subscription-auth/scope";
import {
  callJsonWithSubscriptionRecovery,
  type SubscriptionRecoveryDeps,
} from "./subscription-fallback";
import type { LlmRequestOptions, LlmResponse } from "./types";

const SCOPE: CliAuthScope = {
  scopeKey: "user-a",
  baseDir: "/s",
  claudeDir: "/s/claude",
  codexHome: "/s/codex",
  homeDir: "/s/home",
  workDir: "/s/work",
};

const OPTIONS: LlmRequestOptions<{ ok: boolean }> = {
  model: "claude-haiku-5-5",
  messages: [{ role: "user", content: "score" }],
  jsonSchema: {
    name: "t",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  jobId: "job-1",
};

const OK: LlmResponse<{ ok: boolean }> = { success: true, data: { ok: true } };
const LIMIT: LlmResponse<{ ok: boolean }> = {
  success: false,
  error: "Claude AI usage limit reached",
  status: 429,
};
const LOGIN_MISSING: LlmResponse<{ ok: boolean }> = {
  success: false,
  error:
    "Claude subscription is not logged in. Connect your Claude subscription in Settings → AI provider.",
};
const PARSE_FAIL: LlmResponse<{ ok: boolean }> = {
  success: false,
  error: "Unable to parse JSON from model response",
};

function primaryWith(
  provider: string,
  ...results: LlmResponse<{ ok: boolean }>[]
) {
  const callJson = vi.fn();
  for (const result of results) callJson.mockResolvedValueOnce(result);
  return { getProvider: () => provider, callJson };
}

const NOW = Date.UTC(2026, 10, 27, 18, 40);

function makeDeps(overrides: Partial<SubscriptionRecoveryDeps> = {}) {
  const fallbackCall = vi.fn().mockResolvedValue(OK);
  const exhausted = new Map<string, number>();
  const deps: SubscriptionRecoveryDeps = {
    resolveScope: () => SCOPE,
    isConnected: vi.fn(async () => true),
    isFallbackEnabled: vi.fn(async () => true),
    createService: vi.fn(() => ({ callJson: fallbackCall })),
    waitForBackoff: vi.fn(async () => undefined),
    getExhaustedUntil: (key) => {
      const until = exhausted.get(key);
      return until !== undefined && until > NOW ? until : null;
    },
    markExhausted: vi.fn((key: string, until: number) => {
      exhausted.set(key, until);
    }),
    now: () => NOW,
    ...overrides,
  };
  return { deps, fallbackCall, exhausted };
}

describe("usage exhaustion", () => {
  it("marks the subscription out of usage until the stated reset", async () => {
    const primary = primaryWith("claude_cli", LIMIT, {
      ...LIMIT,
      error: "5-hour limit reached ∙ resets 9pm (UTC)",
    });
    const { deps, exhausted } = makeDeps({
      isConnected: vi.fn(async () => false),
    });
    await callJsonWithSubscriptionRecovery(primary, OPTIONS, deps);
    expect(exhausted.get("user-a:claude_cli")).toBe(
      Date.UTC(2026, 10, 27, 21, 0),
    );
  });

  it("assumes a full five-hour window when no reset is stated", async () => {
    const primary = primaryWith("claude_cli", LIMIT, LIMIT);
    const { deps, exhausted } = makeDeps({
      isConnected: vi.fn(async () => false),
    });
    await callJsonWithSubscriptionRecovery(primary, OPTIONS, deps);
    expect(exhausted.get("user-a:claude_cli")).toBe(NOW + 5 * 3_600_000);
  });

  it("skips an exhausted subscription without calling or waiting", async () => {
    const primary = primaryWith("claude_cli", OK);
    const { deps, exhausted, fallbackCall } = makeDeps();
    exhausted.set("user-a:claude_cli", NOW + 3_600_000);
    const result = await callJsonWithSubscriptionRecovery(
      primary,
      OPTIONS,
      deps,
    );
    expect(primary.callJson).not.toHaveBeenCalled();
    expect(deps.waitForBackoff).not.toHaveBeenCalled();
    expect(result).toBe(OK);
    expect(fallbackCall).toHaveBeenCalledTimes(1);
  });

  it("returns a 429 while exhausted when no other subscription is connected", async () => {
    const primary = primaryWith("claude_cli", OK);
    const { deps, exhausted } = makeDeps({
      isConnected: vi.fn(async () => false),
    });
    exhausted.set("user-a:claude_cli", NOW + 3_600_000);
    const result = await callJsonWithSubscriptionRecovery(
      primary,
      OPTIONS,
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.success ? null : result.status).toBe(429);
    expect(primary.callJson).not.toHaveBeenCalled();
  });
});

describe("callJsonWithSubscriptionRecovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes non-subscription providers straight through", async () => {
    const primary = primaryWith("openai", LIMIT);
    const { deps } = makeDeps();
    const result = await callJsonWithSubscriptionRecovery(
      primary,
      OPTIONS,
      deps,
    );
    expect(result).toBe(LIMIT);
    expect(primary.callJson).toHaveBeenCalledTimes(1);
    expect(deps.waitForBackoff).not.toHaveBeenCalled();
  });

  it("returns a successful subscription call untouched", async () => {
    const primary = primaryWith("claude_cli", OK);
    const { deps } = makeDeps();
    await expect(
      callJsonWithSubscriptionRecovery(primary, OPTIONS, deps),
    ).resolves.toBe(OK);
  });

  it("backs off once and retries the same subscription after a usage limit", async () => {
    const primary = primaryWith("claude_cli", LIMIT, OK);
    const { deps } = makeDeps();
    const result = await callJsonWithSubscriptionRecovery(
      primary,
      OPTIONS,
      deps,
    );
    expect(result).toBe(OK);
    expect(deps.waitForBackoff).toHaveBeenCalledWith("user-a:claude_cli");
    expect(primary.callJson).toHaveBeenCalledTimes(2);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("falls back to the user's Codex login after the retry is still limited", async () => {
    const primary = primaryWith("claude_cli", LIMIT, LIMIT);
    const { deps, fallbackCall } = makeDeps();
    const result = await callJsonWithSubscriptionRecovery(
      primary,
      OPTIONS,
      deps,
    );
    expect(result).toBe(OK);
    expect(deps.isConnected).toHaveBeenCalledWith(SCOPE, "codex");
    expect(deps.createService).toHaveBeenCalledWith("codex");
    expect(fallbackCall.mock.calls[0]?.[0].model).toBe("gpt-5.4-mini");
  });

  it("falls back to the user's Claude login when Codex is limited, using Haiku", async () => {
    const primary = primaryWith("codex", LIMIT, LIMIT);
    const { deps, fallbackCall } = makeDeps();
    await callJsonWithSubscriptionRecovery(primary, OPTIONS, deps);
    expect(deps.createService).toHaveBeenCalledWith("claude_cli");
    expect(fallbackCall.mock.calls[0]?.[0].model).toBe("claude-haiku-5-5");
  });

  it("falls back without backing off when the login is missing", async () => {
    const primary = primaryWith("claude_cli", LOGIN_MISSING);
    const { deps } = makeDeps();
    const result = await callJsonWithSubscriptionRecovery(
      primary,
      OPTIONS,
      deps,
    );
    expect(result).toBe(OK);
    expect(deps.waitForBackoff).not.toHaveBeenCalled();
    expect(primary.callJson).toHaveBeenCalledTimes(1);
  });

  it("falls back when the CLI reported an auth failure (status 401)", async () => {
    const primary = primaryWith("claude_cli", {
      success: false,
      error: "some CLI auth message",
      status: 401,
    });
    const { deps } = makeDeps();
    const result = await callJsonWithSubscriptionRecovery(
      primary,
      OPTIONS,
      deps,
    );
    expect(result).toBe(OK);
    expect(deps.waitForBackoff).not.toHaveBeenCalled();
  });

  it("respects a disabled subscriptionFallback setting", async () => {
    const primary = primaryWith("claude_cli", LOGIN_MISSING);
    const { deps } = makeDeps({ isFallbackEnabled: vi.fn(async () => false) });
    await expect(
      callJsonWithSubscriptionRecovery(primary, OPTIONS, deps),
    ).resolves.toBe(LOGIN_MISSING);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("does not fall back when the other subscription is not connected", async () => {
    const primary = primaryWith("claude_cli", LOGIN_MISSING);
    const { deps } = makeDeps({ isConnected: vi.fn(async () => false) });
    await expect(
      callJsonWithSubscriptionRecovery(primary, OPTIONS, deps),
    ).resolves.toBe(LOGIN_MISSING);
  });

  it("returns the primary failure when the fallback also fails", async () => {
    const primary = primaryWith("claude_cli", LOGIN_MISSING);
    const { deps, fallbackCall } = makeDeps();
    fallbackCall.mockResolvedValue(PARSE_FAIL);
    await expect(
      callJsonWithSubscriptionRecovery(primary, OPTIONS, deps),
    ).resolves.toBe(LOGIN_MISSING);
  });

  it("does not fall back for ordinary per-request failures", async () => {
    const primary = primaryWith("claude_cli", PARSE_FAIL);
    const { deps } = makeDeps();
    await expect(
      callJsonWithSubscriptionRecovery(primary, OPTIONS, deps),
    ).resolves.toBe(PARSE_FAIL);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("does nothing extra without a signed-in user scope", async () => {
    const primary = primaryWith("claude_cli", LOGIN_MISSING);
    const { deps } = makeDeps({
      resolveScope: () => {
        throw new Error("no user");
      },
    });
    await expect(
      callJsonWithSubscriptionRecovery(primary, OPTIONS, deps),
    ).resolves.toBe(LOGIN_MISSING);
    expect(deps.createService).not.toHaveBeenCalled();
  });
});
