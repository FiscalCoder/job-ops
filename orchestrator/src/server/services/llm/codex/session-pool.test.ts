import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAuthScope } from "../subscription-auth/scope";
import { createScopedSessionPool } from "./session-pool";

type FakeSession = { id: number; scopeKey: string; close: () => Promise<void> };

function scope(key: string): CliAuthScope {
  return {
    scopeKey: key,
    baseDir: `/s/${key}`,
    claudeDir: `/s/${key}/claude`,
    codexHome: `/s/${key}/codex`,
    homeDir: `/s/${key}/home`,
    workDir: `/s/${key}/work`,
  };
}

const IDLE_MS = 1_000;

function setup(maxLivePools = 10) {
  let nextId = 0;
  const open = new Map<string, number>();
  let maxOpenPerScope = 0;
  const closed: number[] = [];
  const startSession = vi.fn(async (s: CliAuthScope): Promise<FakeSession> => {
    const count = (open.get(s.scopeKey) ?? 0) + 1;
    open.set(s.scopeKey, count);
    maxOpenPerScope = Math.max(maxOpenPerScope, count);
    nextId += 1;
    const id = nextId;
    return {
      id,
      scopeKey: s.scopeKey,
      close: async () => {
        open.set(s.scopeKey, (open.get(s.scopeKey) ?? 1) - 1);
        closed.push(id);
      },
    };
  });
  const pool = createScopedSessionPool<FakeSession>({
    startSession,
    idleTimeoutMs: () => IDLE_MS,
    maxLivePools: () => maxLivePools,
    isInfrastructureError: () => false,
  });
  return {
    pool,
    startSession,
    closed,
    maxOpenPerScope: () => maxOpenPerScope,
    openFor: (key: string) => open.get(key) ?? 0,
  };
}

const useSession = (session: FakeSession) => Promise.resolve(session.id);

describe("scoped session pool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses one session per scope until it goes idle", async () => {
    const t = setup();
    expect(await t.pool.withSession(scope("a"), undefined, useSession)).toBe(1);
    expect(await t.pool.withSession(scope("a"), undefined, useSession)).toBe(1);
    expect(t.startSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(t.closed).toEqual([1]);
    expect(t.pool.size()).toBe(0);
  });

  it("never runs two sessions for one scope when work arrives as it idles out", async () => {
    const t = setup();
    await t.pool.withSession(scope("a"), undefined, useSession);

    // Fire the idle timer and immediately ask for the same scope again.
    vi.advanceTimersByTime(IDLE_MS);
    const second = t.pool.withSession(scope("a"), undefined, useSession);
    await vi.advanceTimersByTimeAsync(0);

    expect(await second).toBe(2);
    expect(t.closed).toEqual([1]);
    expect(t.maxOpenPerScope()).toBe(1);
    expect(t.openFor("a")).toBe(1);
    // The retired pool's cleanup must not drop its replacement.
    expect(t.pool.size()).toBe(1);
    expect(await t.pool.withSession(scope("a"), undefined, useSession)).toBe(2);
    expect(t.startSession).toHaveBeenCalledTimes(2);
  });

  it("re-dispatches work queued on a pool that was closed meanwhile", async () => {
    const t = setup();
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = t.pool.withSession(scope("a"), undefined, async (s) => {
      await blocker;
      return s.id;
    });
    const queued = t.pool.withSession(scope("a"), undefined, useSession);
    await vi.advanceTimersByTimeAsync(0);
    const closing = t.pool.closeAll();
    release();

    expect(await first).toBe(1);
    expect(await queued).toBe(2);
    await closing;
    expect(t.pool.size()).toBe(1);
  });

  it("evicts the least-recently-used idle pool past the cap", async () => {
    const t = setup(2);
    await t.pool.withSession(scope("a"), undefined, useSession);
    await vi.advanceTimersByTimeAsync(10);
    await t.pool.withSession(scope("b"), undefined, useSession);
    await vi.advanceTimersByTimeAsync(10);
    await t.pool.withSession(scope("a"), undefined, useSession);
    await vi.advanceTimersByTimeAsync(10);

    await t.pool.withSession(scope("c"), undefined, useSession);
    await vi.advanceTimersByTimeAsync(0);

    expect(t.openFor("b")).toBe(0);
    expect(t.openFor("a")).toBe(1);
    expect(t.openFor("c")).toBe(1);
    expect(t.pool.size()).toBe(2);
  });

  it("does not evict a busy pool", async () => {
    const t = setup(1);
    let release: () => void = () => undefined;
    const busy = t.pool.withSession(scope("a"), undefined, async (s) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return s.id;
    });
    await vi.advanceTimersByTimeAsync(0);

    await t.pool.withSession(scope("b"), undefined, useSession);

    expect(t.openFor("a")).toBe(1);
    expect(t.openFor("b")).toBe(1);
    release();
    expect(await busy).toBe(1);
  });

  it("reset closes the session but keeps the pool usable", async () => {
    const t = setup();
    await t.pool.withSession(scope("a"), undefined, useSession);
    await t.pool.reset("a");
    expect(t.closed).toEqual([1]);
    expect(await t.pool.withSession(scope("a"), undefined, useSession)).toBe(2);
  });
});
