import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveClaudeToken } from "./claude-token-store";
import type { CliAuthScope } from "./scope";
import {
  classifyClaudeTokenState,
  isSubscriptionConnected,
  readClaudeConnection,
  readCodexConnection,
} from "./status";

const TOKEN = `sk-ant-oat01-${"a".repeat(40)}`;
const NOW = new Date("2026-11-27T12:00:00.000Z");
const DAY = 86_400_000;

function makeScope(root: string, name: string): CliAuthScope {
  const baseDir = join(root, name);
  const scope: CliAuthScope = {
    scopeKey: name,
    baseDir,
    claudeDir: join(baseDir, "claude"),
    codexHome: join(baseDir, "codex"),
    homeDir: join(baseDir, "home"),
    workDir: join(baseDir, "work"),
  };
  for (const dir of [
    scope.claudeDir,
    scope.codexHome,
    scope.homeDir,
    scope.workDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return scope;
}

describe("classifyClaudeTokenState", () => {
  it.each([
    [null, "missing"],
    [new Date(NOW.getTime() + 100 * DAY).toISOString(), "ok"],
    [new Date(NOW.getTime() + 14 * DAY).toISOString(), "expiring"],
    [new Date(NOW.getTime() + 2 * DAY).toISOString(), "expiring"],
    [new Date(NOW.getTime() - 1).toISOString(), "expired"],
  ])("expiresAt %s -> %s", (expiresAt, state) => {
    expect(classifyClaudeTokenState(expiresAt, NOW)).toBe(state);
  });
});

describe("subscription connection status", () => {
  let root: string;
  let scope: CliAuthScope;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llm-auth-status-"));
    vi.stubEnv("DATA_DIR", root);
    scope = makeScope(root, "user-a");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a missing Claude login", async () => {
    await expect(readClaudeConnection(scope, NOW)).resolves.toEqual({
      connected: false,
      source: null,
      createdAt: null,
      expiresAt: null,
      state: "missing",
    });
  });

  it("reports a stored Claude login with metadata only", async () => {
    await saveClaudeToken(scope, TOKEN, { source: "pasted", now: NOW });
    const connection = await readClaudeConnection(scope, NOW);
    expect(connection).toMatchObject({
      connected: true,
      source: "pasted",
      createdAt: NOW.toISOString(),
      state: "ok",
    });
    expect(JSON.stringify(connection)).not.toContain("sk-ant");
  });

  it("reports an expired Claude login as not connected", async () => {
    await saveClaudeToken(scope, TOKEN, {
      source: "pasted",
      now: new Date(NOW.getTime() - 400 * DAY),
    });
    const connection = await readClaudeConnection(scope, NOW);
    expect(connection.state).toBe("expired");
    expect(connection.connected).toBe(false);
  });

  it("reports a missing Codex login", async () => {
    await expect(readCodexConnection(scope, NOW)).resolves.toEqual({
      connected: false,
      state: "missing",
      lastRefreshAt: null,
    });
  });

  it("reads only the refresh time from a fresh Codex auth.json", async () => {
    writeFileSync(
      join(scope.codexHome, "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: "secret-access",
          refresh_token: "secret-refresh",
        },
        last_refresh: new Date(NOW.getTime() - 3 * DAY).toISOString(),
      }),
    );
    const connection = await readCodexConnection(scope, NOW);
    expect(connection).toEqual({
      connected: true,
      state: "ok",
      lastRefreshAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
    });
    expect(JSON.stringify(connection)).not.toContain("secret");
  });

  it("flags a stale Codex login as expiring", async () => {
    writeFileSync(
      join(scope.codexHome, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "a" },
        last_refresh: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      }),
    );
    expect((await readCodexConnection(scope, NOW)).state).toBe("expiring");
  });

  it("flags a Codex login with no refresh time as expiring", async () => {
    writeFileSync(
      join(scope.codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "a" } }),
    );
    const connection = await readCodexConnection(scope, NOW);
    expect(connection.connected).toBe(true);
    expect(connection.state).toBe("expiring");
  });

  it("treats an unreadable auth.json as missing", async () => {
    writeFileSync(join(scope.codexHome, "auth.json"), "not json");
    expect((await readCodexConnection(scope, NOW)).state).toBe("missing");
  });

  it("answers whether each subscription is usable", async () => {
    expect(await isSubscriptionConnected(scope, "claude_cli", NOW)).toBe(false);
    expect(await isSubscriptionConnected(scope, "codex", NOW)).toBe(false);
    await saveClaudeToken(scope, TOKEN, { source: "pasted", now: NOW });
    writeFileSync(
      join(scope.codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "a" } }),
    );
    expect(await isSubscriptionConnected(scope, "claude_cli", NOW)).toBe(true);
    expect(await isSubscriptionConnected(scope, "codex", NOW)).toBe(true);
  });
});
