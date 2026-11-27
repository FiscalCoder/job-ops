import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWithRequestContext } from "@infra/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetClaudeLoginsForTests,
  type ClaudeLoginDeps,
  cancelClaudeLogin,
  getClaudeLoginSnapshot,
  saveManualClaudeToken,
  startClaudeLogin,
  submitClaudeLoginCode,
} from "./claude-login";
import { loadClaudeToken } from "./claude-token-store";
import { getCliAuthScope } from "./scope";

const ESC = "\u001b";
const BEL = "\u0007";
const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=xyz&state=s1";
const TOKEN = `sk-ant-oat01-${"Zz9_-".repeat(20)}`;

type MockProc = ChildProcessWithoutNullStreams & {
  stdinWrites: string[];
  killed: boolean;
};

function createMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  const stdin = new PassThrough();
  proc.stdin = stdin;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdinWrites = [];
  proc.killed = false;
  stdin.on("data", (chunk: Buffer) => {
    proc.stdinWrites.push(chunk.toString("utf8"));
  });
  proc.kill = vi.fn(() => {
    proc.killed = true;
    setImmediate(() => proc.emit("exit", null, "SIGTERM"));
    return true;
  }) as MockProc["kill"];
  return proc;
}

function emitPrompt(proc: MockProc): void {
  (proc.stdout as PassThrough).write(
    `${ESC}[2K✻ Opening browser to sign in…\r\n`,
  );
  (proc.stdout as PassThrough).write(
    `Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n${ESC}]8;id=1;${AUTH_URL}${ESC}\\${AUTH_URL}${ESC}]8;;${ESC}\\\r\n\r\nPaste code here if prompted > `,
  );
}

function firstProc(procs: MockProc[]): MockProc {
  const proc = procs[0];
  if (!proc) throw new Error("expected a spawned process");
  return proc;
}

function scopeFor(userId: string) {
  return runWithRequestContext({ tenantId: "tenant-a", userId }, () =>
    getCliAuthScope(),
  );
}

describe("claude setup-token login", () => {
  let dataDir: string;
  let procs: MockProc[];
  let deps: ClaudeLoginDeps;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "claude-login-"));
    vi.stubEnv("DATA_DIR", dataDir);
    procs = [];
    deps = {
      platform: "linux",
      spawnFn: vi.fn(() => {
        const proc = createMockProc();
        procs.push(proc);
        setImmediate(() => emitPrompt(proc));
        return proc;
      }) as unknown as ClaudeLoginDeps["spawnFn"],
      timeouts: { startMs: 2_000, codeMs: 2_000, idleMs: 60_000 },
    };
  });

  afterEach(() => {
    __resetClaudeLoginsForTests();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts the CLI under a wide pty in the user's scope and returns the sign-in URL", async () => {
    const scope = scopeFor("user-1");
    vi.stubEnv("ANTHROPIC_API_KEY", "server-key");

    const snapshot = await startClaudeLogin(scope, deps);

    expect(snapshot.status).toBe("awaiting_code");
    expect(snapshot.signInUrl).toBe(AUTH_URL);
    expect(snapshot.expiresAt).not.toBeNull();

    const [command, args, options] = vi.mocked(
      deps.spawnFn as NonNullable<ClaudeLoginDeps["spawnFn"]>,
    ).mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe("script");
    expect(args[0]).toBe("-qfc");
    expect(args[1]).toContain("stty cols 4000 rows 50");
    expect(args[1]).toContain("setup-token");
    expect(args[2]).toBe("/dev/null");
    expect(options.cwd).toBe(scope.workDir);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(scope.claudeDir);
    expect(options.env.HOME).toBe(scope.homeDir);
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect((options as { detached?: boolean }).detached).toBe(true);
  });

  it("spawns the CLI directly on Windows", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, { ...deps, platform: "win32" });
    const [command, args] = vi.mocked(
      deps.spawnFn as NonNullable<ClaudeLoginDeps["spawnFn"]>,
    ).mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe("claude");
    expect(args).toEqual(["setup-token"]);
  });

  it("returns the running session on a second start", async () => {
    const scope = scopeFor("user-1");
    const first = await startClaudeLogin(scope, deps);
    const second = await startClaudeLogin(scope, deps);
    expect(deps.spawnFn).toHaveBeenCalledTimes(1);
    expect(second.signInUrl).toBe(first.signInUrl);
  });

  it("keeps sessions per user", async () => {
    await startClaudeLogin(scopeFor("user-1"), deps);
    expect(getClaudeLoginSnapshot(scopeFor("user-2"))).toBeNull();
    await startClaudeLogin(scopeFor("user-2"), deps);
    expect(deps.spawnFn).toHaveBeenCalledTimes(2);
  });

  it("types the code into the same process and stores the printed token", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, deps);
    const proc = firstProc(procs);
    proc.stdin.on("data", () => {
      setImmediate(() => {
        (proc.stdout as PassThrough).write(
          `\r\n✓ Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n${TOKEN.slice(0, 50)}\r\n${TOKEN.slice(50)}\r\n\r\nStore this token securely.\r\n`,
        );
      });
    });

    const result = await submitClaudeLoginCode(
      scope,
      "  the-code#state  ",
      deps,
    );

    expect(proc.stdinWrites.join("")).toBe("the-code#state\r");
    expect(result.status).toBe("connected");
    expect(result.metadata.source).toBe("setup-token");
    expect((await loadClaudeToken(scope))?.token).toBe(TOKEN);
    expect(proc.kill).toHaveBeenCalled();
    expect(getClaudeLoginSnapshot(scope)).toBeNull();
  });

  it("fails clearly when the CLI rejects the code", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, deps);
    const proc = firstProc(procs);
    proc.stdin.on("data", () => {
      setImmediate(() => {
        (proc.stdout as PassThrough).write(
          "\r\nOAuth error: invalid_grant\r\n",
        );
      });
    });

    await expect(submitClaudeLoginCode(scope, "bad", deps)).rejects.toThrow(
      /Code rejected or expired/,
    );
    expect(getClaudeLoginSnapshot(scope)?.status).toBe("failed");
    expect(await loadClaudeToken(scope)).toBeNull();
  });

  it("tolerates a transient error line followed by the token", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, deps);
    const proc = firstProc(procs);
    proc.stdin.on("data", () => {
      setImmediate(() => {
        (proc.stdout as PassThrough).write(
          "\r\nerror: request failed with status code 429, retrying\r\n",
        );
        setTimeout(() => {
          (proc.stdout as PassThrough).write(`\r\n${TOKEN}\r\n`);
        }, 30);
      });
    });

    const result = await submitClaudeLoginCode(scope, "abc", deps);

    expect(result.status).toBe("connected");
    expect((await loadClaudeToken(scope))?.token).toBe(TOKEN);
  });

  it("waits a grace window after a rejection phrase before failing", async () => {
    const scope = scopeFor("user-1");
    const graceDeps: ClaudeLoginDeps = {
      ...deps,
      timeouts: {
        startMs: 2_000,
        codeMs: 5_000,
        idleMs: 60_000,
        rejectGraceMs: 300,
      },
    };
    await startClaudeLogin(scope, graceDeps);
    const proc = firstProc(procs);
    proc.stdin.on("data", () => {
      setImmediate(() => {
        (proc.stdout as PassThrough).write("\r\nOAuth error: retrying\r\n");
        setTimeout(() => {
          (proc.stdout as PassThrough).write(`\r\n${TOKEN}\r\n`);
        }, 50);
      });
    });

    const result = await submitClaudeLoginCode(scope, "abc", graceDeps);
    expect(result.status).toBe("connected");
  });

  it("rejects after the grace window when only a rejection phrase appears", async () => {
    const scope = scopeFor("user-1");
    const graceDeps: ClaudeLoginDeps = {
      ...deps,
      timeouts: {
        startMs: 2_000,
        codeMs: 5_000,
        idleMs: 60_000,
        rejectGraceMs: 40,
      },
    };
    await startClaudeLogin(scope, graceDeps);
    const proc = firstProc(procs);
    proc.stdin.on("data", () => {
      setImmediate(() => {
        (proc.stdout as PassThrough).write("\r\nInvalid code\r\n");
      });
    });
    const startedAt = Date.now();
    await expect(
      submitClaudeLoginCode(scope, "abc", graceDeps),
    ).rejects.toThrow(/Code rejected or expired/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  describe("CLI 2.1.332 output (words placed with cursor moves)", () => {
    const col = (words: string[]) =>
      words.map((word, index) => `${ESC}[${2 + index * 9}G${word}`).join("");
    const SHORT_URL = "https://claude.ai/oauth/authorize?IvdRs7RdHwTx0GP1relV";

    function cliDeps(onCode?: (proc: MockProc) => void): ClaudeLoginDeps {
      return {
        ...deps,
        spawnFn: vi.fn(() => {
          const proc = createMockProc();
          procs.push(proc);
          setImmediate(() => {
            (proc.stdout as PassThrough).write(
              `${ESC}]8;id=1;${SHORT_URL}${BEL}${SHORT_URL}${ESC}]8;;${BEL}\r\r\n\r\r\n${col(["Paste", "code", "here", "if", "prompted"])}\r\r\n`,
            );
          });
          if (onCode) proc.stdin.once("data", () => onCode(proc));
          return proc;
        }) as unknown as ClaudeLoginDeps["spawnFn"],
        timeouts: {
          startMs: 10_000,
          codeMs: 10_000,
          idleMs: 60_000,
          rejectGraceMs: 50,
        },
      };
    }

    it("returns the link as soon as the prompt shows, not at the start timeout", async () => {
      const startedAt = Date.now();
      const snapshot = await startClaudeLogin(scopeFor("user-1"), cliDeps());
      expect(snapshot.signInUrl).toBe(SHORT_URL);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it("returns shortly after the link even when no prompt is recognised", async () => {
      const quiet: ClaudeLoginDeps = {
        ...deps,
        spawnFn: vi.fn(() => {
          const proc = createMockProc();
          setImmediate(() =>
            (proc.stdout as PassThrough).write(
              `${ESC}]8;id=1;${SHORT_URL}${BEL}${SHORT_URL}${ESC}]8;;${BEL}\r\n`,
            ),
          );
          return proc;
        }) as unknown as ClaudeLoginDeps["spawnFn"],
        timeouts: { startMs: 10_000, codeMs: 10_000, idleMs: 60_000 },
      };
      const startedAt = Date.now();
      const snapshot = await startClaudeLogin(scopeFor("user-1"), quiet);
      expect(snapshot.signInUrl).toBe(SHORT_URL);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    });

    it("types the code, then presses Enter as a separate keystroke", async () => {
      const scope = scopeFor("user-1");
      const withToken = cliDeps((proc) => {
        setTimeout(
          () => (proc.stdout as PassThrough).write(`\r\n${TOKEN}\r\n`),
          400,
        );
      });
      await startClaudeLogin(scope, withToken);
      await submitClaudeLoginCode(scope, "the-code#state", withToken);
      expect(firstProc(procs).stdinWrites).toEqual(["the-code#state", "\r"]);
    });

    it("fails fast with Claude's own reason when the code is refused", async () => {
      const scope = scopeFor("user-1");
      const refusing = cliDeps((proc) => {
        setTimeout(
          () =>
            (proc.stdout as PassThrough).write(
              `${col(["✘", "OAuth", "error:", "That", "code", "wasn't", "accepted."])}\r\r\n${col(["Press", "Enter", "to", "retry"])}\r\r\n`,
            ),
          200,
        );
      });
      await startClaudeLogin(scope, refusing);
      const startedAt = Date.now();
      await expect(
        submitClaudeLoginCode(scope, "old-code#state", refusing),
      ).rejects.toThrow(/That code wasn't accepted\./);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(getClaudeLoginSnapshot(scope)?.message).toMatch(
        /That code wasn't accepted\./,
      );
    });

    it("records a one-year expiry for a setup-token login", async () => {
      const scope = scopeFor("user-1");
      const withToken = cliDeps((proc) => {
        setTimeout(
          () => (proc.stdout as PassThrough).write(`\r\n${TOKEN}\r\n`),
          400,
        );
      });
      await startClaudeLogin(scope, withToken);
      const { metadata } = await submitClaudeLoginCode(
        scope,
        "the-code#state",
        withToken,
      );
      const days =
        (Date.parse(metadata.expiresAt ?? "") - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(364);
      expect(days).toBeLessThan(366);
    });
  });

  it("caps concurrent sign-ins across users", async () => {
    vi.stubEnv("CLAUDE_SETUP_TOKEN_MAX_SESSIONS", "1");
    await startClaudeLogin(scopeFor("user-1"), deps);
    await expect(startClaudeLogin(scopeFor("user-2"), deps)).rejects.toThrow(
      /Too many sign-ins in progress, try again shortly/,
    );
    expect(deps.spawnFn).toHaveBeenCalledTimes(1);
    const again = await startClaudeLogin(scopeFor("user-1"), deps);
    expect(again.status).toBe("awaiting_code");
  });

  it("drops failed sessions once their retention has passed", async () => {
    const quietDeps: ClaudeLoginDeps = {
      ...deps,
      spawnFn: vi.fn(() =>
        createMockProc(),
      ) as unknown as ClaudeLoginDeps["spawnFn"],
      timeouts: { startMs: 30, codeMs: 50, idleMs: 60_000, terminalTtlMs: 40 },
    };
    const scope = scopeFor("user-1");
    await expect(startClaudeLogin(scope, quietDeps)).rejects.toThrow();
    expect(getClaudeLoginSnapshot(scope)?.status).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getClaudeLoginSnapshot(scope)).toBeNull();
  });

  it("fails when the CLI exits without printing a token", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, deps);
    const proc = firstProc(procs);
    proc.stdin.on("data", () => {
      setImmediate(() => proc.emit("exit", 1, null));
    });
    await expect(submitClaudeLoginCode(scope, "abc", deps)).rejects.toThrow(
      /Code rejected or expired/,
    );
  });

  it("times out waiting for the token", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, {
      ...deps,
      timeouts: { startMs: 2_000, codeMs: 50, idleMs: 60_000 },
    });
    await expect(
      submitClaudeLoginCode(scope, "abc", {
        ...deps,
        timeouts: { startMs: 2_000, codeMs: 50, idleMs: 60_000 },
      }),
    ).rejects.toThrow(/Code rejected or expired/);
  });

  it.each([
    ["", /code/i],
    ["has\nnewline", /code/i],
    ["has\u0007bell", /code/i],
    ["x".repeat(600), /code/i],
  ])("rejects invalid code %#", async (code, error) => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, deps);
    await expect(submitClaudeLoginCode(scope, code, deps)).rejects.toThrow(
      error,
    );
    expect(procs[0]?.stdinWrites).toEqual([]);
  });

  it("requires a running login before accepting a code", async () => {
    await expect(
      submitClaudeLoginCode(scopeFor("user-1"), "abc", deps),
    ).rejects.toThrow(/start again/i);
  });

  it("fails start when the CLI never shows a URL", async () => {
    const quietDeps: ClaudeLoginDeps = {
      ...deps,
      spawnFn: vi.fn(() =>
        createMockProc(),
      ) as unknown as ClaudeLoginDeps["spawnFn"],
      timeouts: { startMs: 50, codeMs: 50, idleMs: 60_000 },
    };
    await expect(
      startClaudeLogin(scopeFor("user-1"), quietDeps),
    ).rejects.toThrow(/sign-in link/i);
  });

  it("kills an idle login after the idle timeout", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, {
      ...deps,
      timeouts: { startMs: 2_000, codeMs: 2_000, idleMs: 30 },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(procs[0]?.kill).toHaveBeenCalled();
    expect(getClaudeLoginSnapshot(scope)?.status).toBe("expired");
  });

  it("cancels a running login", async () => {
    const scope = scopeFor("user-1");
    await startClaudeLogin(scope, deps);
    cancelClaudeLogin(scope);
    expect(procs[0]?.kill).toHaveBeenCalled();
    expect(getClaudeLoginSnapshot(scope)).toBeNull();
  });

  it("saves a pasted token", async () => {
    const scope = scopeFor("user-1");
    const metadata = await saveManualClaudeToken(scope, `  ${TOKEN}  `);
    expect(metadata.source).toBe("pasted");
    expect((await loadClaudeToken(scope))?.token).toBe(TOKEN);
  });

  it("rejects a pasted non-OAuth key", async () => {
    await expect(
      saveManualClaudeToken(scopeFor("user-1"), "sk-ant-api03-abc"),
    ).rejects.toThrow(/sk-ant-oat/);
  });
});
