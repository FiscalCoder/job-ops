import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeepSeekBalanceCache,
  getDeepSeekBalance,
} from "./deepseek-balance";

const BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "8.13",
      granted_balance: "1.00",
      topped_up_balance: "7.13",
    },
  ],
};

const base = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-secret",
  cacheKey: "t:u1",
};

describe("getDeepSeekBalance", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearDeepSeekBalanceCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed balance and sends the bearer key", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(BODY)));
    const r = await getDeepSeekBalance(base);
    expect(r.balance).toEqual({
      currency: "USD",
      total: 8.13,
      granted: 1,
      toppedUp: 7.13,
      isAvailable: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-secret" });
  });

  it("returns null with a reason on non-200 without leaking the key", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const r = await getDeepSeekBalance(base);
    expect(r).toEqual({ balance: null, error: "HTTP 401" });
    expect(JSON.stringify(r)).not.toContain("sk-secret");
  });

  it("reports timeouts", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("t"), { name: "TimeoutError" }),
    );
    expect(await getDeepSeekBalance(base)).toEqual({
      balance: null,
      error: "timeout",
    });
  });

  it("rejects bad shapes", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ x: 1 })));
    expect((await getDeepSeekBalance(base)).balance).toBeNull();
  });

  it("skips non-DeepSeek hosts and missing keys without fetching", async () => {
    const other = await getDeepSeekBalance({
      ...base,
      baseUrl: "https://api.openai.com",
    });
    expect(other.balance).toBeNull();
    const noKey = await getDeepSeekBalance({ ...base, apiKey: null });
    expect(noKey.balance).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches per key for 10 minutes", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(BODY)),
    );
    await getDeepSeekBalance({ ...base, now: 1_000 });
    await getDeepSeekBalance({ ...base, now: 1_000 + 9 * 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getDeepSeekBalance({ ...base, cacheKey: "t:u2", now: 2_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await getDeepSeekBalance({ ...base, now: 1_000 + 11 * 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
