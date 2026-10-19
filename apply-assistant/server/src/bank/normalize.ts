import { format, isValid, parse } from "date-fns";
import type { BankKind } from "./catalogue.js";
import { splitList } from "./catalogue.js";

/**
 * Checks and tidies an answer-bank value when you save it, so the planner always gets one
 * format per kind (see BankKind). Lenient on input ("30 LPA", "1 month", "20/11/2026"),
 * strict on output.
 */

export type Normalized =
  | { ok: true; value: string }
  | { ok: false; error: string };

export interface NormalizeOptions {
  /** Currency assumed for a bare amount (from your current country). */
  readonly defaultCurrency?: string | null;
}

const MAX_NOTICE_DAYS = 365;

const okValue = (value: string): Normalized => ({ ok: true, value });
const fail = (error: string): Normalized => ({ ok: false, error });

const DATE_FORMATS = [
  "yyyy-MM-dd",
  "dd/MM/yyyy",
  "dd-MM-yyyy",
  "d MMM yyyy",
  "d MMMM yyyy",
  "MMMM d, yyyy",
  "MMM d, yyyy",
];
const REFERENCE_DATE = new Date(2000, 0, 1);

function normalizeDate(raw: string): Normalized {
  for (const pattern of DATE_FORMATS) {
    const date = parse(raw, pattern, REFERENCE_DATE);
    if (isValid(date) && date.getFullYear() > 1900)
      return okValue(format(date, "yyyy-MM-dd"));
  }
  return fail("Use a date like 2026-12-01 (YYYY-MM-DD)");
}

function normalizeDays(raw: string): Normalized {
  const text = raw.toLowerCase();
  if (/^(immediate(ly)?|now|asap|0)$/.test(text)) return okValue("0");
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(days?|d|weeks?|w|months?|m)?$/);
  if (!match)
    return fail("Use a number of days, e.g. 30 (or '1 month', 'immediate')");
  const n = Number(match[1]);
  const unit = match[2] ?? "days";
  const days = unit.startsWith("w") ? n * 7 : unit.startsWith("m") ? n * 30 : n;
  if (!Number.isInteger(days) || days > MAX_NOTICE_DAYS)
    return fail(`Use whole days between 0 and ${MAX_NOTICE_DAYS}`);
  return okValue(String(days));
}

function normalizeNumber(raw: string): Normalized {
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*\+?\s*(years?|yrs?)?$/i);
  return match
    ? okValue(String(Number(match[1])))
    : fail("Use a number, e.g. 6");
}

const CURRENCY_CODES =
  "INR|EUR|USD|GBP|SGD|JPY|SEK|DKK|NOK|CHF|AED|PLN|CAD|AUD";
const CURRENCY_CODE = new RegExp(
  `^(${CURRENCY_CODES})\\b\\s*|\\s*\\b(${CURRENCY_CODES})$`,
  "i",
);

const SYMBOLS: Record<string, string> = {
  "₹": "INR",
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
};
const MULTIPLIERS: readonly [RegExp, number][] = [
  [/^(lpa|lakhs?|lacs?|l)$/, 100_000],
  [/^(cr|crores?)$/, 10_000_000],
  [/^k$/, 1_000],
  [/^(m|mn|million)$/, 1_000_000],
];

export interface Money {
  readonly currency: string;
  readonly amount: number;
}

/** Reads "INR 3000000" (the stored form). */
export function parseMoney(value: string): Money | null {
  const match = value.match(/^([A-Z]{3}) (\d+)$/);
  return match
    ? { currency: match[1] as string, amount: Number(match[2]) }
    : null;
}

function normalizeMoney(raw: string, options: NormalizeOptions): Normalized {
  let text = raw.trim();
  let currency: string | null = null;
  const code = text.match(CURRENCY_CODE);
  if (code) {
    currency = (code[1] ?? code[2] ?? "").toUpperCase();
    text = text.replace(code[0], "");
  }
  const symbol = Object.keys(SYMBOLS).find((s) => text.includes(s));
  if (symbol) {
    currency = SYMBOLS[symbol] ?? currency;
    text = text.replace(symbol, "");
  }
  const match = text.trim().match(/^([\d,]+(?:\.\d+)?)\s*([a-z]*)$/i);
  if (!match)
    return fail("Use a currency and yearly amount, e.g. INR 3000000 or 30 LPA");
  const base = Number((match[1] ?? "").replace(/,/g, ""));
  const suffix = (match[2] ?? "").toLowerCase();
  const multiplier = suffix
    ? MULTIPLIERS.find(([p]) => p.test(suffix))?.[1]
    : 1;
  if (multiplier === undefined || !Number.isFinite(base))
    return fail("Use a currency and yearly amount, e.g. INR 3000000 or 30 LPA");
  if (/^(lpa|lakhs?|lacs?|l|cr|crores?)$/.test(suffix)) currency ??= "INR";
  currency ??= options.defaultCurrency ?? null;
  if (!currency) return fail("Add a currency, e.g. INR 3000000");
  return okValue(`${currency} ${Math.round(base * multiplier)}`);
}

export function normalizeAnswer(
  kind: BankKind,
  raw: string,
  options: NormalizeOptions = {},
): Normalized {
  const value = raw.trim().replace(/[ \t]+/g, " ");
  if (!value) return okValue("");
  switch (kind) {
    case "text":
      return okValue(value);
    case "yesno":
      if (/^(y|yes|true)$/i.test(value)) return okValue("Yes");
      if (/^(n|no|false)$/i.test(value)) return okValue("No");
      return fail("Answer Yes or No");
    case "list": {
      const seen = new Set<string>();
      const items = splitList(value).filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return okValue(items.join(", "));
    }
    case "date":
      return normalizeDate(value);
    case "days":
      return normalizeDays(value);
    case "number":
      return normalizeNumber(value);
    case "money":
      return normalizeMoney(value, options);
  }
}
