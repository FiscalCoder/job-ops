/**
 * Server-side posting-age parsing. Sources report `datePosted` either as an
 * ISO-ish timestamp or as a relative phrase such as "3 days ago".
 */

const MS_PER_DAY = 86_400_000;

function parseAbsoluteDate(value: string): Date | null {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseRelativeAgeDays(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (/\b(today|just now)\b/.test(normalized)) return 0;
  if (/\byesterday\b/.test(normalized)) return 1;

  const match = /(\d+)\+?\s*(minute|hour|day|week|month|year)s?\s+ago\b/.exec(
    normalized,
  );
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(amount)) return null;

  switch (match[2]) {
    case "minute":
    case "hour":
      return 0;
    case "day":
      return amount;
    case "week":
      return amount * 7;
    case "month":
      return amount * 30;
    case "year":
      return amount * 365;
    default:
      return null;
  }
}

/**
 * Age of a posting in whole days, or null when the source gave no usable date.
 */
export function getPostingAgeDays(
  datePosted: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const raw = datePosted?.trim();
  if (!raw) return null;

  const absolute = parseAbsoluteDate(raw);
  if (absolute) {
    return Math.max(
      0,
      Math.floor((now.getTime() - absolute.getTime()) / MS_PER_DAY),
    );
  }

  return parseRelativeAgeDays(raw);
}

/**
 * Split postings into those fresh enough to keep and those past the age limit.
 * Postings without a usable date are kept: absence of a date is not staleness.
 */
export function partitionByPostingAge<T extends { datePosted?: string | null }>(
  jobs: readonly T[],
  maxAgeDays: number,
  now: Date = new Date(),
): { fresh: T[]; stale: T[] } {
  if (maxAgeDays <= 0) return { fresh: [...jobs], stale: [] };

  const fresh: T[] = [];
  const stale: T[] = [];
  for (const job of jobs) {
    const ageDays = getPostingAgeDays(job.datePosted, now);
    if (ageDays !== null && ageDays > maxAgeDays) {
      stale.push(job);
    } else {
      fresh.push(job);
    }
  }
  return { fresh, stale };
}
