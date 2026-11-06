// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  isLowCredit,
  parseCredit,
  spentText,
  todayIso,
} from "../entrypoints/sidepanel/claude-spend-line";
import {
  createRunSpend,
  dollars,
  formatRunCost,
  RUN_COST_POLL_MS,
} from "../entrypoints/sidepanel/run-cost";
import type { ClaudeSummary, RunCost } from "../src/lib/api";

const cost = (costUsd: number, calls = 1, unpriced = 0): RunCost => ({
  runId: "r1",
  jobId: "j",
  costUsd,
  calls,
  unpriced,
  byModel: [],
});

/** A fake clock: ticks run by hand, panel visibility by flag. */
function fakeEnv() {
  let tick: (() => void) | null = null;
  const state = { visible: true, cleared: 0 };
  return {
    state,
    run: () => tick?.(),
    env: {
      setInterval: (fn: () => void, ms: number) => {
        expect(ms).toBe(RUN_COST_POLL_MS);
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        state.cleared += 1;
        tick = null;
      },
      visible: () => state.visible,
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("formatRunCost", () => {
  it("reads like the run card", () => {
    expect(formatRunCost(cost(0.0767, 23))).toBe("Claude: $0.077 · 23 calls");
    expect(formatRunCost(cost(1.234, 1))).toBe("Claude: $1.23 · 1 call");
    expect(formatRunCost(cost(0, 2, 2))).toBe("Claude: $0.000 · 2 calls (2 unpriced)");
    expect(dollars(0.5)).toBe("$0.500");
  });
});

describe("createRunSpend", () => {
  it("polls a live run only while the panel is visible, and once more at the end", async () => {
    const fetchCost = vi.fn(async () => cost(0.05, 3));
    const { env, run, state } = fakeEnv();
    const spend = createRunSpend(fetchCost, env);
    expect(spend.element.hidden).toBe(true);

    spend.track("r1", false);
    spend.track("r1", false); // redraws don't start a second timer
    await flush();
    expect(fetchCost).toHaveBeenCalledTimes(1);
    expect(spend.element.textContent).toBe("Claude: $0.050 · 3 calls");
    expect(spend.element.hidden).toBe(false);

    state.visible = false;
    run();
    await flush();
    expect(fetchCost).toHaveBeenCalledTimes(1);
    state.visible = true;
    run();
    await flush();
    expect(fetchCost).toHaveBeenCalledTimes(2);

    spend.track("r1", true);
    spend.track("r1", true);
    await flush();
    expect(fetchCost).toHaveBeenCalledTimes(3);
    expect(state.cleared).toBeGreaterThan(0);
    run(); // the timer is gone
    await flush();
    expect(fetchCost).toHaveBeenCalledTimes(3);
  });

  it("keeps the last line when a poll fails", async () => {
    const fetchCost = vi
      .fn<(id: string) => Promise<RunCost>>()
      .mockResolvedValueOnce(cost(0.01))
      .mockRejectedValueOnce(new Error("offline"));
    const { env, run } = fakeEnv();
    const spend = createRunSpend(fetchCost, env);
    spend.track("r1", false);
    await flush();
    run();
    await flush();
    expect(spend.element.textContent).toBe("Claude: $0.010 · 1 call");
  });

  it("stop() ends polling", async () => {
    const { env, run } = fakeEnv();
    const fetchCost = vi.fn(async () => cost(0));
    const spend = createRunSpend(fetchCost, env);
    spend.track("r1", false);
    spend.stop();
    run();
    await flush();
    expect(fetchCost).toHaveBeenCalledTimes(1);
  });
});

describe("settings spend line", () => {
  const summary = (credit: ClaudeSummary["credit"]): ClaudeSummary => ({
    totalUsd: 12.3456,
    monthUsd: 4.5,
    todayUsd: 0,
    calls: 10,
    unpriced: 0,
    byModel: [],
    since: null,
    credit,
  });
  it("shows spend and the credit estimate", () => {
    expect(spentText(summary(null))).toBe("Spent: $12.35 total · $4.50 this month");
    expect(
      spentText(summary({ amountUsd: 20, asOf: "2026-11-01", spentSinceUsd: 4.5, remainingUsd: 15.5 })),
    ).toBe("Spent: $12.35 total · $4.50 this month · ≈$15.50 left (estimate)");
    expect(
      spentText(summary({ amountUsd: 1, asOf: "2026-11-01", spentSinceUsd: 4.5, remainingUsd: -3.5 })),
    ).toContain("≈$0.000 left");
  });
  it("flags low credit and starts the date at today", () => {
    expect(isLowCredit(summary(null))).toBe(false);
    expect(
      isLowCredit(summary({ amountUsd: 20, asOf: "2026-11-01", spentSinceUsd: 18.5, remainingUsd: 1.5 })),
    ).toBe(true);
    expect(
      isLowCredit(summary({ amountUsd: 20, asOf: "2026-11-01", spentSinceUsd: 4.5, remainingUsd: 15.5 })),
    ).toBe(false);
    expect(todayIso(new Date(2026, 10, 6, 23, 30))).toBe("2026-11-06");
  });
  it("says so when a run used no Claude", () => {
    expect(formatRunCost(cost(0, 0))).toBe("Claude: not used on this run");
  });
  it("parses the typed credit", () => {
    expect(parseCredit(" 12.5 ")).toBe(12.5);
    expect(parseCredit("0")).toBe(0);
    expect(parseCredit("")).toBeNull();
    expect(parseCredit("-1")).toBeNull();
    expect(parseCredit("abc")).toBeNull();
    expect(parseCredit("100001")).toBeNull();
  });
});
