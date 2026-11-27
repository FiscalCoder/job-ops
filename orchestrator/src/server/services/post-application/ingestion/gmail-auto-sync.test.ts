import { getRequestContext } from "@infra/request-context";
import { describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../providers/service", () => ({
  executePostApplicationProviderAction: execute,
}));

import { syncGmailAccounts } from "./gmail-auto-sync";

describe("syncGmailAccounts", () => {
  it("syncs each account in its own scope and keeps going after a failure", async () => {
    const scopes: unknown[] = [];
    execute.mockImplementation(async () => {
      const ctx = getRequestContext();
      scopes.push({ tenantId: ctx?.tenantId, userId: ctx?.userId });
      if (scopes.length === 1) throw new Error("invalid_grant");
      return { status: "completed" };
    });

    await syncGmailAccounts([
      { tenantId: "t1", userId: "u1", accountKey: "default" },
      { tenantId: "t2", userId: null, accountKey: "work" },
    ]);

    expect(scopes).toEqual([
      { tenantId: "t1", userId: "u1" },
      { tenantId: "t2", userId: undefined },
    ]);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "gmail",
        action: "sync",
        accountKey: "work",
        syncPayload: { searchDays: 3 },
      }),
    );
  });
});
