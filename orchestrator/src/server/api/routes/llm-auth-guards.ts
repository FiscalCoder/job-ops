/**
 * Fork: small in-memory guards for the per-user subscription-login routes.
 * State is per process (one Job Ops server), keyed by the caller's CLI auth
 * scope key; nothing here is persisted.
 */
type Clock = () => number;

export type ScopeRateLimiter = Readonly<{
  /** Records a request; returns ms until allowed again, or null if allowed. */
  hit: (key: string) => number | null;
  size: () => number;
}>;

type Window = Readonly<{ startedAt: number; count: number }>;

export function createScopeRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: Clock;
}): ScopeRateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  const prune = (current: number) => {
    for (const [key, window] of windows) {
      if (current - window.startedAt >= options.windowMs) windows.delete(key);
    }
  };

  return {
    hit: (key) => {
      const current = now();
      prune(current);
      const window = windows.get(key) ?? { startedAt: current, count: 0 };
      if (window.count >= options.limit) {
        return window.startedAt + options.windowMs - current;
      }
      windows.set(key, { ...window, count: window.count + 1 });
      return null;
    },
    size: () => windows.size,
  };
}

export type TestRunAdmission =
  | Readonly<{ ok: true; release: () => void }>
  | Readonly<{ ok: false; reason: "in_flight" }>
  | Readonly<{ ok: false; reason: "cooldown"; retryAfterMs: number }>;

export type TestRunGuard = Readonly<{
  begin: (key: string) => TestRunAdmission;
}>;

/** One billable test call per scope at a time, then a cooldown from its start. */
export function createTestRunGuard(options: {
  cooldownMs: number;
  now?: Clock;
}): TestRunGuard {
  const now = options.now ?? Date.now;
  const inFlight = new Set<string>();
  const lastStartedAt = new Map<string, number>();

  return {
    begin: (key) => {
      if (inFlight.has(key)) return { ok: false, reason: "in_flight" };
      const current = now();
      for (const [other, startedAt] of lastStartedAt) {
        if (current - startedAt >= options.cooldownMs) {
          lastStartedAt.delete(other);
        }
      }
      const previous = lastStartedAt.get(key);
      if (previous !== undefined) {
        return {
          ok: false,
          reason: "cooldown",
          retryAfterMs: previous + options.cooldownMs - current,
        };
      }
      inFlight.add(key);
      lastStartedAt.set(key, current);
      return { ok: true, release: () => inFlight.delete(key) };
    },
  };
}

export function toRetryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
