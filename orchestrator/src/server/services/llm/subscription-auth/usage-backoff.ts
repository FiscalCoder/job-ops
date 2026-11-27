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

/**
 * After a usage limit survives the backoff retry, the subscription is treated
 * as exhausted until its reset: calls skip it (straight to the fallbacks) and
 * scoring stops early, leaving jobs for a catch-up run after the reset.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Claude's window is five hours; without a parsed reset, assume a full one. */
export const DEFAULT_USAGE_EXHAUSTED_MS = 5 * HOUR_MS;
/** Weekly limits can reset days later; anything further out is not trusted. */
const MAX_RESET_AHEAD_MS = 8 * DAY_MS;

const exhaustedUntil = new Map<string, number>();

export function markUsageExhausted(key: string, untilMs: number): void {
  const existing = exhaustedUntil.get(key) ?? 0;
  exhaustedUntil.set(key, Math.max(existing, untilMs));
}

export function getUsageExhaustedUntil(
  key: string,
  now: number = Date.now(),
): number | null {
  const until = exhaustedUntil.get(key);
  if (until === undefined) return null;
  if (until <= now) {
    exhaustedUntil.delete(key);
    return null;
  }
  return until;
}

const UTC_ZONES = new Set(["utc", "etc/utc", "gmt", "etc/gmt", "z"]);

/** Offset of `timeZone` from UTC at `atMs`, or null for an unknown zone. */
function zoneOffsetMs(timeZone: string, atMs: number): number | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(atMs))
        .map((part) => [part.type, part.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return asUtc - Math.floor(atMs / 1000) * 1000;
  } catch {
    return null;
  }
}

/** Next time the clock in `timeZone` shows hour:minute, after `now`. */
function nextClockTime(
  hour: number,
  minute: number,
  timeZone: string | null,
  now: number,
): number | null {
  const zone = timeZone?.trim() ?? "";
  const offset =
    !zone || UTC_ZONES.has(zone.toLowerCase()) ? 0 : zoneOffsetMs(zone, now);
  if (offset === null) return null;
  const local = new Date(now + offset);
  let candidate =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      hour,
      minute,
    ) - offset;
  if (candidate <= now) candidate += DAY_MS;
  return candidate;
}

/**
 * When the CLI says the limit resets: "usage limit reached|1764370800",
 * "resets 3am (UTC)", "resets at 3:30pm (Asia/Kolkata)", "try again in 2h 5m".
 * Null when no reset is stated or it can't be read reliably.
 */
export function parseUsageResetAt(
  text: string,
  now: number = Date.now(),
): number | null {
  const accept = (at: number | null) =>
    at !== null && at > now && at - now <= MAX_RESET_AHEAD_MS ? at : null;

  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch?.[1]) return accept(Number(epoch[1]) * 1000);

  const relative = text.match(
    /\b(?:try again|resets?)\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i,
  );
  if (relative && (relative[1] || relative[2])) {
    const hours = Number(relative[1] ?? 0);
    const minutes = Number(relative[2] ?? 0);
    return accept(now + hours * HOUR_MS + minutes * 60_000);
  }

  const clock = text.match(
    /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i,
  );
  if (clock?.[1] && clock[3]) {
    const hour12 = Number(clock[1]) % 12;
    const hour = clock[3].toLowerCase() === "pm" ? hour12 + 12 : hour12;
    const minute = Number(clock[2] ?? 0);
    if (hour > 23 || minute > 59) return null;
    return accept(nextClockTime(hour, minute, clock[4] ?? null, now));
  }
  return null;
}

export function __resetUsageBackoffForTests(): void {
  backoffUntil.clear();
  exhaustedUntil.clear();
}

export function __usageBackoffSizeForTests(): number {
  return backoffUntil.size;
}
