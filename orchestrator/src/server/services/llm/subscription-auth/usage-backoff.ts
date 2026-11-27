/**
 * When a subscription CLI reports a usage limit, every call for that user +
 * provider waits out one shared backoff window before its single retry, so a
 * scoring batch doesn't keep hammering a limited subscription.
 */
const DEFAULT_BACKOFF_MS = 60_000;

const backoffUntil = new Map<string, number>();

export type UsageBackoffDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number;
};

export function getUsageBackoffMs(): number {
  const parsed = Number.parseInt(
    process.env.JOBOPS_CLI_USAGE_LIMIT_BACKOFF_MS?.trim() ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BACKOFF_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function pruneExpired(current: number): void {
  for (const [key, until] of backoffUntil) {
    if (until <= current) backoffUntil.delete(key);
  }
}

export async function waitForUsageBackoff(
  key: string,
  deps: UsageBackoffDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const current = now();
  pruneExpired(current);
  const existing = backoffUntil.get(key);
  const until =
    existing !== undefined && existing > current
      ? existing
      : current + (deps.backoffMs ?? getUsageBackoffMs());
  backoffUntil.set(key, until);
  const waitMs = Math.max(0, until - current);
  if (waitMs > 0) await sleep(waitMs);
}

export function __resetUsageBackoffForTests(): void {
  backoffUntil.clear();
}

export function __usageBackoffSizeForTests(): number {
  return backoffUntil.size;
}
