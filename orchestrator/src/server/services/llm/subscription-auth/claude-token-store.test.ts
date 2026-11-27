import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext } from "@infra/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_TOKEN_LIFETIME_DAYS,
  deleteClaudeToken,
  getClaudeTokenFilePath,
  isValidClaudeOauthToken,
  loadClaudeToken,
  readClaudeTokenMetadata,
  saveClaudeToken,
} from "./claude-token-store";
import { getCliAuthScope } from "./scope";

const TOKEN = `sk-ant-oat01-${"a".repeat(40)}_b-c`;

function scopeFor(userId: string) {
  return runWithRequestContext({ tenantId: "tenant-a", userId }, () =>
    getCliAuthScope(),
  );
}

describe("claude token store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "claude-token-store-"));
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a token with metadata", async () => {
    const scope = scopeFor("user-1");
    const now = new Date("2026-11-27T10:00:00.000Z");

    const metadata = await saveClaudeToken(scope, TOKEN, {
      source: "setup-token",
      now,
    });

    expect(metadata.source).toBe("setup-token");
    expect(metadata.createdAt).toBe(now.toISOString());
    const expectedExpiry = new Date(
      now.getTime() + CLAUDE_TOKEN_LIFETIME_DAYS * 86_400_000,
    ).toISOString();
    expect(metadata.expiresAt).toBe(expectedExpiry);

    const loaded = await loadClaudeToken(scope);
    expect(loaded?.token).toBe(TOKEN);
    expect(loaded?.metadata).toEqual(metadata);
    expect(await readClaudeTokenMetadata(scope)).toEqual(metadata);
  });

  it("removes the temp file when the final rename fails", async () => {
    const scope = scopeFor("user-1");
    const target = getClaudeTokenFilePath(scope);
    mkdirSync(target);
    writeFileSync(join(target, "blocker"), "x");

    await expect(
      saveClaudeToken(scope, TOKEN, { source: "pasted" }),
    ).rejects.toThrow();

    expect(
      readdirSync(scope.baseDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("honours an explicit expiry", async () => {
    const scope = scopeFor("user-1");
    const metadata = await saveClaudeToken(scope, TOKEN, {
      source: "pasted",
      now: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(metadata.expiresAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("never writes the token in plain text", async () => {
    const scope = scopeFor("user-1");
    await saveClaudeToken(scope, TOKEN, { source: "pasted" });
    const raw = readFileSync(getClaudeTokenFilePath(scope), "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("sk-ant-oat");
  });

  it.skipIf(process.platform === "win32")(
    "writes the token file with mode 0600",
    async () => {
      const scope = scopeFor("user-1");
      await saveClaudeToken(scope, TOKEN, { source: "pasted" });
      const mode = statSync(getClaudeTokenFilePath(scope)).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it("keeps users apart", async () => {
    const first = scopeFor("user-1");
    const second = scopeFor("user-2");
    await saveClaudeToken(first, TOKEN, { source: "pasted" });

    expect(await loadClaudeToken(second)).toBeNull();
    expect(await readClaudeTokenMetadata(second)).toBeNull();
  });

  it("cannot decrypt another scope's file copied into place", async () => {
    const first = scopeFor("user-1");
    const second = scopeFor("user-2");
    await saveClaudeToken(first, TOKEN, { source: "pasted" });
    const copied = readFileSync(getClaudeTokenFilePath(first), "utf8");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(getClaudeTokenFilePath(second), copied);

    await expect(loadClaudeToken(second)).rejects.toThrow(
      /could not be decrypted/i,
    );
  });

  it("deletes the token", async () => {
    const scope = scopeFor("user-1");
    await saveClaudeToken(scope, TOKEN, { source: "pasted" });
    await deleteClaudeToken(scope);
    expect(await loadClaudeToken(scope)).toBeNull();
    await expect(deleteClaudeToken(scope)).resolves.toBeUndefined();
  });

  it("rejects malformed tokens", async () => {
    const scope = scopeFor("user-1");
    await expect(
      saveClaudeToken(scope, "sk-ant-api03-nope", { source: "pasted" }),
    ).rejects.toThrow(/sk-ant-oat/);
  });

  it.each([
    [TOKEN, true],
    ["sk-ant-oat01-short", false],
    ["sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false],
    [`${TOKEN} `, false],
    [`${TOKEN}\n`, false],
    ["", false],
  ])("validates token %s -> %s", (value, expected) => {
    expect(isValidClaudeOauthToken(value)).toBe(expected);
  });
});
