import type { RunCost } from "../../src/lib/api";

/** The run card's "Claude: $0.077 · 23 calls" line, kept up to date while the run is live. */

/** How often the line is refreshed while the run is live and the panel is visible. */
export const RUN_COST_POLL_MS = 5_000;

/** "$0.077" under a dollar, "$1.23" above: enough to tell cents from tenths of a cent. */
export function dollars(amount: number): string {
  return `$${amount < 1 ? amount.toFixed(3) : amount.toFixed(2)}`;
}

export function formatRunCost(cost: Pick<RunCost, "costUsd" | "calls" | "unpriced">): string {
  if (cost.calls === 0) return "Claude: not used on this run";
  const calls = `${cost.calls} ${cost.calls === 1 ? "call" : "calls"}`;
  const unpriced = cost.unpriced ? ` (${cost.unpriced} unpriced)` : "";
  return `Claude: ${dollars(cost.costUsd)} · ${calls}${unpriced}`;
}

export interface RunCostEnv {
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (id: unknown) => void;
  readonly visible: () => boolean;
}

const browserEnv: RunCostEnv = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  visible: () => document.visibilityState !== "hidden",
};

export interface RunSpend {
  readonly element: HTMLElement;
  /** Call on every redraw of the run: starts polling for a live run, asks once more at its end. */
  track(runId: string, finished: boolean): void;
  stop(): void;
}

export function createRunSpend(
  fetchCost: (runId: string) => Promise<RunCost>,
  env: RunCostEnv = browserEnv,
): RunSpend {
  const element = document.createElement("p");
  element.className = "muted";
  element.hidden = true;
  let timer: unknown = null;
  let current: string | null = null;
  let loading = false;
  let settled = false;
  let again = false;

  const refresh = async (runId: string) => {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const cost = await fetchCost(runId);
      if (runId !== current) return;
      element.textContent = formatRunCost(cost);
      element.hidden = false;
    } catch {
      // The line is a nicety: keep what it showed, try again at the next tick.
    } finally {
      loading = false;
      if (again) {
        again = false;
        if (current) void refresh(current);
      }
    }
  };

  const stop = () => {
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  };

  return {
    element,
    stop,
    track(runId, finished) {
      if (runId !== current) {
        stop();
        current = runId;
        settled = false;
        element.hidden = true;
      }
      if (finished) {
        stop();
        if (!settled) {
          settled = true;
          void refresh(runId);
        }
        return;
      }
      if (timer !== null || settled) return;
      void refresh(runId);
      timer = env.setInterval(() => {
        if (env.visible() && current) void refresh(current);
      }, RUN_COST_POLL_MS);
    },
  };
}
