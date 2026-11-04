import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import {
  deduplicateJobsByPostingKey,
  deduplicateJobsByTitleAndEmployer,
} from "@shared/job-matching.js";
import { postingKeysOf } from "@shared/posting-key.js";
import type { CreateJobInput } from "@shared/types";
import { progressHelpers } from "../progress";

/** Stored jobs' links; none when they can't be read (the URL match still applies). */
async function storedLinks() {
  try {
    return await jobsRepo.listJobLinks();
  } catch (error) {
    logger.warn("Couldn't read stored job links for posting matching", { error });
    return [];
  }
}

export async function importJobsStep(args: {
  discoveredJobs: CreateJobInput[];
}): Promise<{ created: number; skipped: number; fuzzyMerged: number }> {
  logger.info("Importing discovered jobs", {
    discovered: args.discoveredJobs.length,
  });

  // Fork: the same posting under another link (an ATS id or requisition in the URL) first,
  // including postings already stored; then the fuzzy title+employer match as before.
  const known = new Set((await storedLinks()).flatMap((job) => postingKeysOf(job)));
  const byPosting = deduplicateJobsByPostingKey(args.discoveredJobs, known);
  if (byPosting.merged + byPosting.alreadyStored > 0) {
    logger.info("Matched discovered jobs by posting id before import", {
      merged: byPosting.merged,
      alreadyStored: byPosting.alreadyStored,
    });
  }
  const dedupedJobs = deduplicateJobsByTitleAndEmployer(byPosting.jobs);
  const fuzzyMerged = args.discoveredJobs.length - dedupedJobs.length;

  if (fuzzyMerged > 0) {
    logger.info("Fuzzy-deduped discovered jobs before import", {
      original: args.discoveredJobs.length,
      dedupedCount: dedupedJobs.length,
      fuzzyMerged,
    });
  }

  const { created, skipped } = await jobsRepo.createJobs(
    dedupedJobs,
    (job, index, total) =>
      progressHelpers.importingJob(index, total, {
        id: job.jobUrl,
        title: job.title,
        employer: job.employer,
      }),
  );
  logger.info("Import step complete", {
    discovered: args.discoveredJobs.length,
    fuzzyMerged,
    created,
    skipped,
  });

  progressHelpers.importComplete(created, skipped + fuzzyMerged);

  return { created, skipped, fuzzyMerged };
}
