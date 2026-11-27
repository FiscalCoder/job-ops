import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext } from "@infra/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConfigurationFailure } from "../policies/configuration-error";
import {
  resolveClaudeCliEffort,
  resolveClaudeCliRuntime,
} from "./claude-runtime";
import { saveClaudeToken } from "./claude-token-store";
import { getCliAuthScope } from "./scope";

const { getSettingMock } = vi.hoisted(() => ({ getSettingMock: vi.fn() }));
vi.mock("@server/repositories/settings", () => ({
  getSetting: getSettingMock,
}));

const TOKEN_A = `sk-ant-oat01-${"a".repeat(40)}`;

function inUser<T>(userId: string, fn: () => T): T {
  return runWithRequestContext({ tenantId: "tenant-a", userId }, fn);
}

describe("resolveClaudeCliRuntime", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "claude-runtime-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-server-wide-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "server-api-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("uses only the current user's stored token", async () => {
    const scope = inUser("user-1", () => getCliAuthScope());
    await saveClaudeToken(scope, TOKEN_A, { source: "pasted" });

    const runtime = await inUser("user-1", () => resolveClaudeCliRuntime());

    expect(runtime.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
    expect(runtime.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(runtime.env.CLAUDE_CONFIG_DIR).toBe(scope.claudeDir);
    expect(runtime.cwd).toBe(scope.workDir);
  });

  it("never falls back to another user's or the server's token", async () => {
    const scope = inUser("user-1", () => getCliAuthScope());
    await saveClaudeToken(scope, TOKEN_A, { source: "pasted" });

    const error = await inUser("user-2", () => resolveClaudeCliRuntime()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(isConfigurationFailure((error as Error).message)).toBe(true);
    expect((error as Error).message).toMatch(/Settings → AI provider/);
  });

  it("treats an expired token as a configuration failure", async () => {
    const scope = inUser("user-1", () => getCliAuthScope());
    await saveClaudeToken(scope, TOKEN_A, {
      source: "pasted",
      now: new Date("2020-01-01T00:00:00.000Z"),
    });

    const error = await inUser("user-1", () => resolveClaudeCliRuntime()).catch(
      (caught: unknown) => caught,
    );
    expect(isConfigurationFailure((error as Error).message)).toBe(true);
    expect((error as Error).message).toMatch(/expired/i);
  });
});

describe("resolveClaudeCliEffort", () => {
  afterEach(() => {
    getSettingMock.mockReset();
  });

  it("reads the claudeCliEffort setting", async () => {
    getSettingMock.mockResolvedValue("high");
    await expect(resolveClaudeCliEffort()).resolves.toBe("high");
    expect(getSettingMock).toHaveBeenCalledWith("claudeCliEffort");
  });

  it("defaults to medium when unset or invalid", async () => {
    getSettingMock.mockResolvedValue(null);
    await expect(resolveClaudeCliEffort()).resolves.toBe("medium");
    getSettingMock.mockResolvedValue("extreme");
    await expect(resolveClaudeCliEffort()).resolves.toBe("medium");
  });

  it("defaults to medium when settings cannot be read", async () => {
    getSettingMock.mockRejectedValue(new Error("db down"));
    await expect(resolveClaudeCliEffort()).resolves.toBe("medium");
  });
});
