/**
 * What Claude cost, worked out from the "claude-usage" trace events. Pure functions: the
 * routes and the run-end hook feed them rows from the store.
 *
 * Attribution: the server doesn't know which run a Claude call belongs to (usage events carry
 * no run id), so a call is given to a run of its job by time:
 *   1. the run whose window [started_at, ended_at or now] holds the call; else
 *   2. the run that started up to LEAD_WINDOW_MS after the call, if the call came after the
 *      previous run's end (planning and page maps happen just before a run is created); else
 *   3. nobody: "unattributed" (lookups, plans nobody ran).
 */

/** How long before a run starts its planning calls still count as that run's. */
export const LEAD_WINDOW_MS = 10 * 60_000;

/** `runs.ended_at` is stored to the second (sqlite datetime('now')), so a run lasts to its last ms. */
const SECOND_MS = 999;

export interface UsageEvent {
  readonly jobId: string;
  /** ISO-8601 (`2026-11-05T22:50:09.307Z`). */
  readonly ts: string;
  readonly model: string;
  /** Dollars; null when the model's price isn't known. */
  readonly cost: number | null;
}

export interface RunWindow {
  readonly id: string;
  /** Either `YYYY-MM-DD HH:MM:SS` (UTC, as sqlite stores it) or ISO-8601. */
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface ModelSpend {
  readonly model: string;
  readonly costUsd: number;
  readonly calls: number;
}

export interface Spend {
  readonly costUsd: number;
  readonly calls: number;
  readonly unpriced: number;
  readonly byModel: readonly ModelSpend[];
}

/** Milliseconds since the epoch for either timestamp format; NaN when it isn't one. */
export function parseTimestamp(text: string): number {
  const trimmed = text.trim();
  const iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  return Date.parse(hasZone ? iso : `${iso}Z`);
}

export const roundUsd = (value: number): number =>
  Math.round(value * 10_000) / 10_000;

interface Window {
  readonly id: string;
  readonly start: number;
  readonly end: number | null;
}

const windowsOf = (runs: readonly RunWindow[]): Window[] =>
  runs
    .map((run) => ({
      id: run.id,
      start: parseTimestamp(run.startedAt),
      end: run.endedAt === null ? null : parseTimestamp(run.endedAt),
    }))
    .filter((w) => Number.isFinite(w.start))
    .sort((a, b) => a.start - b.start);

const endOf = (w: Window, nowMs: number): number =>
  w.end === null || !Number.isFinite(w.end) ? nowMs : w.end + SECOND_MS;

function runOf(t: number, windows: readonly Window[], nowMs: number): string | null {
  // Latest-starting first, so a call inside two overlapping runs goes to the newer one.
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i] as Window;
    if (t >= w.start && t <= endOf(w, nowMs)) return w.id;
  }
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i] as Window;
    const previous = windows[i - 1];
    const inLead = t < w.start && t >= w.start - LEAD_WINDOW_MS;
    if (inLead && (!previous || t > endOf(previous, nowMs))) return w.id;
  }
  return null;
}

/** The run (of the job's `runs`) each event belongs to; null for unattributed ones. */
export function attributeUsage<E extends UsageEvent>(
  events: readonly E[],
  runs: readonly RunWindow[],
  nowMs: number,
): { readonly event: E; readonly runId: string | null }[] {
  const windows = windowsOf(runs);
  return events.map((event) => ({
    event,
    runId: runOf(parseTimestamp(event.ts), windows, nowMs),
  }));
}

/** Totals for some events; money to 4 decimals, an unpriced call counts as $0 and is counted. */
export function summarize(events: readonly UsageEvent[]): Spend {
  const models = new Map<string, { cost: number; calls: number }>();
  for (const e of events) {
    const seen = models.get(e.model) ?? { cost: 0, calls: 0 };
    models.set(e.model, { cost: seen.cost + (e.cost ?? 0), calls: seen.calls + 1 });
  }
  const total = events.reduce((sum, e) => sum + (e.cost ?? 0), 0);
  return {
    costUsd: roundUsd(total),
    calls: events.length,
    unpriced: events.filter((e) => e.cost === null).length,
    byModel: [...models.entries()]
      .map(([model, v]) => ({ model, costUsd: roundUsd(v.cost), calls: v.calls }))
      .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model)),
  };
}

/** What one run cost: the events of its job attributed to it. */
export function runSpend(
  runId: string,
  events: readonly UsageEvent[],
  runs: readonly RunWindow[],
  nowMs: number,
): Spend {
  return summarize(
    attributeUsage(events, runs, nowMs)
      .filter((a) => a.runId === runId)
      .map((a) => a.event),
  );
}

/** Events at or after `since` (an ISO date or time; compared as text, both are UTC ISO). */
export const eventsSince = <E extends UsageEvent>(
  events: readonly E[],
  from: string,
): E[] => events.filter((e) => e.ts >= from);

/** UTC calendar day and month prefixes of `nowMs` ("2026-11-05", "2026-11"). */
export function utcPeriods(nowMs: number): { day: string; month: string } {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

export interface CreditSetting {
  readonly amountUsd: number;
  readonly asOf: string;
}

export interface SpendSummary {
  readonly totalUsd: number;
  readonly monthUsd: number;
  readonly todayUsd: number;
  readonly calls: number;
  readonly unpriced: number;
  readonly byModel: readonly { model: string; usd: number; calls: number }[];
  /** When the first Claude call was recorded (older ones are pruned from the trace). */
  readonly since: string | null;
  readonly credit: null | {
    readonly amountUsd: number;
    readonly asOf: string;
    readonly spentSinceUsd: number;
    readonly remainingUsd: number;
  };
}

/** Everything one user spent on Claude, from all their usage events (oldest first). */
export function summaryOf(
  events: readonly UsageEvent[],
  credit: CreditSetting | null,
  nowMs: number,
): SpendSummary {
  const { day, month } = utcPeriods(nowMs);
  const total = summarize(events);
  const spent = (list: readonly UsageEvent[]) => summarize(list).costUsd;
  const spentSince = credit ? spent(eventsSince(events, credit.asOf)) : 0;
  return {
    totalUsd: total.costUsd,
    monthUsd: spent(events.filter((e) => e.ts.startsWith(month))),
    todayUsd: spent(events.filter((e) => e.ts.startsWith(day))),
    calls: total.calls,
    unpriced: total.unpriced,
    byModel: total.byModel.map((m) => ({ model: m.model, usd: m.costUsd, calls: m.calls })),
    since: events.reduce<string | null>((min, e) => (min === null || e.ts < min ? e.ts : min), null),
    credit: credit
      ? {
          amountUsd: credit.amountUsd,
          asOf: credit.asOf,
          spentSinceUsd: spentSince,
          remainingUsd: roundUsd(credit.amountUsd - spentSince),
        }
      : null,
  };
}
