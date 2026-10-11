/**
 * Expire jobs the user picked by hand, one or many.
 */

import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import * as jobsRepo from "@server/repositories/jobs";
import { LIVENESS_CHECKED_STATUSES } from "./sweep";

interface ManualExpireResult {
  jobId: string;
  ok: boolean;
  message?: string;
}

interface ManualExpireSummary {
  requested: number;
  succeeded: number;
  failed: number;
  results: ManualExpireResult[];
}

async function expireJob(jobId: string): Promise<ManualExpireResult> {
  try {
    const job = await jobsRepo.getJobById(jobId);
    if (!job) return { jobId, ok: false, message: "Job not found" };

    if (!LIVENESS_CHECKED_STATUSES.includes(job.status)) {
      return {
        jobId,
        ok: false,
        message: `Job cannot be expired from status "${job.status}"`,
      };
    }

    await jobsRepo.updateJob(jobId, { status: "expired" });
    return { jobId, ok: true };
  } catch (error) {
    logger.warn("Failed to expire job", {
      jobId,
      error: sanitizeUnknown(error),
    });
    return { jobId, ok: false, message: "Failed to expire job" };
  }
}

/**
 * Mark the given jobs expired. Only jobs still waiting on the user
 * (discovered or ready) are eligible; anything already applied is refused.
 */
export async function expireJobsManually(
  jobIds: readonly string[],
): Promise<ManualExpireSummary> {
  const uniqueJobIds = Array.from(new Set(jobIds));
  const results: ManualExpireResult[] = [];
  for (const jobId of uniqueJobIds) {
    results.push(await expireJob(jobId));
  }

  const succeeded = results.filter((result) => result.ok).length;
  return {
    requested: uniqueJobIds.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
