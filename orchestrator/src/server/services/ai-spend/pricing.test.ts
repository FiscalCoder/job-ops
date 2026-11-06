import { describe, expect, it } from "vitest";
import { computeDeepSeekCost, isDeepSeekPeak } from "./pricing";

const utc = (iso: string): Date => new Date(iso);

describe("isDeepSeekPeak", () => {
  it("honours window boundaries on a weekday (2026-11-04 is Wednesday)", () => {
    expect(isDeepSeekPeak(utc("2026-11-04T00:59:59Z"))).toBe(false);
    expect(isDeepSeekPeak(utc("2026-11-04T01:00:00Z"))).toBe(true);
    expect(isDeepSeekPeak(utc("2026-11-04T03:59:59Z"))).toBe(true);
    expect(isDeepSeekPeak(utc("2026-11-04T04:00:00Z"))).toBe(false);
    expect(isDeepSeekPeak(utc("2026-11-04T05:59:59Z"))).toBe(false);
    expect(isDeepSeekPeak(utc("2026-11-04T06:00:00Z"))).toBe(true);
    expect(isDeepSeekPeak(utc("2026-11-04T09:59:59Z"))).toBe(true);
    expect(isDeepSeekPeak(utc("2026-11-04T10:00:00Z"))).toBe(false);
  });

  it("is never peak on weekends", () => {
    expect(isDeepSeekPeak(utc("2026-11-07T02:00:00Z"))).toBe(false); // Sat
    expect(isDeepSeekPeak(utc("2026-11-08T07:00:00Z"))).toBe(false); // Sun
  });
});

describe("computeDeepSeekCost", () => {
  const usage = {
    promptTokens: 1_000_000,
    cacheHitTokens: 400_000,
    completionTokens: 100_000,
  };

  it("splits cache hit and miss at off-peak flash rates", () => {
    const r = computeDeepSeekCost({
      host: "api.deepseek.com",
      model: "deepseek-flash",
      usage,
      at: utc("2026-11-04T12:00:00Z"),
    });
    // 0.4*0.003 + 0.6*0.15 + 0.1*0.6
    expect(r.peak).toBe(false);
    expect(r.costUsd).toBeCloseTo(0.0012 + 0.09 + 0.06, 8);
  });

  it("uses peak rates and pro pricing", () => {
    const r = computeDeepSeekCost({
      host: "api.deepseek.com",
      model: "deepseek-v4-pro",
      usage,
      at: utc("2026-11-04T07:00:00Z"),
    });
    expect(r.peak).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.4 * 0.044 + 0.6 * 1.32 + 0.1 * 3.96, 8);
  });

  it("treats missing cache info as all miss and legacy names as flash", () => {
    const r = computeDeepSeekCost({
      host: "api.deepseek.com",
      model: "deepseek-v4-flash-0501",
      usage: { ...usage, cacheHitTokens: null },
      at: utc("2026-11-07T07:00:00Z"),
    });
    expect(r.costUsd).toBeCloseTo(0.15 + 0.06, 8);
  });

  it("returns null cost for unknown model or other host", () => {
    const at = utc("2026-11-04T12:00:00Z");
    expect(
      computeDeepSeekCost({
        host: "api.deepseek.com",
        model: "mystery",
        usage,
        at,
      }).costUsd,
    ).toBeNull();
    expect(
      computeDeepSeekCost({
        host: "api.openai.com",
        model: "deepseek-flash",
        usage,
        at,
      }).costUsd,
    ).toBeNull();
  });
});
