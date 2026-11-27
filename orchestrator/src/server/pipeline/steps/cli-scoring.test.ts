import { LlmNotConfiguredError } from "@server/services/scorer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSubscriptionScoringReady,
  type CliScoringDeps,
  createStartThrottle,
  DEFAULT_SCORING_CONCURRENCY,
  readCliScoringThrottleConfig,
  resolveScoringPlan,
} from "./cli-scoring";

vi.mock("@server/services/scorer", () => ({
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));

const SCOPE = {
  scopeKey: "user-a",
  baseDir: "/s",
  claudeDir: "/s/claude",
  codexHome: "/s/codex",
  homeDir: "/s/home",
  workDir: "/s/work",
};

function makeDeps(overrides: Partial<CliScoringDeps> = {}): CliScoringDeps {
  return {
    resolveScoringProvider: async () => "claude_cli",
    resolveScope: () => SCOPE,
    isConnected: async () => true,
    isFallbackEnabled: async () => true,
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("readCliScoringThrottleConfig", () => {
  it("uses gentle defaults with the batch pause off", () => {
    expect(readCliScoringThrottleConfig({})).toEqual({
      concurrency: 3,
      delayMs: 500,
      batchSize: 0,
      batchPauseMs: 30_000,
    });
  });

  it("reads env overrides", () => {
    expect(
      readCliScoringThrottleConfig({
        JOBOPS_CLI_SCORING_CONCURRENCY: "2",
        JOBOPS_CLI_SCORING_DELAY_MS: "1500",
        JOBOPS_CLI_SCORING_BATCH_SIZE: "20",
        JOBOPS_CLI_SCORING_BATCH_PAUSE_MS: "10000",
      }),
    ).toEqual({
      concurrency: 2,
      delayMs: 1500,
      batchSize: 20,
      batchPauseMs: 10_000,
    });
  });

  it("ignores invalid values", () => {
    expect(
      readCliScoringThrottleConfig({
        JOBOPS_CLI_SCORING_CONCURRENCY: "0",
        JOBOPS_CLI_SCORING_DELAY_MS: "-5",
        JOBOPS_CLI_SCORING_BATCH_SIZE: "abc",
      }),
    ).toMatchObject({ concurrency: 3, delayMs: 500, batchSize: 0 });
  });
});

describe("createStartThrottle", () => {
  it("spaces job starts and never waits before the first", async () => {
    const sleep = vi.fn(async () => undefined);
    const throttle = createStartThrottle(
      { concurrency: 3, delayMs: 500, batchSize: 0, batchPauseMs: 30_000 },
      sleep,
    );
    await Promise.all([throttle(), throttle(), throttle()]);
    expect(sleep.mock.calls).toEqual([[500], [500]]);
  });

  it("adds a batch pause when a batch size is configured", async () => {
    const sleep = vi.fn(async () => undefined);
    const throttle = createStartThrottle(
      { concurrency: 2, delayMs: 100, batchSize: 2, batchPauseMs: 5_000 },
      sleep,
    );
    for (let index = 0; index < 5; index += 1) await throttle();
    expect(sleep.mock.calls).toEqual([[100], [5_000], [100], [5_000]]);
  });

  it("does nothing when the delay is zero", async () => {
    const sleep = vi.fn(async () => undefined);
    const throttle = createStartThrottle(
      { concurrency: 3, delayMs: 0, batchSize: 0, batchPauseMs: 0 },
      sleep,
    );
    await throttle();
    await throttle();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("assertSubscriptionScoringReady", () => {
  it("passes when the scoring subscription is connected", async () => {
    await expect(
      assertSubscriptionScoringReady("claude_cli", makeDeps()),
    ).resolves.toBeUndefined();
  });

  it("pauses with a clear message when the Claude login is missing", async () => {
    const deps = makeDeps({
      isConnected: async () => false,
    });
    const error = await assertSubscriptionScoringReady(
      "claude_cli",
      deps,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmNotConfiguredError);
    expect((error as Error).message).toBe(
      "Your Claude login is missing or expired — connect it in Settings, then Resume.",
    );
  });

  it("names ChatGPT when the Codex login is missing", async () => {
    const deps = makeDeps({ isConnected: async () => false });
    await expect(assertSubscriptionScoringReady("codex", deps)).rejects.toThrow(
      /ChatGPT/,
    );
  });

  it("lets scoring run on the other subscription when fallback is on", async () => {
    const deps = makeDeps({
      isConnected: async (_scope, provider) => provider === "codex",
    });
    await expect(
      assertSubscriptionScoringReady("claude_cli", deps),
    ).resolves.toBeUndefined();
  });

  it("still pauses when fallback is off", async () => {
    const deps = makeDeps({
      isConnected: async (_scope, provider) => provider === "codex",
      isFallbackEnabled: async () => false,
    });
    await expect(
      assertSubscriptionScoringReady("claude_cli", deps),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("pauses when the run has no signed-in user", async () => {
    const deps = makeDeps({
      resolveScope: () => {
        throw new Error("no user");
      },
    });
    await expect(
      assertSubscriptionScoringReady("claude_cli", deps),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("ignores non-subscription providers", async () => {
    const deps = makeDeps({ isConnected: vi.fn(async () => false) });
    await expect(
      assertSubscriptionScoringReady("openai", deps),
    ).resolves.toBeUndefined();
    expect(deps.isConnected).not.toHaveBeenCalled();
  });
});

describe("resolveScoringPlan", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the default concurrency and no throttle for API providers", async () => {
    const deps = makeDeps({ resolveScoringProvider: async () => "openai" });
    const plan = await resolveScoringPlan(deps);
    expect(plan.concurrency).toBe(DEFAULT_SCORING_CONCURRENCY);
    expect(plan.throttled).toBe(false);
    await plan.beforeScore();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("throttles subscription providers and runs the login preflight", async () => {
    vi.stubEnv("JOBOPS_CLI_SCORING_CONCURRENCY", "2");
    const deps = makeDeps({ resolveScoringProvider: async () => "codex" });
    const plan = await resolveScoringPlan(deps);
    expect(plan.concurrency).toBe(2);
    expect(plan.throttled).toBe(true);
    await plan.beforeScore();
    await plan.beforeScore();
    expect(deps.sleep).toHaveBeenCalledWith(500);
  });

  it("surfaces the preflight pause", async () => {
    const deps = makeDeps({ isConnected: async () => false });
    await expect(resolveScoringPlan(deps)).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    );
  });
});
