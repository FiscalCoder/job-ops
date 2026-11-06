import type { ClaudeSummary } from "../../src/lib/api";
import { dollars } from "./run-cost";

/** Settings: "Spent: $X total · $Y this month · ≈$Z left (estimate)". */

/** Under this many dollars left, the line turns amber. */
export const LOW_CREDIT_USD = 2;

export function isLowCredit(summary: ClaudeSummary): boolean {
  return !!summary.credit && summary.credit.remainingUsd < LOW_CREDIT_USD;
}

/** Today as yyyy-mm-dd in local time, the value a date input expects. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function spentText(summary: ClaudeSummary): string {
  const left = summary.credit
    ? ` · ≈${dollars(Math.max(0, summary.credit.remainingUsd))} left (estimate)`
    : "";
  const unpriced = summary.unpriced ? ` (${summary.unpriced} calls unpriced)` : "";
  return `Spent: ${dollars(summary.totalUsd)} total · ${dollars(summary.monthUsd)} this month${left}${unpriced}`;
}

/** The credit amount as typed ("12.5"): null when it isn't a number from 0 to 100000. */
export function parseCredit(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 100_000
    ? value
    : null;
}
