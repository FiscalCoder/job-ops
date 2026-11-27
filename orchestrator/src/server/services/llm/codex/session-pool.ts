import { logger } from "@infra/logger";
import type { CliAuthScope } from "../subscription-auth/scope";

/**
 * Fork: one long-lived CLI session per Job Ops user (scope), each with its
 * own operation queue and idle shutdown. Invariants:
 *  - at most one live session per scope: a replacement pool queues behind
 *    the pool it replaces, so a new app-server only starts after the old one
 *    has closed (Codex rewrites auth.json; two servers on one CODEX_HOME
 *    would race);
 *  - a closed pool is never reused; work that reaches one is re-dispatched;
 *  - a pool is removed from the map only by itself (`pools.get(key) === pool`);
 *  - beyond `maxLivePools`, the least-recently-used idle pool is closed.
 */
export type PoolSession = { close: () => Promise<void> };

export type ScopedSessionPoolOptions<S extends PoolSession> = {
  startSession: (scope: CliAuthScope, signal?: AbortSignal) => Promise<S>;
  idleTimeoutMs: () => number;
  maxLivePools: () => number;
  isInfrastructureError: (error: unknown) => boolean;
  now?: () => number;
};

export type ScopedSessionPool<S extends PoolSession> = {
  withSession: <T>(
    scope: CliAuthScope,
    signal: AbortSignal | undefined,
    task: (session: S) => Promise<T>,
  ) => Promise<T>;
  reset: (scopeKey: string) => Promise<void>;
  closeAll: () => Promise<void>;
  size: () => number;
};

const REDISPATCH = Symbol("redispatch");

type Pool<S> = {
  key: string;
  scope: CliAuthScope;
  session: S | null;
  startupPromise: Promise<S> | null;
  idleTimer: NodeJS.Timeout | null;
  tail: Promise<void>;
  pending: number;
  lastUsedAt: number;
  closed: boolean;
};

export function createScopedSessionPool<S extends PoolSession>(
  options: ScopedSessionPoolOptions<S>,
): ScopedSessionPool<S> {
  const pools = new Map<string, Pool<S>>();
  const now = options.now ?? Date.now;

  function enqueue<T>(pool: Pool<S>, task: () => Promise<T>): Promise<T> {
    pool.pending += 1;
    const run = pool.tail.then(task, task).finally(() => {
      pool.pending -= 1;
    });
    pool.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function clearIdleTimer(pool: Pool<S>): void {
    if (pool.idleTimer) clearTimeout(pool.idleTimer);
    pool.idleTimer = null;
  }

  async function resetSession(pool: Pool<S>): Promise<void> {
    clearIdleTimer(pool);
    const session = pool.session;
    pool.session = null;
    if (session) await session.close();
  }

  function closePool(pool: Pool<S>): void {
    if (pool.closed) return;
    pool.closed = true;
    clearIdleTimer(pool);
    void enqueue(pool, async () => {
      await resetSession(pool);
      if (pools.get(pool.key) === pool) pools.delete(pool.key);
    });
  }

  function scheduleIdleClose(pool: Pool<S>): void {
    clearIdleTimer(pool);
    const idleTimeoutMs = options.idleTimeoutMs();
    if (idleTimeoutMs <= 0) return;
    pool.idleTimer = setTimeout(() => {
      pool.idleTimer = null;
      if (pool.pending === 0) closePool(pool);
    }, idleTimeoutMs);
    pool.idleTimer.unref?.();
  }

  function evictLeastRecentlyUsedIdle(exceptKey: string): void {
    const live = [...pools.values()].filter((pool) => !pool.closed);
    if (live.length < options.maxLivePools()) return;
    const idle = live
      .filter((pool) => pool.pending === 0 && pool.key !== exceptKey)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const victim = idle[0];
    if (victim) {
      closePool(victim);
      return;
    }
    logger.warn("Codex app-server cap reached with every server busy", {
      live: live.length,
    });
  }

  function acquirePool(scope: CliAuthScope): Pool<S> {
    const existing = pools.get(scope.scopeKey);
    if (existing && !existing.closed) return existing;
    evictLeastRecentlyUsedIdle(scope.scopeKey);
    const created: Pool<S> = {
      key: scope.scopeKey,
      scope,
      session: null,
      startupPromise: null,
      idleTimer: null,
      // Queue behind the retiring pool so its session closes first.
      tail: existing?.tail ?? Promise.resolve(),
      pending: 0,
      lastUsedAt: now(),
      closed: false,
    };
    pools.set(scope.scopeKey, created);
    return created;
  }

  async function getOrStartSession(
    pool: Pool<S>,
    signal?: AbortSignal,
  ): Promise<S> {
    if (pool.session) return pool.session;
    if (pool.startupPromise) return await pool.startupPromise;
    pool.startupPromise = options.startSession(pool.scope, signal);
    try {
      const session = await pool.startupPromise;
      pool.session = session;
      return session;
    } finally {
      pool.startupPromise = null;
    }
  }

  async function withSession<T>(
    scope: CliAuthScope,
    signal: AbortSignal | undefined,
    task: (session: S) => Promise<T>,
  ): Promise<T> {
    const pool = acquirePool(scope);
    const result = await enqueue(pool, async () => {
      // Closed while this task waited: retry outside this queue (retrying
      // inside it would deadlock behind the replacement pool).
      if (pool.closed) return REDISPATCH;
      clearIdleTimer(pool);
      pool.lastUsedAt = now();
      try {
        return await task(await getOrStartSession(pool, signal));
      } catch (error) {
        if (options.isInfrastructureError(error)) await resetSession(pool);
        throw error;
      } finally {
        pool.lastUsedAt = now();
        scheduleIdleClose(pool);
      }
    });
    return result === REDISPATCH
      ? await withSession(scope, signal, task)
      : result;
  }

  async function reset(scopeKey: string): Promise<void> {
    const pool = pools.get(scopeKey);
    if (!pool) return;
    await enqueue(pool, () => resetSession(pool));
  }

  async function closeAll(): Promise<void> {
    const all = [...pools.values()];
    pools.clear();
    for (const pool of all) {
      pool.closed = true;
      clearIdleTimer(pool);
    }
    await Promise.all(
      all.map((pool) => enqueue(pool, () => resetSession(pool))),
    );
  }

  return { withSession, reset, closeAll, size: () => pools.size };
}
