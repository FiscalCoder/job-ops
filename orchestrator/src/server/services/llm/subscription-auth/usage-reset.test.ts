import { afterEach, describe, expect, it } from "vitest";
import {
  __resetUsageBackoffForTests,
  getUsageExhaustedUntil,
  markUsageExhausted,
  parseUsageResetAt,
} from "./usage-backoff";

const NOW = Date.UTC(2026, 10, 27, 18, 40); // 18:40 UTC

describe("parseUsageResetAt", () => {
  it("reads the legacy epoch suffix", () => {
    const at = Math.floor((NOW + 2 * 3_600_000) / 1000);
    expect(parseUsageResetAt(`Claude AI usage limit reached|${at}`, NOW)).toBe(
      at * 1000,
    );
  });

  it("reads a UTC clock time later today", () => {
    expect(
      parseUsageResetAt("5-hour limit reached ∙ resets 9pm (UTC)", NOW),
    ).toBe(Date.UTC(2026, 10, 27, 21, 0));
  });

  it("rolls a clock time that has passed over to tomorrow", () => {
    expect(parseUsageResetAt("You've hit your limit · resets 3am", NOW)).toBe(
      Date.UTC(2026, 10, 28, 3, 0),
    );
  });

  it("converts a named time zone", () => {
    // 2:30am in India (UTC+5:30) is 21:00 UTC.
    expect(
      parseUsageResetAt(
        "You've hit your limit · resets 2:30am (Asia/Kolkata)",
        NOW,
      ),
    ).toBe(Date.UTC(2026, 10, 27, 21, 0));
  });

  it("reads relative waits", () => {
    expect(
      parseUsageResetAt("usage limit reached, try again in 2h 5m", NOW),
    ).toBe(NOW + 2 * 3_600_000 + 5 * 60_000);
    expect(parseUsageResetAt("resets in 45 minutes", NOW)).toBe(
      NOW + 45 * 60_000,
    );
  });

  it.each([
    ["Claude AI usage limit reached"],
    ["resets 3am (Not/AZone)"],
    [`limit reached|${Math.floor(NOW / 1000) - 60}`],
  ])("returns null when no usable reset is stated %#", (text) => {
    expect(parseUsageResetAt(text, NOW)).toBeNull();
  });
});

describe("usage exhaustion", () => {
  afterEach(() => __resetUsageBackoffForTests());

  it("reports a scope as exhausted until the reset, then clears it", () => {
    markUsageExhausted("user-a:claude_cli", NOW + 60_000);
    expect(getUsageExhaustedUntil("user-a:claude_cli", NOW)).toBe(NOW + 60_000);
    expect(getUsageExhaustedUntil("user-b:claude_cli", NOW)).toBeNull();
    expect(
      getUsageExhaustedUntil("user-a:claude_cli", NOW + 60_001),
    ).toBeNull();
  });

  it("keeps the later of two resets", () => {
    markUsageExhausted("k", NOW + 120_000);
    markUsageExhausted("k", NOW + 60_000);
    expect(getUsageExhaustedUntil("k", NOW)).toBe(NOW + 120_000);
  });
});
