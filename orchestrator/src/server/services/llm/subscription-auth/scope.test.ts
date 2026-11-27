import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext } from "@infra/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCliEnv,
  type CliAuthScope,
  CliAuthScopeError,
  getCliAuthScope,
} from "./scope";

describe("getCliAuthScope", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "llm-auth-scope-"));
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("derives separate directories for two users", () => {
    const first = runWithRequestContext(
      { tenantId: "tenant-a", userId: "user-1" },
      () => getCliAuthScope(),
    );
    const second = runWithRequestContext(
      { tenantId: "tenant-a", userId: "user-2" },
      () => getCliAuthScope(),
    );

    expect(first.scopeKey).not.toBe(second.scopeKey);
    expect(first.baseDir).not.toBe(second.baseDir);
    expect(first.baseDir.startsWith(join(dataDir, "llm-auth"))).toBe(true);
    expect(first.scopeKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first.baseDir).not.toContain("user-1");
    for (const dir of [
      first.claudeDir,
      first.codexHome,
      first.homeDir,
      first.workDir,
    ]) {
      expect(dir.startsWith(first.baseDir)).toBe(true);
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("is stable for the same tenant and user", () => {
    const context = { tenantId: "tenant-a", userId: "user-1" };
    const first = runWithRequestContext(context, () => getCliAuthScope());
    const again = runWithRequestContext(context, () => getCliAuthScope());
    expect(again).toEqual(first);
  });

  it("separates the same user id across tenants", () => {
    const first = runWithRequestContext(
      { tenantId: "tenant-a", userId: "user-1" },
      () => getCliAuthScope(),
    );
    const second = runWithRequestContext(
      { tenantId: "tenant-b", userId: "user-1" },
      () => getCliAuthScope(),
    );
    expect(first.scopeKey).not.toBe(second.scopeKey);
  });

  it("hashes tenant and user unambiguously (no delimiter collisions)", () => {
    const joinedA = runWithRequestContext(
      { tenantId: "a:b", userId: "c" },
      () => getCliAuthScope(),
    );
    const joinedB = runWithRequestContext(
      { tenantId: "a", userId: "b:c" },
      () => getCliAuthScope(),
    );
    expect(joinedA.scopeKey).not.toBe(joinedB.scopeKey);
    expect(joinedA.scopeKey).toBe(
      createHash("sha256")
        .update(JSON.stringify(["a:b", "c"]))
        .digest("hex"),
    );
  });

  it("throws without a request context", () => {
    expect(() => getCliAuthScope()).toThrow(CliAuthScopeError);
  });

  it("throws when the user is missing instead of defaulting", () => {
    expect(() =>
      runWithRequestContext({ tenantId: "tenant-a" }, () => getCliAuthScope()),
    ).toThrow(CliAuthScopeError);
  });

  it("throws when the tenant is missing instead of defaulting", () => {
    expect(() =>
      runWithRequestContext({ userId: "user-1" }, () => getCliAuthScope()),
    ).toThrow(CliAuthScopeError);
  });
});

describe("buildCliEnv", () => {
  const scope: CliAuthScope = {
    scopeKey: "abc",
    baseDir: "/data/llm-auth/abc",
    claudeDir: "/data/llm-auth/abc/claude",
    codexHome: "/data/llm-auth/abc/codex",
    homeDir: "/data/llm-auth/abc/home",
    workDir: "/data/llm-auth/abc/work",
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps allow-listed variables and points config at the scope", () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("TZ", "UTC");
    vi.stubEnv("HTTPS_PROXY", "http://proxy:8080");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/certs.pem");

    const env = buildCliEnv(scope);

    expect(env.PATH ?? env.Path).toBeTruthy();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.TZ).toBe("UTC");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/certs.pem");
    expect(env.HOME).toBe(scope.homeDir);
    expect(env.USERPROFILE).toBe(scope.homeDir);
    expect(env.XDG_CONFIG_HOME).toBe(scope.homeDir);
    expect(env.CLAUDE_CONFIG_DIR).toBe(scope.claudeDir);
    expect(env.CODEX_HOME).toBe(scope.codexHome);
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("strips credentials and unrelated variables from the server env", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "auth-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-admin");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("LLM_API_KEY", "llm-key");
    vi.stubEnv("CODEX_ACCESS_TOKEN", "codex-token");
    vi.stubEnv("JWT_SECRET", "jwt");
    vi.stubEnv("CODEX_HOME", "/app/codex-home");
    vi.stubEnv("DATABASE_URL", "file:/app/data/db");

    const env = buildCliEnv(scope);

    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "LLM_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "JWT_SECRET",
      "DATABASE_URL",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.CODEX_HOME).toBe(scope.codexHome);
  });

  it("adds explicit extras such as the user's own OAuth token", () => {
    const env = buildCliEnv(scope, {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-user",
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-user");
  });

  it("never lets extras smuggle in API keys that override OAuth", () => {
    const env = buildCliEnv(scope, {
      ANTHROPIC_API_KEY: "sk-ant-api",
      ANTHROPIC_AUTH_TOKEN: "x",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("returns a fresh object each time", () => {
    const first = buildCliEnv(scope);
    const second = buildCliEnv(scope);
    expect(first).not.toBe(second);
  });
});
