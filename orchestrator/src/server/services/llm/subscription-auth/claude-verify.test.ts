import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyClaudeToken } from "./claude-verify";
import type { CliAuthScope } from "./scope";

const { callJsonMock, clientOptions } = vi.hoisted(() => ({
  callJsonMock: vi.fn(),
  clientOptions: [] as unknown[],
}));

vi.mock("../claude-cli/client", () => ({
  ClaudeCliClient: vi.fn(function MockClient(options: unknown) {
    clientOptions.push(options);
    return { callJson: callJsonMock };
  }),
}));

const { runtimeMock } = vi.hoisted(() => ({ runtimeMock: vi.fn() }));
vi.mock("./claude-runtime", () => ({
  resolveClaudeCliRuntimeForScope: runtimeMock,
}));

const SCOPE: CliAuthScope = {
  scopeKey: "user-a",
  baseDir: "/s",
  claudeDir: "/s/claude",
  codexHome: "/s/codex",
  homeDir: "/s/home",
  workDir: "/s/work",
};

describe("verifyClaudeToken", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clientOptions.length = 0;
  });

  it("runs a tiny Haiku call at low effort with the user's own runtime", async () => {
    callJsonMock.mockResolvedValue({ text: JSON.stringify({ ok: true }) });
    runtimeMock.mockResolvedValue({ env: {}, cwd: "/s/work" });

    const result = await verifyClaudeToken(SCOPE);

    expect(result).toEqual({ ok: true, message: "Claude subscription works." });
    expect(callJsonMock.mock.calls[0]?.[0].model).toBe("claude-haiku-5-5");
    const options = clientOptions[0] as {
      resolveRuntime: () => Promise<unknown>;
      resolveEffort: () => Promise<string>;
      requestTimeoutMs: number;
    };
    await options.resolveRuntime();
    expect(runtimeMock).toHaveBeenCalledWith(SCOPE);
    await expect(options.resolveEffort()).resolves.toBe("low");
    expect(options.requestTimeoutMs).toBeLessThanOrEqual(60_000);
  });

  it("reports failures without throwing", async () => {
    callJsonMock.mockRejectedValue(
      new Error("Login expired · Please run /login"),
    );
    await expect(verifyClaudeToken(SCOPE)).resolves.toEqual({
      ok: false,
      message: "Login expired · Please run /login",
    });
  });
});
