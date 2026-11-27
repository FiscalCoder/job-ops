import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAuthScope } from "../subscription-auth/scope";
import {
  __resetCodexDeviceAuthForTests,
  consumeCompletedCodexDeviceAuth,
  disconnectCodexAuth,
  getCodexDeviceAuthSnapshot,
  startCodexDeviceAuth,
} from "./login";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  default: {
    spawn: spawnMock,
  },
}));

const { scopeState } = vi.hoisted(() => ({
  scopeState: { current: null as CliAuthScope | null, root: "" },
}));

vi.mock("../subscription-auth/scope", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subscription-auth/scope")>();
  return {
    ...actual,
    getCliAuthScope: () => {
      if (!scopeState.current) {
        throw new actual.CliAuthScopeError("No signed-in user");
      }
      return scopeState.current;
    },
  };
});

function makeScope(name: string): CliAuthScope {
  const baseDir = join(scopeState.root, name);
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

function createMockProcess(
  configure: (
    stdout: PassThrough,
    stderr: PassThrough,
    proc: EventEmitter,
  ) => void,
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const proc = new EventEmitter() as ChildProcessWithoutNullStreams & {
    killed: boolean;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    proc.killed = true;
    setImmediate(() => {
      proc.emit("exit", 0, signal ?? null);
    });
    return true;
  });

  configure(stdout, stderr, proc);
  return proc;
}

describe("codex device login service", () => {
  beforeEach(() => {
    scopeState.root = mkdtempSync(join(tmpdir(), "codex-login-"));
    scopeState.current = makeScope("user-a");
  });

  afterEach(() => {
    __resetCodexDeviceAuthForTests();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(scopeState.root, { recursive: true, force: true });
  });

  it("parses URL and device code from login output", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((stdout) => {
        setTimeout(() => {
          stdout.write(
            [
              "expires in 15 minutes",
              "\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
              "\u001b[94mHU0J-CGNH0\u001b[0m",
            ].join("\n"),
          );
        }, 0);
      }),
    );

    const snapshot = await startCodexDeviceAuth();

    expect(snapshot.status).toBe("running");
    expect(snapshot.loginInProgress).toBe(true);
    expect(snapshot.verificationUrl).toBe(
      "https://auth.openai.com/codex/device",
    );
    expect(snapshot.userCode).toBe("HU0J-CGNH0");
    expect(snapshot.expiresAt).not.toBeNull();

    const current = getCodexDeviceAuthSnapshot();
    expect(current.status).toBe("running");
    expect(current.userCode).toBe("HU0J-CGNH0");
  });

  it("returns existing running session without spawning a second process", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((stdout) => {
        setTimeout(() => {
          stdout.write("https://auth.openai.com/codex/device\n");
          stdout.write("ABCD-EFGH\n");
        }, 0);
      }),
    );

    const first = await startCodexDeviceAuth();
    const second = await startCodexDeviceAuth();

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(second.userCode).toBe(first.userCode);
    expect(second.verificationUrl).toBe(first.verificationUrl);
  });

  it("restarts device auth when forced and returns a new code", async () => {
    vi.mocked(spawn)
      .mockImplementationOnce(() =>
        createMockProcess((stdout) => {
          setTimeout(() => {
            stdout.write("https://auth.openai.com/codex/device\n");
            stdout.write("FIRST-CODE\n");
          }, 0);
        }),
      )
      .mockImplementationOnce(() =>
        createMockProcess((stdout) => {
          setTimeout(() => {
            stdout.write("https://auth.openai.com/codex/device\n");
            stdout.write("SECOND-CODE\n");
          }, 0);
        }),
      );

    const first = await startCodexDeviceAuth();
    const second = await startCodexDeviceAuth(true);

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(first.userCode).toBe("FIRST-CODE");
    expect(second.userCode).toBe("SECOND-CODE");
  });

  it("tracks process completion when login exits immediately after printing device code", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((stdout, _stderr, proc) => {
        setTimeout(() => {
          stdout.write("https://auth.openai.com/codex/device\n");
          stdout.write("ABCD-EFGH\n");
          proc.emit("exit", 0, null);
        }, 0);
      }),
    );

    const snapshot = await startCodexDeviceAuth();
    expect(snapshot.userCode).toBe("ABCD-EFGH");

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const current = getCodexDeviceAuthSnapshot();
    expect(current.status).toBe("completed");
    expect(current.loginInProgress).toBe(false);

    expect(consumeCompletedCodexDeviceAuth()?.status).toBe("completed");
    expect(consumeCompletedCodexDeviceAuth()).toBeNull();
    expect(getCodexDeviceAuthSnapshot().status).toBe("idle");
  });

  it("fails when the login process exits before yielding a device code", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((_stdout, _stderr, proc) => {
        setTimeout(() => {
          proc.emit("exit", 1, null);
        }, 0);
      }),
    );

    await expect(startCodexDeviceAuth()).rejects.toThrow(
      /device code|login exited/i,
    );
    expect(getCodexDeviceAuthSnapshot().status).toBe("failed");
  });

  it("guides user to security settings when device auth is disabled upstream", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((stdout, _stderr, proc) => {
        setTimeout(() => {
          stdout.write(
            "Enable device code authorization for Codex in ChatGPT Security Settings, then run `codex login --device-auth` again.\n",
          );
          proc.emit("exit", 1, null);
        }, 0);
      }),
    );

    await expect(startCodexDeviceAuth()).rejects.toThrow(
      /ChatGPT Security Settings/i,
    );
    const snapshot = getCodexDeviceAuthSnapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.message).toMatch(/Security Settings/i);
  });

  it("disconnects codex auth successfully", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((_stdout, _stderr, proc) => {
        setTimeout(() => {
          proc.emit("exit", 0, null);
        }, 0);
      }),
    );

    const snapshot = await disconnectCodexAuth();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.loginInProgress).toBe(false);
  });

  it("treats already-logged-out state as a successful disconnect", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((_stdout, stderr, proc) => {
        setTimeout(() => {
          stderr.write("Not logged in.\n");
          proc.emit("exit", 1, null);
        }, 0);
      }),
    );

    const snapshot = await disconnectCodexAuth();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.loginInProgress).toBe(false);
  });

  it("runs device auth inside the user's own CODEX_HOME without server keys", async () => {
    vi.stubEnv("OPENAI_API_KEY", "server-key");
    vi.stubEnv("CODEX_HOME", "/app/codex-home");
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((stdout) => {
        setTimeout(() => {
          stdout.write("https://auth.openai.com/codex/device\nABCD-EFGH\n");
        }, 0);
      }),
    );

    await startCodexDeviceAuth();

    const options = vi.mocked(spawn).mock.calls[0]?.[2] as {
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    expect(options.cwd).toBe(scopeState.current?.workDir);
    expect(options.env.CODEX_HOME).toBe(scopeState.current?.codexHome);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps a separate device-auth flow per user", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((stdout) => {
        setTimeout(() => {
          stdout.write("https://auth.openai.com/codex/device\nABCD-EFGH\n");
        }, 0);
      }),
    );
    const userA = scopeState.current as CliAuthScope;
    const userB = makeScope("user-b");

    await startCodexDeviceAuth(false, userA);
    expect(getCodexDeviceAuthSnapshot(userB).status).toBe("idle");
    await startCodexDeviceAuth(false, userB);

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(getCodexDeviceAuthSnapshot(userA).status).toBe("running");
    expect(getCodexDeviceAuthSnapshot(userB).status).toBe("running");
  });

  it("removes the user's codex credentials on disconnect", async () => {
    const scope = scopeState.current as CliAuthScope;
    writeFileSync(join(scope.codexHome, "auth.json"), "{}");
    vi.mocked(spawn).mockImplementation(() =>
      createMockProcess((_stdout, _stderr, proc) => {
        setTimeout(() => proc.emit("exit", 0, null), 0);
      }),
    );

    await disconnectCodexAuth();

    expect(existsSync(join(scope.codexHome, "auth.json"))).toBe(false);
    expect(existsSync(scope.codexHome)).toBe(true);
  });

  it("refuses to run without a user scope", () => {
    scopeState.current = null;
    expect(() => getCodexDeviceAuthSnapshot()).toThrow(/user/);
  });
});
