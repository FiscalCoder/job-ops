import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateSetupToken } from "./claude-login-process";

type FakeProc = ChildProcessWithoutNullStreams & {
  kill: ReturnType<typeof vi.fn>;
};

function fakeProc(pid: number | undefined): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  Object.defineProperty(proc, "pid", { value: pid });
  proc.kill = vi.fn(() => true);
  return proc;
}

describe("terminateSetupToken", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("signals the whole process group and escalates to SIGKILL", () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const proc = fakeProc(4242);

    terminateSetupToken(proc, { group: true, escalateMs: 3_000 });

    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    vi.advanceTimersByTime(3_000);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("does not escalate once the process has exited", () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const proc = fakeProc(4242);

    terminateSetupToken(proc, { group: true, escalateMs: 3_000 });
    proc.emit("exit", null, "SIGTERM");
    vi.advanceTimersByTime(5_000);

    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("falls back to child.kill when the group cannot be signalled", () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const proc = fakeProc(4242);
    terminateSetupToken(proc, { group: true, escalateMs: 3_000 });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses child.kill without a process group (Windows)", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const proc = fakeProc(4242);
    terminateSetupToken(proc, { group: false, escalateMs: 3_000 });
    expect(kill).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
