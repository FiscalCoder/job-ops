import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClaudeSummary } from "./claude-summary";

const DATA = {
  totalUsd: 5.58,
  monthUsd: 5.58,
  todayUsd: 1,
  calls: 10,
  unpriced: 0,
  byModel: [{ model: "claude-sonnet", usd: 5.58, calls: 10 }],
  since: "2026-11-01",
  credit: {
    amountUsd: 20,
    asOf: "2026-11-01",
    spentSinceUsd: 5.58,
    remainingUsd: 14.42,
  },
};

describe("fetchClaudeSummary", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.APPLY_ASSISTANT_URL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APPLY_ASSISTANT_URL;
  });

  it("forwards Authorization to the default URL and returns data", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: DATA })),
    );
    expect(await fetchClaudeSummary("Bearer tok")).toEqual(DATA);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://apply-assistant:3006/usage/claude/summary");
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("honours APPLY_ASSISTANT_URL and accepts null credit", async () => {
    process.env.APPLY_ASSISTANT_URL = "http://localhost:9/";
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { ...DATA, credit: null } }),
      ),
    );
    expect((await fetchClaudeSummary(undefined))?.credit).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:9/usage/claude/summary",
    );
  });

  it("returns null on bad shape, non-200, and network errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: {} })),
    );
    expect(await fetchClaudeSummary("Bearer t")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect(await fetchClaudeSummary("Bearer t")).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await fetchClaudeSummary("Bearer t")).toBeNull();
  });
});
