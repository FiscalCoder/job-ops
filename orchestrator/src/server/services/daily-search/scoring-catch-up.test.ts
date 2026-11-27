import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetScoringCatchUpForTests,
  type CatchUpDeps,
  scheduleScoringCatchUp,
} from "./scoring-catch-up";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOW = Date.UTC(2026, 10, 27, 19, 0);
const OWNER = { tenantId: "tenant-a", userId: "user-1" };

function makeDeps(outcomes: Array<"started" | "busy" | "no-preset">) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const startRun = vi.fn(async () => outcomes.shift() ?? "started");
  const deps: CatchUpDeps = {
    startRun,
    now: () => NOW,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return null;
    },
  };
  return { deps, timers, startRun };
}

async function fire(timers: Array<{ fn: () => void }>): Promise<void> {
  timers.shift()?.fn();
  await new Promise((resolve) => setImmediate(resolve));
}

describe("scheduleScoringCatchUp", () => {
  afterEach(() => __resetScoringCatchUpForTests());

  it("runs the owner's search five minutes after the usage reset", async () => {
    const { deps, timers, startRun } = makeDeps(["started"]);
    expect(scheduleScoringCatchUp(OWNER, NOW + 3_600_000, deps)).toBe(true);
    expect(timers[0]?.ms).toBe(3_600_000 + 5 * 60_000);
    await fire(timers);
    expect(startRun).toHaveBeenCalledWith(OWNER);
    expect(timers).toHaveLength(0);
  });

  it("keeps one pending catch-up per owner", () => {
    const { deps, timers } = makeDeps([]);
    scheduleScoringCatchUp(OWNER, NOW + 60_000, deps);
    expect(scheduleScoringCatchUp(OWNER, NOW + 120_000, deps)).toBe(false);
    expect(
      scheduleScoringCatchUp({ ...OWNER, userId: "user-2" }, NOW, deps),
    ).toBe(true);
    expect(timers).toHaveLength(2);
  });

  it("waits at least a minute even when the reset has passed", () => {
    const { deps, timers } = makeDeps([]);
    scheduleScoringCatchUp(OWNER, NOW - 3_600_000, deps);
    expect(timers[0]?.ms).toBe(60_000);
  });

  it("tries again later when a run is already in progress", async () => {
    const { deps, timers, startRun } = makeDeps(["busy", "started"]);
    scheduleScoringCatchUp(OWNER, NOW, deps);
    await fire(timers);
    expect(timers[0]?.ms).toBe(20 * 60_000);
    await fire(timers);
    expect(startRun).toHaveBeenCalledTimes(2);
  });

  it("allows a new catch-up once the previous one fired", async () => {
    const { deps, timers } = makeDeps(["started"]);
    scheduleScoringCatchUp(OWNER, NOW, deps);
    await fire(timers);
    expect(scheduleScoringCatchUp(OWNER, NOW, deps)).toBe(true);
  });
});
