import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { buildCliEnv, type CliAuthScope } from "./scope";

/**
 * Process plumbing for `claude setup-token`: spawning it under a pty, keeping
 * a bounded output buffer, and waiting on output/exit events.
 */
export type SetupTokenSpawnDeps = {
  spawnFn?: typeof spawn;
  platform?: NodeJS.Platform;
};

export type OutputBuffer = {
  append: (chunk: string) => void;
  all: () => string;
  mark: () => void;
  sinceMark: () => string;
};

const MAX_OUTPUT_CHARS = 200_000;
const KILL_ESCALATE_MS = 3_000;
const PTY_COLUMNS = "4000";

function resolveCliBin(): string {
  const configured = process.env.CLAUDE_CLI_BIN?.trim();
  return configured && /^[A-Za-z0-9_./\\:-]+$/.test(configured)
    ? configured
    : "claude";
}

/**
 * Linux (the server image) runs the CLI under `script` so it gets a pty and
 * prints its sign-in URL; a very wide terminal keeps the URL and token on one
 * line. Other platforms spawn it directly (local development only — without a
 * pty the CLI may print nothing, so use the paste-a-token fallback there).
 * On Linux `script` is detached into its own process group so stopping it
 * also stops the `claude` child it forked (see `terminateSetupToken`).
 */
export function spawnSetupToken(
  scope: CliAuthScope,
  deps: SetupTokenSpawnDeps,
): ChildProcessWithoutNullStreams {
  const spawnFn = deps.spawnFn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const bin = resolveCliBin();
  const env = buildCliEnv(scope, {
    TERM: "xterm-256color",
    COLUMNS: PTY_COLUMNS,
  });
  const options = { cwd: scope.workDir, env, stdio: "pipe" as const };
  if (platform === "linux") {
    const command = `stty cols ${PTY_COLUMNS} rows 50; exec ${bin} setup-token`;
    return spawnFn("script", ["-qfc", command, "/dev/null"], {
      ...options,
      detached: true,
    });
  }
  const shell = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  return spawnFn(bin, ["setup-token"], {
    ...options,
    shell,
    windowsHide: true,
  });
}

/** Whether `spawnSetupToken` put the process in its own process group. */
export function usesProcessGroup(deps: SetupTokenSpawnDeps): boolean {
  return (deps.platform ?? process.platform) === "linux";
}

function signalProcess(
  proc: ChildProcessWithoutNullStreams,
  group: boolean,
  signal: NodeJS.Signals,
): void {
  if (group && typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Group already gone or not ours: fall back to the direct child.
    }
  }
  proc.kill(signal);
}

/**
 * Stop a setup-token process: SIGTERM (to the whole group on Linux), then
 * SIGKILL if it has not exited after `escalateMs`.
 */
export function terminateSetupToken(
  proc: ChildProcessWithoutNullStreams,
  options: { group: boolean; escalateMs?: number },
): void {
  let exited = false;
  const timer = setTimeout(() => {
    if (!exited) signalProcess(proc, options.group, "SIGKILL");
  }, options.escalateMs ?? KILL_ESCALATE_MS);
  timer.unref?.();
  proc.once("exit", () => {
    exited = true;
    clearTimeout(timer);
  });
  signalProcess(proc, options.group, "SIGTERM");
}

export function createOutputBuffer(): OutputBuffer {
  let text = "";
  let markAt: number | null = null;
  return {
    append: (chunk) => {
      const next = text + chunk;
      const overflow = Math.max(0, next.length - MAX_OUTPUT_CHARS);
      text = next.slice(overflow);
      markAt = markAt === null ? null : Math.max(0, markAt - overflow);
    },
    all: () => text,
    mark: () => {
      markAt = text.length;
    },
    sinceMark: () => (markAt === null ? "" : text.slice(markAt)),
  };
}

export type WaitCheck<T> = (
  exited: boolean,
) => { done: true; value: T } | { done: false };

/**
 * Re-evaluate `check` on every "output"/"exit" event until it is done or the
 * timeout fires (then `onTimeout` decides the value).
 */
export function waitForEvents<T>(
  events: EventEmitter,
  timeoutMs: number,
  check: WaitCheck<T>,
  onTimeout: () => T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const settle = (value: T) => {
      clearTimeout(timer);
      events.off("output", onOutput);
      events.off("exit", onExit);
      resolve(value);
    };
    const evaluate = (exited: boolean) => {
      const outcome = check(exited);
      if (outcome.done) settle(outcome.value);
    };
    const onOutput = () => evaluate(false);
    const onExit = () => evaluate(true);
    const timer = setTimeout(() => settle(onTimeout()), timeoutMs);
    events.on("output", onOutput);
    events.on("exit", onExit);
    evaluate(false);
  });
}
