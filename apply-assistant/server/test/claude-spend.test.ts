import { describe, expect, it } from "vitest";
import {
  attributeUsage,
  LEAD_WINDOW_MS,
  parseTimestamp,
  runSpend,
  summaryOf,
  type UsageEvent,
} from "../src/usage/claude-spend.js";

const ev = (ts: string, cost: number | null = 0.01, model = "m"): UsageEvent => ({
  jobId: "j",
  ts,
  model,
  cost,
});
const NOW = Date.parse("2026-11-06T00:00:00Z");
// Runs use sqlite's "YYYY-MM-DD HH:MM:SS" (UTC); events use ISO.
const r1 = { id: "r1", startedAt: "2026-11-05 22:50:14", endedAt: "2026-11-05 22:55:00" };
const r2 = { id: "r2", startedAt: "2026-11-05 23:30:00", endedAt: null };
const whose = (events: UsageEvent[], runs = [r1, r2]) =>
  attributeUsage(events, runs, NOW).map((a) => a.runId);

describe("parseTimestamp", () => {
  it("reads both formats as UTC", () => {
    expect(parseTimestamp("2026-11-05 22:50:14")).toBe(Date.parse("2026-11-05T22:50:14Z"));
    expect(parseTimestamp("2026-11-05T22:50:09.307Z")).toBe(Date.parse("2026-11-05T22:50:09.307Z"));
    expect(parseTimestamp("2026-11-05T22:50:09+00:00")).toBe(Date.parse("2026-11-05T22:50:09Z"));
    expect(parseTimestamp("nope")).toBeNaN();
  });
});

describe("attributeUsage", () => {
  it("gives an event inside a run to it, including the last second", () => {
    expect(whose([ev("2026-11-05T22:52:00.000Z"), ev("2026-11-05T22:55:00.800Z")])).toEqual(["r1", "r1"]);
  });
  it("gives planning shortly before a run to that run", () => {
    expect(whose([ev("2026-11-05T22:50:09.307Z")])).toEqual(["r1"]);
  });
  it("leaves an event before the lead window unattributed", () => {
    const early = new Date(parseTimestamp(r1.startedAt) - LEAD_WINDOW_MS - 1000).toISOString();
    expect(whose([ev(early)], [r1])).toEqual([null]);
  });
  it("does not take events that belong after the previous run's end", () => {
    // 23:25 is within 10 minutes of r2 and after r1's end: r2's. 22:56 is neither.
    expect(whose([ev("2026-11-05T23:25:00Z"), ev("2026-11-05T22:56:00Z")])).toEqual(["r2", null]);
  });
  it("does not steal an event from the previous run's tail", () => {
    const close = { id: "r3", startedAt: "2026-11-05 22:56:00", endedAt: null };
    expect(whose([ev("2026-11-05T22:54:00Z")], [r1, close])).toEqual(["r1"]);
  });
  it("counts an open run until now and nothing after the last run's end", () => {
    expect(whose([ev("2026-11-05T23:59:00Z")])).toEqual(["r2"]);
    expect(whose([ev("2026-11-05T23:00:00Z")], [r1])).toEqual([null]);
  });
});

describe("runSpend", () => {
  it("sums priced calls by model and counts unpriced ones", () => {
    const events = [
      ev("2026-11-05T22:50:09Z", 0.0123, "haiku"),
      ev("2026-11-05T22:52:00Z", 0.05, "sonnet"),
      ev("2026-11-05T22:53:00Z", null, "mystery"),
      ev("2026-11-05T23:40:00Z", 1, "sonnet"),
    ];
    const spend = runSpend("r1", events, [r1, r2], NOW);
    expect(spend).toEqual({
      costUsd: 0.0623,
      calls: 3,
      unpriced: 1,
      byModel: [
        { model: "sonnet", costUsd: 0.05, calls: 1 },
        { model: "haiku", costUsd: 0.0123, calls: 1 },
        { model: "mystery", costUsd: 0, calls: 1 },
      ],
    });
  });
});

describe("summaryOf", () => {
  const events = [
    ev("2026-10-20T10:00:00Z", 1, "a"),
    ev("2026-11-01T10:00:00Z", 2, "b"),
    ev("2026-11-06T01:00:00Z", 0.5, "b"),
    ev("2026-11-06T02:00:00Z", null, "b"),
  ];
  const now = Date.parse("2026-11-06T12:00:00Z");
  it("totals by UTC month and day, with the credit estimate", () => {
    const s = summaryOf(events, { amountUsd: 10, asOf: "2026-11-01" }, now);
    expect(s).toMatchObject({
      totalUsd: 3.5,
      monthUsd: 2.5,
      todayUsd: 0.5,
      calls: 4,
      unpriced: 1,
      since: "2026-10-20T10:00:00Z",
      credit: { amountUsd: 10, asOf: "2026-11-01", spentSinceUsd: 2.5, remainingUsd: 7.5 },
    });
    expect(s.byModel).toEqual([
      { model: "b", usd: 2.5, calls: 3 },
      { model: "a", usd: 1, calls: 1 },
    ]);
  });
  it("is empty without events or credit", () => {
    expect(summaryOf([], null, now)).toEqual({
      totalUsd: 0, monthUsd: 0, todayUsd: 0, calls: 0, unpriced: 0, byModel: [], since: null, credit: null,
    });
  });
});
