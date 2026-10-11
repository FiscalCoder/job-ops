import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import * as jobsRepo from "@server/repositories/jobs";
import { getJobLivenessConfig } from "@server/services/job-liveness/config";
import { partitionByPostingAge } from "@server/services/job-liveness/posting-age";
import {
  type LivenessSweepSummary,
  sweepJobs,
} from "@server/services/job-liveness/sweep";
import type { CreateJobInput } from "@shared/types";
import { updateProgress } from "../progress";

/**
 * Drop postings the source itself dates as older than the configured limit,
 * so they are never imported or scored.
 */
export function dropStalePostings(
  discoveredJobs: CreateJobInput[],
): CreateJobInput[] {
  const config = getJobLivenessConfig();
  const { fresh, stale } = partitionByPostingAge(
    discoveredJobs,
    config.maxPostingAgeDays,
  );

  if (stale.length > 0) {
    logger.info("Dropped discovered jobs older than the posting age limit", {
      step: "stale-jobs",
      droppedCount: stale.length,
      maxPostingAgeDays: config.maxPostingAgeDays,
    });
  }
  return fresh;
}

/**
 * Check freshly imported jobs against their posting pages before any LLM
 * credits are spent scoring them. Never fails the pipeline: a job that cannot
 * be checked is simply scored as before.
 */
export async function expireClosedJobsStep(args: {
  shouldCancel?: () => boolean;
}): Promise<LivenessSweepSummary | null> {
  const config = getJobLivenessConfig();
  if (!config.enabled) return null;

  try {
    const unscoredJobs = await jobsRepo.getUnscoredDiscoveredJobs();
    if (unscoredJobs.length === 0) return null;

    updateProgress({
      detail: `Checking ${unscoredJobs.length} postings are still open`,
    });

    const deadline = Date.now() + config.pipelineBudgetMs;
    const summary = await sweepJobs(unscoredJobs, {
      config,
      shouldStop: () => args.shouldCancel?.() === true || Date.now() > deadline,
    });

    logger.info("Checked imported jobs for closed postings", {
      step: "stale-jobs",
      total: summary.total,
      checked: summary.checked,
      expired: summary.expired,
      unknown: summary.unknown,
      notReached: summary.notReached,
    });
    return summary;
  } catch (error) {
    logger.warn("Closed-posting check failed; continuing to scoring", {
      step: "stale-jobs",
      error: sanitizeUnknown(error),
    });
    return null;
  }
}
