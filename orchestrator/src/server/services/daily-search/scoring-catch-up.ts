import { logger } from "@infra/logger";

/**
 * Fork: when a run stops scoring because the user's subscription is out of
 * usage, the unscored jobs stay in the database and one catch-up run of the
 * user's saved daily search is scheduled shortly after the usage resets, so
 * they are scored and the best ones selected without waiting for the next
 * daily run. In-memory only: after a restart the next daily run picks them up.
 */
export type CatchUpOwner = Readonly<{
  tenantId: string;
  userId: string | null;
}>;

export type CatchUpOutcome = "started" | "busy" | "no-preset";

export type CatchUpDeps = {
  startRun: (owner: CatchUpOwner) => Promise<CatchUpOutcome>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
};

/** Start a little after the reset so the first call isn't refused again. */
const RESET_MARGIN_MS = 5 * 60_000;
const MIN_DELAY_MS = 60_000;
/** A run already in progress for the owner: look again later. */
const BUSY_RETRY_MS = 15 * 60_000;

const pending = new Set<string>();

function ownerKey(owner: CatchUpOwner): string {
  return JSON.stringify([owner.tenantId, owner.userId]);
}

async function defaultStartRun(owner: CatchUpOwner): Promise<CatchUpOutcome> {
  // Imported lazily: the scheduler imports the pipeline, which imports the
  // scoring step that calls this module.
  const { startDailySearchForOwner } = await import("./scheduler");
  return startDailySearchForOwner(owner);
}

const defaultDeps: CatchUpDeps = {
  startRun: defaultStartRun,
  now: Date.now,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
};

/** Schedule one catch-up run per owner; later requests while one waits are ignored. */
export function scheduleScoringCatchUp(
  owner: CatchUpOwner,
  resumeAtMs: number,
  deps: CatchUpDeps = defaultDeps,
): boolean {
  const key = ownerKey(owner);
  if (pending.has(key)) return false;
  pending.add(key);
  const delayMs = Math.max(
    MIN_DELAY_MS,
    resumeAtMs + RESET_MARGIN_MS - deps.now(),
  );
  deps.setTimer(() => {
    pending.delete(key);
    void fireCatchUp(owner, deps);
  }, delayMs);
  logger.info("Scoring catch-up scheduled after subscription usage reset", {
    tenantId: owner.tenantId,
    runAt: new Date(deps.now() + delayMs).toISOString(),
  });
  return true;
}

async function fireCatchUp(
  owner: CatchUpOwner,
  deps: CatchUpDeps,
): Promise<void> {
  try {
    const outcome = await deps.startRun(owner);
    logger.info("Scoring catch-up run", {
      tenantId: owner.tenantId,
      outcome,
    });
    if (outcome === "busy") {
      scheduleScoringCatchUp(owner, deps.now() + BUSY_RETRY_MS, deps);
    }
  } catch (error) {
    logger.warn("Scoring catch-up run could not start", {
      tenantId: owner.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function __resetScoringCatchUpForTests(): void {
  pending.clear();
}
