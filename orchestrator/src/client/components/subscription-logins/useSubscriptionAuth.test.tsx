import * as authApi from "@client/api/llm-auth";
import { renderHookWithQueryClient } from "@client/test/renderWithQueryClient";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAST_POLL_MS } from "./status-helpers";
import { connectedCodex, makeStatus } from "./subscription-test-fixtures";
import { useSubscriptionAuth } from "./useSubscriptionAuth";

vi.mock("@client/api/llm-auth", () => ({
  getLlmAuthStatus: vi.fn(),
  startClaudeLogin: vi.fn(),
  submitClaudeLoginCode: vi.fn(),
  saveClaudeToken: vi.fn(),
  testClaudeConnection: vi.fn(),
  disconnectClaude: vi.fn(),
  startCodexLogin: vi.fn(),
  disconnectCodex: vi.fn(),
}));

const runningCodex = makeStatus({
  codex: {
    login: {
      status: "running",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: null,
      message: null,
    },
  },
});

const SETTLE_MS = 10;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  // Let the resolved fetch reach the cache and then the rendered hook.
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    });
  }
}

describe("useSubscriptionAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls while ChatGPT sign-in runs and stops once connected", async () => {
    vi.mocked(authApi.getLlmAuthStatus)
      .mockResolvedValueOnce(runningCodex)
      .mockResolvedValueOnce(runningCodex)
      .mockResolvedValue(makeStatus({ codex: connectedCodex }));

    const { result } = renderHookWithQueryClient(() => useSubscriptionAuth());
    await flush();
    expect(result.current.status?.codex.login?.status).toBe("running");

    await flush(FAST_POLL_MS);
    await flush(FAST_POLL_MS);
    expect(result.current.status?.codex.connected).toBe(true);
    const callsWhenConnected = vi.mocked(authApi.getLlmAuthStatus).mock.calls
      .length;

    await flush(FAST_POLL_MS * 5);
    expect(authApi.getLlmAuthStatus).toHaveBeenCalledTimes(callsWhenConnected);
  });

  it("stops polling when ChatGPT sign-in fails", async () => {
    vi.mocked(authApi.getLlmAuthStatus)
      .mockResolvedValueOnce(runningCodex)
      .mockResolvedValue(
        makeStatus({
          codex: {
            login: {
              status: "failed",
              verificationUrl: null,
              userCode: null,
              expiresAt: null,
              message: "Sign-in timed out.",
            },
          },
        }),
      );

    const { result } = renderHookWithQueryClient(() => useSubscriptionAuth());
    await flush();
    await flush(FAST_POLL_MS);
    expect(result.current.status?.codex.login?.status).toBe("failed");

    await flush(FAST_POLL_MS * 5);
    expect(authApi.getLlmAuthStatus).toHaveBeenCalledTimes(2);
  });

  it("does not poll when nothing is in progress", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(makeStatus());
    renderHookWithQueryClient(() => useSubscriptionAuth());
    await flush();
    await flush(FAST_POLL_MS * 5);
    expect(authApi.getLlmAuthStatus).toHaveBeenCalledTimes(1);
  });

  it("starts polling after a ChatGPT sign-in starts", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(runningCodex);
    vi.mocked(authApi.startCodexLogin).mockResolvedValue(runningCodex);
    const initial = makeStatus();
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValueOnce(initial);

    const { result } = renderHookWithQueryClient(() => useSubscriptionAuth());
    await flush();
    await act(async () => {
      await result.current.startCodex();
    });
    expect(result.current.status?.codex.login?.userCode).toBe("ABCD-1234");

    await flush(FAST_POLL_MS);
    expect(authApi.getLlmAuthStatus).toHaveBeenCalledTimes(2);
  });
});
