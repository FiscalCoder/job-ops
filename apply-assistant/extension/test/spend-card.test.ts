// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  claudeText,
  createSpendCard,
  deepseekNote,
  deepseekText,
  isLowDeepSeek,
} from "../entrypoints/sidepanel/spend-card";
import type { ApplyClient, ClaudeSummary, DeepSeekSpend } from "../src/lib/api";

const claude: ClaudeSummary = {
  totalUsd: 5.5824,
  monthUsd: 2.5754,
  todayUsd: 0.18,
  calls: 851,
  unpriced: 0,
  byModel: [{ model: "claude-sonnet-5-5", usd: 5.2888, calls: 484 }],
  since: "2026-10-21T20:29:00.171Z",
  credit: null,
};

const deepseek: DeepSeekSpend = {
  trackedUsd: 0.42,
  monthUsd: 0.42,
  todayUsd: 0.1,
  calls: 7,
  since: "2026-11-06T08:00:00.000Z",
  byFeature: [{ feature: "score_result", usd: 0.42, calls: 7 }],
  balance: { currency: "USD", total: 4.74 },
};

const withCredit = (remainingUsd: number): ClaudeSummary => ({
  ...claude,
  credit: { amountUsd: 20, asOf: "2026-11-01", spentSinceUsd: 20 - remainingUsd, remainingUsd },
});

describe("spend text", () => {
  it("shows Claude spend, and what's left once a credit is entered", () => {
    expect(claudeText(claude)).toBe("Claude $5.58 spent");
    expect(claudeText(withCredit(14.42))).toBe("Claude $5.58 spent · ≈$14.42 left");
    expect(claudeText(withCredit(-3))).toBe("Claude $23.00 spent · ≈$0.00 left");
    expect(claudeText(null)).toBe("Claude unavailable");
  });

  it("shows only DeepSeek's balance before any call is tracked", () => {
    expect(deepseekText(deepseek)).toBe("DeepSeek $0.42 spent · $4.74 left");
    const fresh = { ...deepseek, calls: 0, trackedUsd: 0, since: null, byFeature: [] };
    expect(deepseekText(fresh)).toBe("DeepSeek $4.74 left");
    expect(deepseekText({ ...fresh, balance: null })).toBe("DeepSeek no calls tracked yet");
    expect(deepseekNote(fresh)).toContain("from the next scoring run");
    expect(deepseekNote(deepseek)).toContain("since Nov 6");
  });

  it("flags a low DeepSeek balance", () => {
    expect(isLowDeepSeek(deepseek)).toBe(false);
    expect(isLowDeepSeek({ ...deepseek, balance: { currency: "USD", total: 0.5 } })).toBe(true);
    expect(isLowDeepSeek(null)).toBe(false);
  });
});

describe("the AI spend card", () => {
  const api = (over: Partial<Record<"claudeSummary" | "deepseekSpend", () => Promise<unknown>>>) =>
    ({
      claudeSummary: over.claudeSummary ?? (async () => claude),
      deepseekSpend: over.deepseekSpend ?? (async () => deepseek),
    }) as unknown as ApplyClient;

  it("folds to one line and offers to set the credit when none is entered", async () => {
    const onSetCredit = vi.fn();
    const card = createSpendCard(() => api({}), onSetCredit);
    await card.refresh();
    expect(card.element.hidden).toBe(false);
    expect(card.element.querySelector("summary")?.textContent).toBe(
      "AI spendClaude $5.58 spentDeepSeek $0.42 spent · $4.74 left",
    );
    const rows = [...card.element.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(rows).toContain("sonnet-5-5");
    expect(rows).toContain("score_result");
    const button = [...card.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Set your Claude credit",
    );
    button?.click();
    expect(onSetCredit).toHaveBeenCalledOnce();
  });

  it("marks a low side amber and keeps the other when one side fails", async () => {
    const card = createSpendCard(
      () => api({ claudeSummary: async () => withCredit(1), deepseekSpend: () => Promise.reject(new Error("x")) }),
      () => {},
    );
    await card.refresh();
    const [claudeLine, deepseekLine] = card.element.querySelectorAll(".spend-line span");
    expect(claudeLine?.className).toBe("low");
    expect(deepseekLine?.textContent).toBe("DeepSeek unavailable");
    expect(card.element.querySelector("summary")?.title).toBe("Running low on credit");
    expect(card.element.textContent).not.toContain("Set your Claude credit");
  });

  it("treats an answer of the wrong shape as unavailable", async () => {
    const card = createSpendCard(
      () => api({ claudeSummary: async () => ({ ok: true }), deepseekSpend: async () => ({}) }),
      () => {},
    );
    await card.refresh();
    expect(card.element.hidden).toBe(true);
  });

  it("stays hidden when neither side answers, or there is no client", async () => {
    const fail = () => Promise.reject(new Error("x"));
    const card = createSpendCard(() => api({ claudeSummary: fail, deepseekSpend: fail }), () => {});
    await card.refresh();
    expect(card.element.hidden).toBe(true);
    const signedOut = createSpendCard(() => null, () => {});
    await signedOut.refresh();
    expect(signedOut.element.hidden).toBe(true);
  });
});
