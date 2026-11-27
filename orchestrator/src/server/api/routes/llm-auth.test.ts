import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  startClaudeLoginMock,
  submitClaudeLoginCodeMock,
  verifyClaudeTokenMock,
  startCodexDeviceAuthMock,
  getCodexDeviceAuthSnapshotMock,
  consumeCompletedCodexDeviceAuthMock,
  disconnectCodexAuthMock,
  resetCodexSessionMock,
} = vi.hoisted(() => ({
  startClaudeLoginMock: vi.fn(),
  submitClaudeLoginCodeMock: vi.fn(),
  verifyClaudeTokenMock: vi.fn(),
  startCodexDeviceAuthMock: vi.fn(),
  getCodexDeviceAuthSnapshotMock: vi.fn(),
  consumeCompletedCodexDeviceAuthMock: vi.fn(),
  disconnectCodexAuthMock: vi.fn(),
  resetCodexSessionMock: vi.fn(),
}));

vi.mock(
  "@server/services/llm/subscription-auth/claude-login",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@server/services/llm/subscription-auth/claude-login")
      >();
    return {
      ...actual,
      startClaudeLogin: startClaudeLoginMock,
      submitClaudeLoginCode: submitClaudeLoginCodeMock,
    };
  },
);

vi.mock("@server/services/llm/subscription-auth/claude-verify", () => ({
  verifyClaudeToken: verifyClaudeTokenMock,
}));

vi.mock("@server/services/llm/codex/login", () => ({
  startCodexDeviceAuth: startCodexDeviceAuthMock,
  getCodexDeviceAuthSnapshot: getCodexDeviceAuthSnapshotMock,
  consumeCompletedCodexDeviceAuth: consumeCompletedCodexDeviceAuthMock,
  disconnectCodexAuth: disconnectCodexAuthMock,
}));

vi.mock("@server/services/llm/codex/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@server/services/llm/codex/client")>();
  return { ...actual, resetCodexSession: resetCodexSessionMock };
});

import { startServer, stopServer } from "./test-utils";

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

const TOKEN = `sk-ant-oat01-${"Ab9_-".repeat(10)}`;
const IDLE_CODEX = {
  status: "idle",
  loginInProgress: false,
  verificationUrl: null,
  userCode: null,
  startedAt: null,
  expiresAt: null,
  message: null,
};

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.data.token as string;
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe.sequential("LLM subscription auth routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let adminToken: string;
  let adamToken: string;

  async function call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/api/llm-auth${path}`, {
      method,
      headers: headers(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    getCodexDeviceAuthSnapshotMock.mockReturnValue(IDLE_CODEX);
    verifyClaudeTokenMock.mockResolvedValue({ ok: true, message: "works" });
    consumeCompletedCodexDeviceAuthMock.mockReturnValue(null);
    disconnectCodexAuthMock.mockResolvedValue(IDLE_CODEX);
    resetCodexSessionMock.mockResolvedValue(undefined);

    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));
    adminToken = await login(baseUrl, "admin", "secret");
    const created = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: headers(adminToken),
      body: JSON.stringify({
        username: "adam",
        displayName: "Adam",
        password: "adam-secret",
      }),
    });
    expect(created.status).toBe(201);
    adamToken = await login(baseUrl, "adam", "adam-secret");
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/llm-auth/status`);
    expect(res.status).toBe(401);
  });

  it("reports both subscriptions as missing for a new user", async () => {
    const { status, body } = await call(adamToken, "GET", "/status");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      claude: {
        connected: false,
        source: null,
        createdAt: null,
        expiresAt: null,
        state: "missing",
        login: null,
      },
      codex: {
        connected: false,
        state: "missing",
        lastRefreshAt: null,
        login: null,
      },
      subscriptionFallback: { enabled: true, available: false },
    });
  });

  it("stores a pasted token for the caller only and never returns it", async () => {
    const saved = await call(adamToken, "POST", "/claude/token", {
      token: TOKEN,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.claude).toMatchObject({
      connected: true,
      source: "pasted",
      state: "ok",
    });
    expect(JSON.stringify(saved.body)).not.toContain("sk-ant-oat");

    const adminView = await call(adminToken, "GET", "/status");
    expect(adminView.body.data.claude.connected).toBe(false);

    const adamView = await call(adamToken, "GET", "/status");
    expect(adamView.body.data.claude.connected).toBe(true);
  });

  it("rejects a malformed token without echoing it", async () => {
    const { status, body } = await call(adamToken, "POST", "/claude/token", {
      token: "sk-ant-api03-not-a-subscription-token",
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).not.toContain("sk-ant-api03");
  });

  it.each([
    [{}],
    [{ token: "" }],
    [{ token: 42 }],
  ])("validates the token body %#", async (payload) => {
    const { status } = await call(adamToken, "POST", "/claude/token", payload);
    expect(status).toBe(400);
  });

  it("disconnect removes only the caller's Claude login", async () => {
    await call(adamToken, "POST", "/claude/token", { token: TOKEN });
    await call(adminToken, "POST", "/claude/token", { token: TOKEN });

    const res = await call(adamToken, "POST", "/claude/disconnect");
    expect(res.status).toBe(200);
    expect(res.body.data.claude.connected).toBe(false);
    expect(
      (await call(adminToken, "GET", "/status")).body.data.claude.connected,
    ).toBe(true);
  });

  it("starts a Claude sign-in in the caller's scope", async () => {
    startClaudeLoginMock.mockResolvedValue({
      status: "awaiting_code",
      signInUrl: "https://claude.com/cai/oauth/authorize?code=true",
      startedAt: "2026-11-27T10:00:00.000Z",
      expiresAt: "2026-11-27T10:10:00.000Z",
      message: null,
    });

    const res = await call(adamToken, "POST", "/claude/start");

    expect(res.status).toBe(200);
    expect(res.body.data.claude.login).toMatchObject({
      status: "awaiting_code",
      signInUrl: "https://claude.com/cai/oauth/authorize?code=true",
    });
    const scope = startClaudeLoginMock.mock.calls[0]?.[0] as {
      baseDir: string;
    };
    expect(scope.baseDir).toContain("llm-auth");
  });

  it("submits the code and returns the new status", async () => {
    submitClaudeLoginCodeMock.mockResolvedValue({
      status: "connected",
      metadata: {
        createdAt: "2026-11-27T10:00:00.000Z",
        expiresAt: "2027-11-27T10:00:00.000Z",
        source: "setup-token",
      },
    });

    const res = await call(adamToken, "POST", "/claude/code", {
      code: "abc#def",
    });

    expect(res.status).toBe(200);
    expect(submitClaudeLoginCodeMock.mock.calls[0]?.[1]).toBe("abc#def");
    expect(res.body.data).toHaveProperty("claude");
    expect(res.body.data.verification).toEqual({
      ok: true,
      message: "works",
    });
  });

  it("keeps a saved sign-in when the follow-up verification fails", async () => {
    submitClaudeLoginCodeMock.mockResolvedValue({
      status: "connected",
      metadata: {
        createdAt: "2026-11-27T10:00:00.000Z",
        expiresAt: "2027-11-27T10:00:00.000Z",
        source: "setup-token",
      },
    });
    verifyClaudeTokenMock.mockRejectedValue(new Error("usage limit reached"));

    const res = await call(adamToken, "POST", "/claude/code", { code: "abc" });

    expect(res.status).toBe(200);
    expect(res.body.data.verification.ok).toBe(false);
    expect(res.body.data.verification.message).toEqual(expect.any(String));
  });

  it("maps a missing sign-in session to 409", async () => {
    const { ClaudeLoginError } = await import(
      "@server/services/llm/subscription-auth/claude-login"
    );
    submitClaudeLoginCodeMock.mockRejectedValue(
      new ClaudeLoginError(
        "No Claude sign-in is waiting for a code — start again.",
      ),
    );
    const res = await call(adamToken, "POST", "/claude/code", { code: "x" });
    expect(res.status).toBe(409);
  });

  it("maps a rejected code to 400", async () => {
    const { ClaudeLoginError } = await import(
      "@server/services/llm/subscription-auth/claude-login"
    );
    submitClaudeLoginCodeMock.mockRejectedValue(
      new ClaudeLoginError("Code rejected or expired — start again."),
    );
    const res = await call(adamToken, "POST", "/claude/code", { code: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Code rejected/);
  });

  it("validates the code body", async () => {
    const res = await call(adamToken, "POST", "/claude/code", {
      code: "a\nb",
    });
    expect(res.status).toBe(400);
    expect(submitClaudeLoginCodeMock).not.toHaveBeenCalled();
  });

  it("tests the stored login on demand", async () => {
    verifyClaudeTokenMock.mockResolvedValue({ ok: true, message: "works" });
    const res = await call(adamToken, "POST", "/claude/test");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, message: "works" });
  });

  it("rejects a concurrent Claude test with 409 and a quick retry with 429", async () => {
    let finish: (value: unknown) => void = () => undefined;
    verifyClaudeTokenMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = call(adamToken, "POST", "/claude/test");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const concurrent = await call(adamToken, "POST", "/claude/test");
    expect(concurrent.status).toBe(409);
    expect(concurrent.body.error.message).toMatch(/already running/i);

    finish({ ok: true, message: "works" });
    expect((await first).status).toBe(200);

    const tooSoon = await fetch(`${baseUrl}/api/llm-auth/claude/test`, {
      method: "POST",
      headers: headers(adamToken),
    });
    expect(tooSoon.status).toBe(429);
    expect(Number(tooSoon.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await tooSoon.json()).error.message).toMatch(/wait \d+ seconds/i);
    expect(verifyClaudeTokenMock).toHaveBeenCalledTimes(1);
  });

  it("rate-limits mutating subscription-login requests per user", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      lastStatus = (await call(adamToken, "POST", "/claude/disconnect")).status;
    }
    expect(lastStatus).toBe(429);
    expect((await call(adminToken, "POST", "/claude/disconnect")).status).toBe(
      200,
    );
    expect((await call(adamToken, "GET", "/status")).status).toBe(200);
  });

  it("maps a too-many-sign-ins refusal to 503", async () => {
    const { ClaudeLoginError } = await import(
      "@server/services/llm/subscription-auth/claude-login"
    );
    startClaudeLoginMock.mockRejectedValue(
      new ClaudeLoginError("Too many sign-ins in progress, try again shortly"),
    );
    const res = await call(adamToken, "POST", "/claude/start");
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe(
      "Too many sign-ins in progress, try again shortly",
    );
  });

  it("starts Codex device auth for the caller and exposes it in status", async () => {
    const running = {
      status: "running",
      loginInProgress: true,
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      startedAt: "2026-11-27T10:00:00.000Z",
      expiresAt: "2026-11-27T10:15:00.000Z",
      message: "Open the URL",
    };
    startCodexDeviceAuthMock.mockResolvedValue(running);
    getCodexDeviceAuthSnapshotMock.mockReturnValue(running);

    const res = await call(adamToken, "POST", "/codex/start", {
      forceRestart: true,
    });

    expect(res.status).toBe(200);
    expect(startCodexDeviceAuthMock.mock.calls[0]?.[0]).toBe(true);
    expect(res.body.data.codex.login).toEqual({
      status: "running",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-11-27T10:15:00.000Z",
      message: "Open the URL",
    });
  });

  it("disconnects Codex in the caller's scope", async () => {
    const res = await call(adamToken, "POST", "/codex/disconnect");
    expect(res.status).toBe(200);
    expect(disconnectCodexAuthMock).toHaveBeenCalledOnce();
    expect(resetCodexSessionMock).toHaveBeenCalledOnce();
    const adamScope = disconnectCodexAuthMock.mock.calls[0]?.[0] as {
      scopeKey: string;
    };
    await call(adminToken, "POST", "/codex/disconnect");
    const adminScope = disconnectCodexAuthMock.mock.calls[1]?.[0] as {
      scopeKey: string;
    };
    expect(adamScope.scopeKey).not.toBe(adminScope.scopeKey);
  });

  it("lets a non-admin switch their own provider to a subscription CLI only", async () => {
    const patch = (body: unknown) =>
      fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: headers(adamToken),
        body: JSON.stringify(body),
      });

    expect(
      (
        await patch({
          llmProvider: "claude_cli",
          modelScorer: "claude-haiku-5-5",
          claudeCliEffort: "low",
          subscriptionFallback: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patch({
          llmPurposeOverrides: { tailoring: { provider: "codex" } },
        })
      ).status,
    ).toBe(200);
    expect((await patch({ llmProvider: "openai" })).status).toBe(403);
    expect(
      (await patch({ llmProvider: "claude_cli", llmBaseUrl: "https://x.test" }))
        .status,
    ).toBe(403);
    expect((await patch({ llmApiKey: "sk-test" })).status).toBe(403);
  });

  it("refuses non-admin model changes while the provider is an API provider", async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: headers(adamToken),
      body: JSON.stringify({ modelScorer: "some-expensive-model" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses non-admin AI changes in a workspace with several members", async () => {
    const created = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: headers(adminToken),
      body: JSON.stringify({
        username: "eve",
        displayName: "Eve",
        password: "eve-secret",
      }),
    });
    const eve = (await created.json()).data.user as { id: string };
    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: headers(adamToken),
    });
    const meBody = await me.json();
    const adamWorkspace = (meBody.data.user ?? meBody.data)
      .workspaceId as string;
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.tenantMemberships).values({
      id: "membership-eve-in-adam",
      userId: eve.id,
      tenantId: adamWorkspace,
      role: "member",
    });

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: headers(adamToken),
      body: JSON.stringify({ llmProvider: "claude_cli" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe(
      "Only an admin can change the AI provider for a shared workspace",
    );
  });
});

describe("LLM subscription auth routes without a user", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const express = (await import("express")).default;
    const { llmAuthRouter } = await import("./llm-auth");
    const app = express();
    app.use(express.json());
    app.use("/api/llm-auth", llmAuthRouter);
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it.each([
    ["GET", "/status"],
    ["POST", "/claude/test"],
  ])("answers 401 when no user scope exists (%s %s)", async (method, path) => {
    const res = await fetch(`${baseUrl}/api/llm-auth${path}`, { method });
    expect(res.status).toBe(401);
    expect(verifyClaudeTokenMock).not.toHaveBeenCalled();
  });
});
