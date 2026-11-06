import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSpendStrip } from "./AiSpendStrip";

const getAiSpend = vi.hoisted(() => vi.fn());
vi.mock("@client/api", () => ({ getAiSpend }));

const deepseek = {
  trackedUsd: 0.42,
  monthUsd: 0.42,
  todayUsd: 0.1,
  calls: 7,
  since: "2026-11-06T08:00:00.000Z",
  byFeature: [{ feature: "score_result", usd: 0.42, calls: 7 }],
  balance: {
    currency: "USD",
    total: 8.13,
    granted: 1,
    toppedUp: 7.13,
    isAvailable: true,
  },
};

const claude = {
  totalUsd: 5.58,
  monthUsd: 5.58,
  todayUsd: 1,
  calls: 3,
  unpriced: 0,
  byModel: [{ model: "claude-sonnet", usd: 5.58, calls: 3 }],
  since: null,
  credit: {
    amountUsd: 20,
    asOf: "2026-11-01",
    spentSinceUsd: 5.58,
    remainingUsd: 14.42,
  },
};

describe("AiSpendStrip", () => {
  beforeEach(() => {
    getAiSpend.mockReset();
  });

  it("shows Claude credit and DeepSeek tracked spend with balance", async () => {
    getAiSpend.mockResolvedValue({ claude, deepseek });
    renderWithQueryClient(<AiSpendStrip />);
    expect(await screen.findByText("$5.58 spent · ≈$14.42 left")).toBeTruthy();
    expect(
      screen.getByText("$0.42 spent since Nov 6 · $8.13 left"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Claude: .*Show details$/ }),
    ).toBeTruthy();
    expect(screen.queryByText(/running low/)).toBeNull();
  });

  it("prompts for credit when unset and omits balance when missing", async () => {
    getAiSpend.mockResolvedValue({
      claude: { ...claude, credit: null },
      deepseek: { ...deepseek, balance: null },
    });
    renderWithQueryClient(<AiSpendStrip />);
    expect(await screen.findByText("$5.58 spent")).toBeTruthy();
    expect(screen.getByText("$0.42 spent since Nov 6")).toBeTruthy();
  });

  it("shows Claude unavailable when the summary is null", async () => {
    getAiSpend.mockResolvedValue({ claude: null, deepseek });
    renderWithQueryClient(<AiSpendStrip />);
    expect(await screen.findByText("unavailable")).toBeTruthy();
  });

  it("flags a chip as running low under the threshold", async () => {
    getAiSpend.mockResolvedValue({
      claude: {
        ...claude,
        credit: { ...claude.credit, spentSinceUsd: 19, remainingUsd: 1 },
      },
      deepseek: { ...deepseek, balance: { ...deepseek.balance, total: 0.5 } },
    });
    renderWithQueryClient(<AiSpendStrip />);
    expect(
      await screen.findByRole("button", { name: /^Claude: .*running low/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^DeepSeek: .*running low/ }),
    ).toBeTruthy();
  });

  it("renders nothing when the request fails", async () => {
    getAiSpend.mockImplementation(() => Promise.reject(new Error("boom")));
    const { queryClient } = renderWithQueryClient(<AiSpendStrip />);
    await waitFor(() =>
      expect(queryClient.getQueryState(["ai-spend"])?.status).toBe("error"),
    );
    expect(screen.queryByTestId("ai-spend-strip")).toBeNull();
  });
});
