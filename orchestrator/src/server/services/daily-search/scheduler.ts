/**
 * Daily search: runs one of your saved searches (search presets) every day, the way the Run
 * button does, so new jobs are found and scored without you starting it. Closed postings are
 * removed by the job-liveness sweep, which also runs after each search.
 *
 * Read from environment variables rather than the settings registry so this fork-only feature
 * stays out of files that change upstream:
 *
 *   DAILY_SEARCH_PRESET   the saved search's name (unset: no daily search)
 *   DAILY_SEARCH_HOUR     0-23, UTC (default: 1, which is 06:30 in India)
 *   DAILY_SEARCH_HOURS    several runs a day, UTC hours separated by commas ("0,12");
 *                         when set, it replaces DAILY_SEARCH_HOUR
 *
 * How far back each run looks is JOB_DISCOVERY_MAX_AGE_HOURS (job-liveness config).
 */

import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { isDemoMode } from "@server/config/demo";
import { db, schema } from "@server/db/index";
import { getPipelineStatus, runPipeline } from "@server/pipeline/index";
import { reserveHostedUsage } from "@server/services/hosted-usage";
import { ensurePipelineSearchTerms } from "@server/services/pipeline-search-terms";
import { createScheduler } from "@server/utils/scheduler";
import { createLocationIntent } from "@shared/location-intelligence.js";
import type { PipelineSearchPresetConfig } from "@shared/types";
import { eq } from "drizzle-orm";

const { pipelineSearchPresets } = schema;

const DEFAULT_HOUR = 1;

export interface DailySearchConfig {
  /** The saved search to run; null turns the daily search off. */
  presetName: string | null;
  /** UTC hour it runs at (the first of `hours`). */
  hour: number;
  /** Every UTC hour it runs at, earliest first. */
  hours: number[];
}

const validHour = (hour: number) =>
  Number.isInteger(hour) && hour >= 0 && hour <= 23;

export function getDailySearchConfig(
  env: NodeJS.ProcessEnv = process.env,
): DailySearchConfig {
  const name = env.DAILY_SEARCH_PRESET?.trim();
  const one = Number.parseInt(env.DAILY_SEARCH_HOUR ?? "", 10);
  const several = [
    ...new Set(
      (env.DAILY_SEARCH_HOURS ?? "")
        .split(",")
        .map((h) => (h.trim() === "" ? Number.NaN : Number(h.trim())))
        .filter(validHour),
    ),
  ].sort((a, b) => a - b);
  const hours = several.length
    ? several
    : [validHour(one) ? one : DEFAULT_HOUR];
  return {
    presetName: name ? name : null,
    hour: hours[0] ?? DEFAULT_HOUR,
    hours,
  };
}

/** What a saved search runs with: the same settings the Run button sends. */
export function runConfigFor(config: PipelineSearchPresetConfig) {
  return {
    topN: config.topN,
    minSuitabilityScore: config.minSuitabilityScore,
    sources: config.sources,
    scoringInstructions: config.scoringInstructions,
    runBudget: config.runBudget,
    locationIntent: createLocationIntent({
      selectedCountry: config.country,
      cityLocations: config.cityLocations,
      proximity: config.proximity ?? null,
      workplaceTypes: config.workplaceTypes,
      geoScope: config.searchScope,
      matchStrictness: config.matchStrictness,
    }),
    ...(config.watchlistSelectedSourceIds
      ? { watchlistSelectedSourceIds: config.watchlistSelectedSourceIds }
      : {}),
  };
}

/** Starts the saved search for its owner; false when a search is already running there. */
async function startForOwner(
  preset: typeof pipelineSearchPresets.$inferSelect,
): Promise<boolean> {
  return runWithRequestContext(
    { tenantId: preset.tenantId, userId: preset.userId ?? undefined },
    async () => {
      if (getPipelineStatus().isRunning) return false;
      const config = preset.config as PipelineSearchPresetConfig;
      await ensurePipelineSearchTerms({
        requestedSearchTerms: config.searchTerms,
      });
      const usage = await reserveHostedUsage({ action: "pipeline_run" });
      void runPipeline(runConfigFor(config), {
        hostedUsageReservationId: usage.reservation?.id ?? null,
      }).catch((error) => {
        logger.error("Daily search run failed", {
          error: sanitizeUnknown(error),
        });
      });
      return true;
    },
  );
}

async function runDailySearch(): Promise<void> {
  const { presetName } = getDailySearchConfig();
  if (!presetName) return;
  const presets = await db
    .select()
    .from(pipelineSearchPresets)
    .where(eq(pipelineSearchPresets.name, presetName));
  if (presets.length === 0) {
    logger.warn("Daily search: no saved search with that name", { presetName });
    return;
  }
  for (const preset of presets) {
    try {
      const started = await startForOwner(preset);
      logger.info(
        started
          ? "Daily search started"
          : "Daily search skipped: a search is already running",
        { presetName, tenantId: preset.tenantId },
      );
    } catch (error) {
      logger.warn("Daily search couldn't start", {
        presetName,
        error: sanitizeUnknown(error),
      });
    }
  }
}

/** One scheduler per run of the day (each keeps its own daily timer). */
const schedulers: ReturnType<typeof createScheduler>[] = [];

export function initializeDailySearch(): void {
  const config = getDailySearchConfig();
  if (!config.presetName || isDemoMode()) {
    logger.info("Daily search is off (DAILY_SEARCH_PRESET not set)");
    return;
  }
  for (const hour of config.hours) {
    const scheduler = createScheduler(`daily-search@${hour}`, runDailySearch);
    scheduler.start(hour);
    schedulers.push(scheduler);
  }
}

export function getDailySearchNextRun(): string | null {
  return (
    schedulers
      .map((s) => s.getNextRun())
      .filter((next): next is string => next !== null)
      .sort()[0] ?? null
  );
}
