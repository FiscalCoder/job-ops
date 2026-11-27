import { describe, expect, it } from "vitest";
import { createScopeRateLimiter, createTestRunGuard } from "./llm-auth-guards";

describe("createScopeRateLimiter", () => {
  it("allows up to the limit per window, per scope", () => {
    let now = 0;
    const limiter = createScopeRateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => now,
    });
    expect(limiter.hit("a")).toBeNull();
    expect(limiter.hit("a")).toBeNull();
    expect(limiter.hit("a")).toBe(60_000);
    expect(limiter.hit("b")).toBeNull();
    now = 30_000;
    expect(limiter.hit("a")).toBe(30_000);
    now = 60_000;
    expect(limiter.hit("a")).toBeNull();
  });

  it("prunes expired windows", () => {
    let now = 0;
    const limiter = createScopeRateLimiter({
      limit: 1,
      windowMs: 1_000,
      now: () => now,
    });
    limiter.hit("a");
    limiter.hit("b");
    now = 5_000;
    limiter.hit("c");
    expect(limiter.size()).toBe(1);
  });
});

describe("createTestRunGuard", () => {
  it("rejects a concurrent run, then enforces a cooldown", () => {
    let now = 0;
    const guard = createTestRunGuard({ cooldownMs: 30_000, now: () => now });

    const first = guard.begin("a");
    expect(first.ok).toBe(true);
    expect(guard.begin("a")).toEqual({ ok: false, reason: "in_flight" });
    expect(guard.begin("b").ok).toBe(true);

    if (first.ok) first.release();
    now = 10_000;
    expect(guard.begin("a")).toEqual({
      ok: false,
      reason: "cooldown",
      retryAfterMs: 20_000,
    });
    now = 30_000;
    expect(guard.begin("a").ok).toBe(true);
  });
});
