import { describe, expect, it } from "vitest";
import {
  FAST_POLL_MS,
  getClaudeBadge,
  getPollInterval,
  mentionsDeviceCodeSetting,
  needsAttention,
  SLOW_POLL_MS,
} from "./status-helpers";
import { connectedClaude, makeStatus } from "./subscription-test-fixtures";

const claudeLogin = (status: "awaiting_code" | "submitting" | "failed") => ({
  status,
  signInUrl: null,
  startedAt: "2026-11-27T10:00:00.000Z",
  expiresAt: "2026-11-27T10:10:00.000Z",
  message: null,
});

describe("status helpers", () => {
  it("picks a poll interval from the login state", () => {
    expect(getPollInterval(undefined)).toBe(false);
    expect(getPollInterval(makeStatus())).toBe(false);
    expect(
      getPollInterval(
        makeStatus({
          codex: {
            login: {
              status: "starting",
              verificationUrl: null,
              userCode: null,
              expiresAt: null,
              message: null,
            },
          },
        }),
      ),
    ).toBe(FAST_POLL_MS);
    expect(
      getPollInterval(
        makeStatus({ claude: { login: claudeLogin("submitting") } }),
      ),
    ).toBe(FAST_POLL_MS);
    expect(
      getPollInterval(
        makeStatus({ claude: { login: claudeLogin("awaiting_code") } }),
      ),
    ).toBe(SLOW_POLL_MS);
    expect(
      getPollInterval(makeStatus({ claude: { login: claudeLogin("failed") } })),
    ).toBe(false);
  });

  it("labels Claude states", () => {
    expect(getClaudeBadge(makeStatus().claude)).toEqual({
      label: "Not connected",
      tone: "idle",
    });
    expect(
      getClaudeBadge(makeStatus({ claude: connectedClaude }).claude).label,
    ).toMatch(/^Connected · expires /);
    expect(
      getClaudeBadge(
        makeStatus({ claude: { ...connectedClaude, state: "expiring" } })
          .claude,
      ).label,
    ).toBe("Expiring soon");
  });

  it("flags logins that need attention", () => {
    expect(needsAttention(makeStatus())).toBeNull();
    expect(
      needsAttention(makeStatus({ claude: { state: "expired" } })),
    ).toEqual({ label: "Claude login expired", tone: "error" });
    expect(
      needsAttention(
        makeStatus({ codex: { connected: true, state: "expiring" } }),
      ),
    ).toEqual({ label: "ChatGPT login expiring", tone: "warn" });
  });

  it("spots the device-code setting hint", () => {
    expect(mentionsDeviceCodeSetting("Enable device code login")).toBe(true);
    expect(mentionsDeviceCodeSetting("Network error")).toBe(false);
    expect(mentionsDeviceCodeSetting(null)).toBe(false);
  });
});
