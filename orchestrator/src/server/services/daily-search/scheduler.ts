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
  /** UTC hour it runs at. */
  hour: number;
}

export function getDailySearchConfig(
  env: NodeJS.ProcessEnv = process.env,
): DailySearchConfig {
  const name = env.DAILY_SEARCH_PRESET?.trim();
  const hour = Number.parseInt(env.DAILY_SEARCH_HOUR ?? "", 10);
  return {
    presetName: name ? name : null,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_HOUR,
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
      await ensurePipelineSearchTerms({ requestedSearchTerms: config.searchTerms });
      const usage = await reserveHostedUsage({ action: "pipeline_run" });
      void runPipeline(runConfigFor(config), {
        hostedUsageReservationId: usage.reservation?.id ?? null,
      }).catch((error) => {
        logger.error("Daily search run failed", { error: sanitizeUnknown(error) });
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

const scheduler = createScheduler("daily-search", runDailySearch);

export function initializeDailySearch(): void {
  const config = getDailySearchConfig();
  if (!config.presetName || isDemoMode()) {
    logger.info("Daily search is off (DAILY_SEARCH_PRESET not set)");
    return;
  }
  scheduler.start(config.hour);
}

export function getDailySearchNextRun(): string | null {
  return scheduler.getNextRun();
}
