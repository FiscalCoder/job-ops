/**
 * Internship length helpers shared by the internship board extractors
 * (Internshala, Unstop, Foundit).
 *
 * A tenant picks the lengths it wants with the `internshipDurationMonths`
 * setting, e.g. "2-3" or "3". Postings whose length is known and outside that
 * range are skipped; postings that don't state a length are kept for scoring.
 */

export interface MonthRange {
  minMonths: number;
  maxMonths: number;
}

export const INTERNSHIP_DURATION_SETTING_KEY = "internshipDurationMonths";

const WEEKS_PER_MONTH = 4.345;
/** "8 weeks" (1.84 months) still counts as two months. */
const MONTH_TOLERANCE = 0.25;
const MAX_REASONABLE_MONTHS = 36;

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const RANGE_SEPARATOR = String.raw`\s*(?:-|–|—|to)\s*`;
const UNIT = "(months?|mos?|weeks?|wks?)";
const LENGTH = `${NUMBER}(?:${RANGE_SEPARATOR}${NUMBER})?\\s*-?\\s*${UNIT}\\b`;

/** A bare length such as "3 Months" or "6 Weeks" (Internshala's card field). */
const BARE_LENGTH = new RegExp(`^\\s*${LENGTH}\\s*$`, "i");

/**
 * Lengths stated about the internship itself in free text. "6 months of
 * experience" or "a 6 month PPO review" are not matched.
 */
const DESCRIPTION_LENGTHS: readonly RegExp[] = [
  new RegExp(
    `duration\\s*(?:of the internship)?\\s*[:\\-–]?\\s*(?:is\\s*)?(?:of\\s*)?${LENGTH}`,
    "i",
  ),
  new RegExp(
    `${LENGTH}\\s*(?:long\\s*|paid\\s*|unpaid\\s*|full[- ]time\\s*|part[- ]time\\s*)?internship`,
    "i",
  ),
  new RegExp(
    `internship\\s*(?:of|for|lasting|is for)\\s*(?:a period of\\s*)?${LENGTH}`,
    "i",
  ),
  new RegExp(
    `(?:available|period)\\s*(?:for|of)\\s*(?:a\\s*)?(?:duration of\\s*)?${LENGTH}`,
    "i",
  ),
  // A title such as "Digital Marketing Intern (3 months - unpaid)".
  new RegExp(`intern(?:ship)?\\s*[(\\[|–-]\\s*${LENGTH}`, "i"),
];

function toMonths(amount: number, unit: string): number {
  return unit.toLowerCase().startsWith("w") ? amount / WEEKS_PER_MONTH : amount;
}

function rangeFromMatch(match: RegExpExecArray): MonthRange | null {
  const first = Number.parseFloat(match[1] ?? "");
  const second = match[2] ? Number.parseFloat(match[2]) : first;
  const unit = match[3] ?? "";
  if (!Number.isFinite(first) || !Number.isFinite(second) || !unit) return null;
  const minMonths = toMonths(Math.min(first, second), unit);
  const maxMonths = toMonths(Math.max(first, second), unit);
  if (minMonths <= 0 || maxMonths > MAX_REASONABLE_MONTHS) return null;
  return { minMonths, maxMonths };
}

/** Reads a bare length field such as "3 Months", "6 Weeks" or "2-3 months". */
export function parseDurationField(
  value: string | null | undefined,
): MonthRange | null {
  const match = value ? BARE_LENGTH.exec(value) : null;
  return match ? rangeFromMatch(match) : null;
}

/** Finds the internship's stated length in a title or description, if any. */
export function findDurationInText(
  text: string | null | undefined,
): MonthRange | null {
  if (!text) return null;
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
  for (const pattern of DESCRIPTION_LENGTHS) {
    const match = pattern.exec(plain);
    const range = match ? rangeFromMatch(match) : null;
    if (range) return range;
  }
  return null;
}

/**
 * Parses the `internshipDurationMonths` setting: "2-3", "2 - 3", "3" or "2-".
 * Returns null when unset or unreadable, which means "any length".
 */
export function parseDurationSetting(
  value: string | null | undefined,
): MonthRange | null {
  const raw = value?.trim();
  if (!raw) return null;
  const match = /^(\d+(?:\.\d+)?)?\s*(?:(-|–|to)\s*(\d+(?:\.\d+)?)?)?$/.exec(
    raw,
  );
  if (!match) return null;
  const first = match[1] ? Number.parseFloat(match[1]) : null;
  const hasSeparator = Boolean(match[2]);
  const second = match[3] ? Number.parseFloat(match[3]) : null;

  if (first === null && second === null) return null;
  if (!hasSeparator && first !== null) {
    return { minMonths: first, maxMonths: first };
  }
  const minMonths = first ?? 0;
  const maxMonths = second ?? MAX_REASONABLE_MONTHS;
  if (minMonths > maxMonths) return null;
  return { minMonths, maxMonths };
}

/**
 * True when the posting's length fits the wanted range, or when either is
 * unknown (an unstated length is left for the scorer to judge).
 */
export function durationFits(
  duration: MonthRange | null,
  wanted: MonthRange | null,
): boolean {
  if (!duration || !wanted) return true;
  return (
    duration.maxMonths >= wanted.minMonths - MONTH_TOLERANCE &&
    duration.minMonths <= wanted.maxMonths + MONTH_TOLERANCE
  );
}

function formatAmount(months: number): string {
  const rounded = Math.round(months * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "3 months", "2-3 months" or "6 weeks" for job type labels. */
export function formatDuration(duration: MonthRange): string {
  if (duration.maxMonths < 1.5) {
    const weeks = Math.round(duration.maxMonths * WEEKS_PER_MONTH);
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  const min = formatAmount(duration.minMonths);
  const max = formatAmount(duration.maxMonths);
  const span = min === max ? max : `${min}-${max}`;
  return `${span} month${span === "1" ? "" : "s"}`;
}
