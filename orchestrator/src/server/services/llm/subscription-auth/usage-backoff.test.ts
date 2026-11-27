import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetUsageBackoffForTests,
  __usageBackoffSizeForTests,
  getUsageBackoffMs,
  waitForUsageBackoff,
} from "./usage-backoff";

describe("usage limit backoff", () => {
  afterEach(() => {
    __resetUsageBackoffForTests();
    vi.unstubAllEnvs();
  });

  it("defaults to 60 seconds and reads the env override", () => {
    expect(getUsageBackoffMs()).toBe(60_000);
    vi.stubEnv("JOBOPS_CLI_USAGE_LIMIT_BACKOFF_MS", "1500");
    expect(getUsageBackoffMs()).toBe(1500);
    vi.stubEnv("JOBOPS_CLI_USAGE_LIMIT_BACKOFF_MS", "nope");
    expect(getUsageBackoffMs()).toBe(60_000);
  });

  it("shares one backoff window between concurrent calls for the same key", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const deps = { now: () => now, sleep, backoffMs: 60_000 };

    const first = waitForUsageBackoff("user-a:claude_cli", deps);
    const second = waitForUsageBackoff("user-a:claude_cli", deps);
    await Promise.all([first, second]);

    expect(sleep).toHaveBeenNthCalledWith(1, 60_000);
    // The second caller only waits for whatever is left of the same window.
    expect(sleep.mock.calls[1]?.[0]).toBeLessThanOrEqual(60_000);
  });

  it("keeps keys independent", async () => {
    const sleep = vi.fn(async () => undefined);
    const deps = { now: () => 0, sleep, backoffMs: 10 };
    await waitForUsageBackoff("user-a:claude_cli", deps);
    await waitForUsageBackoff("user-b:claude_cli", deps);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(2, 10);
  });

  it("starts a new window once the old one has passed", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const deps = { now: () => now, sleep, backoffMs: 100 };
    await waitForUsageBackoff("k", deps);
    now += 1_000;
    await waitForUsageBackoff("k", deps);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it("prunes windows that have already passed", async () => {
    let now = 0;
    const sleep = vi.fn(async () => undefined);
    const deps = { now: () => now, sleep, backoffMs: 100 };
    await waitForUsageBackoff("old-a", deps);
    await waitForUsageBackoff("old-b", deps);
    now = 10_000;
    await waitForUsageBackoff("fresh", deps);
    expect(__usageBackoffSizeForTests()).toBe(1);
  });
});
