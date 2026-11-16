import { describe, expect, it, vi } from "vitest";
import { googleErrorReason, withGmailRetry } from "./gmail-retry";

const reply = (status: number, data: unknown = null) => ({
  response: { ok: status >= 200 && status < 300, status } as Response,
  data,
});

const rateLimited = reply(403, {
  error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] },
});

describe("googleErrorReason", () => {
  it("reads the Gmail API reason", () => {
    expect(googleErrorReason(rateLimited.data)).toBe("rateLimitExceeded");
  });

  it("reads the OAuth token endpoint error", () => {
    expect(
      googleErrorReason({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
    ).toBe("invalid_grant: Token has been expired or revoked.");
  });

  it("returns null when there is nothing to read", () => {
    expect(googleErrorReason(null)).toBeNull();
    expect(googleErrorReason({})).toBeNull();
  });
});

describe("withGmailRetry", () => {
  const noWait = vi.fn(async () => {});

  it("retries a rate-limited 403 and returns the later success", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(reply(200, { id: "m1" }));
    const result = await withGmailRetry(attempt, noWait);
    expect(result.data).toEqual({ id: "m1" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("retries 429", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(reply(429))
      .mockResolvedValueOnce(reply(200, {}));
    await withGmailRetry(attempt, noWait);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permission 403", async () => {
    const forbidden = reply(403, {
      error: { errors: [{ reason: "insufficientPermissions" }] },
    });
    const attempt = vi.fn().mockResolvedValue(forbidden);
    const result = await withGmailRetry(attempt, noWait);
    expect(result).toBe(forbidden);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("gives up after its last delay and returns the last failure", async () => {
    const attempt = vi.fn().mockResolvedValue(rateLimited);
    const result = await withGmailRetry(attempt, noWait, [1, 2]);
    expect(result).toBe(rateLimited);
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});
