import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("llm usage recording", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-ai-spend-"));
    vi.resetModules();
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
      JOBOPS_TEST_AUTH_BYPASS: "0",
      JOBOPS_APP_MODE: "hosted",
      JOBOPS_HOSTED_TENANT_ID: "tenant_default",
    };
    await import("@server/db/migrate");
    ({ closeDb } = await import("@server/db"));
  });

  afterEach(async () => {
    closeDb?.();
    closeDb = null;
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const { runWithRequestContext } = await import("@infra/request-context");
    return runWithRequestContext(
      {
        requestId: `req-${userId}`,
        tenantId: "tenant_default",
        userId,
        username: userId,
      },
      fn,
    );
  }

  const deepseekCall = {
    provider: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    feature: "score_result",
    response: {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_cache_hit_tokens: 400,
        prompt_cache_miss_tokens: 600,
      },
    },
  };
  // 2026-11-04 12:00 UTC is off-peak.
  const perCall = (400 * 0.003 + 600 * 0.15 + 200 * 0.6) / 1e6;

  it("extracts usage shapes and ignores missing usage", async () => {
    const { extractTokenUsage } = await import("./usage-recorder");
    expect(extractTokenUsage(deepseekCall.response)).toEqual({
      promptTokens: 1000,
      cacheHitTokens: 400,
      completionTokens: 200,
    });
    expect(
      extractTokenUsage({ usage: { input_tokens: 5, output_tokens: 7 } }),
    ).toEqual({ promptTokens: 5, cacheHitTokens: null, completionTokens: 7 });
    expect(extractTokenUsage({ choices: [] })).toBeNull();
    expect(extractTokenUsage(null)).toBeNull();
  });

  it("records priced rows per user and summarises only the caller's rows", async () => {
    const { recordLlmUsage } = await import("./usage-recorder");
    const { getDeepSeekTrackedSpend } = await import("./usage-summary");
    const at = new Date("2026-11-04T12:00:00.000Z");

    await asUser("user-a", () => recordLlmUsage(deepseekCall, at));
    await asUser("user-a", () =>
      recordLlmUsage({ ...deepseekCall, feature: "resume_tailoring" }, at),
    );
    await asUser("user-b", () => recordLlmUsage(deepseekCall, at));
    await asUser("user-a", () =>
      recordLlmUsage(
        { ...deepseekCall, baseUrl: "https://api.openai.com" },
        at,
      ),
    );

    const a = await asUser("user-a", () =>
      getDeepSeekTrackedSpend(new Date("2026-11-06T10:00:00.000Z")),
    );
    expect(a.calls).toBe(2);
    expect(a.trackedUsd).toBeCloseTo(perCall * 2, 10);
    expect(a.monthUsd).toBeCloseTo(perCall * 2, 10);
    expect(a.todayUsd).toBe(0);
    expect(a.since).toBe(at.toISOString());
    expect(a.byFeature.map((f) => f.feature).sort()).toEqual([
      "resume_tailoring",
      "score_result",
    ]);

    const b = await asUser("user-b", () => getDeepSeekTrackedSpend(at));
    expect(b.calls).toBe(1);
    expect(b.todayUsd).toBeCloseTo(perCall, 10);
  });

  it("local mode with several signed-in users (the live server): each sees only their own spend", async () => {
    closeDb?.();
    vi.resetModules();
    process.env = { ...process.env, JOBOPS_APP_MODE: "local" };
    await import("@server/db/migrate");
    ({ closeDb } = await import("@server/db"));
    const { recordLlmUsage } = await import("./usage-recorder");
    const { getDeepSeekTrackedSpend } = await import("./usage-summary");
    const at = new Date("2026-11-04T12:00:00.000Z");

    await asUser("user-a", () => recordLlmUsage(deepseekCall, at));
    await asUser("user-b", () => recordLlmUsage(deepseekCall, at));
    await asUser("user-b", () => recordLlmUsage(deepseekCall, at));

    const a = await asUser("user-a", () => getDeepSeekTrackedSpend(at));
    const b = await asUser("user-b", () => getDeepSeekTrackedSpend(at));
    expect(a.calls).toBe(1);
    expect(a.byFeature.reduce((n, f) => n + f.calls, 0)).toBe(1);
    expect(b.calls).toBe(2);
  });

  it("stores null cost for non-DeepSeek hosts and never throws from the safe wrapper", async () => {
    const { recordLlmUsage, recordLlmUsageSafely } = await import(
      "./usage-recorder"
    );
    await asUser("user-a", () =>
      recordLlmUsage({ ...deepseekCall, baseUrl: "https://api.openai.com" }),
    );
    const { db, schema } = await import("@server/db");
    const rows = await db.select().from(schema.llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBeNull();
    expect(rows[0]?.host).toBe("api.openai.com");

    // No request context in hosted mode -> scope throws; must be swallowed.
    expect(() => recordLlmUsageSafely(deepseekCall)).not.toThrow();
  });
});
