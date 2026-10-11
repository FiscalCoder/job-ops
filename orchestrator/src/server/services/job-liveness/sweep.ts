/**
 * Re-check open jobs against their posting pages and mark the dead ones
 * `expired`.
 *
 * Jobs are marked rather than deleted: discovery de-duplicates by URL, so a
 * deleted row would simply be re-imported by the next search.
 */

import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import * as jobsRepo from "@server/repositories/jobs";
import { asyncPool } from "@server/utils/async-pool";
import type { Job, JobStatus } from "@shared/types";
import { classifyLivenessResponse, type LivenessVerdict } from "./classify";
import { getJobLivenessConfig, type JobLivenessConfig } from "./config";
import { getPostingAgeDays } from "./posting-age";
import { fetchPublicPage, UnsafeUrlError } from "./safe-fetch";

const MS_PER_DAY = 86_400_000;

/** Statuses a job can be in while it is still waiting on the user to apply. */
export const LIVENESS_CHECKED_STATUSES: readonly JobStatus[] = [
  "discovered",
  "ready",
];

type CheckPosting = (
  jobUrl: string,
  expectedTitle?: string | null,
) => Promise<LivenessVerdict>;

export interface ExpiredJobSummary {
  id: string;
  title: string;
  employer: string;
  reason: string;
}

export interface LivenessSweepSummary {
  /** Jobs eligible for checking in this sweep. */
  total: number;
  /** Jobs whose posting was actually requested. */
  checked: number;
  live: number;
  unknown: number;
  expired: number;
  /** Jobs left unchecked because the sweep was cancelled or ran out of time. */
  notReached: number;
  expiredJobs: ExpiredJobSummary[];
}

interface LivenessSweepOptions {
  config?: JobLivenessConfig;
  checkPosting?: CheckPosting;
  shouldStop?: () => boolean;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

type JobOutcome =
  | { kind: "live" }
  | { kind: "unknown" }
  | { kind: "expired"; expired: ExpiredJobSummary }
  | { kind: "not-reached" };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function createPostingChecker(config: JobLivenessConfig): CheckPosting {
  return async (jobUrl, expectedTitle) => {
    try {
      const page = await fetchPublicPage(jobUrl, {
        timeoutMs: config.requestTimeoutMs,
      });
      return classifyLivenessResponse({
        requestedUrl: jobUrl,
        finalUrl: page.finalUrl,
        status: page.status,
        body: page.body,
        expectedTitle,
      });
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        return { state: "unknown", reason: error.message, unverifiable: true };
      }
      return {
        state: "unknown",
        reason: `Posting could not be fetched: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  };
}

function getHostKey(jobUrl: string): string {
  try {
    return new URL(jobUrl).hostname.toLowerCase();
  } catch {
    return "invalid-url";
  }
}

function groupByHost(jobs: readonly Job[]): Job[][] {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = getHostKey(job.jobUrl);
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return Array.from(groups.values());
}

/** Age in days from the source's posting date, else from when we found it. */
function getJobAgeDays(job: Job, now: Date): number | null {
  const postingAge = getPostingAgeDays(job.datePosted, now);
  if (postingAge !== null) return postingAge;

  const discovered = new Date(job.discoveredAt).getTime();
  if (Number.isNaN(discovered)) return null;
  return Math.max(0, Math.floor((now.getTime() - discovered) / MS_PER_DAY));
}

function resolveExpiryReason(
  job: Job,
  verdict: LivenessVerdict,
  config: JobLivenessConfig,
  now: Date,
): string | null {
  if (verdict.state === "closed") return verdict.reason;
  if (verdict.state === "live") return null;

  // Outages and rate limits say nothing about the posting; only a site that
  // will never let us verify it may fall back to age.
  if (!verdict.unverifiable) return null;
  // Manually added jobs are kept until the user removes them.
  if (job.source === "manual") return null;
  if (config.expireUnverifiedAfterDays <= 0) return null;

  const ageDays = getJobAgeDays(job, now);
  if (ageDays === null || ageDays <= config.expireUnverifiedAfterDays) {
    return null;
  }
  return `Could not verify the posting and it is ${ageDays} days old`;
}

async function checkJob(
  job: Job,
  checkPosting: CheckPosting,
  config: JobLivenessConfig,
  now: Date,
): Promise<JobOutcome> {
  const verdict = await checkPosting(job.jobUrl, job.title);
  const reason = resolveExpiryReason(job, verdict, config, now);

  if (reason === null) {
    return { kind: verdict.state === "live" ? "live" : "unknown" };
  }

  // The check can take a while; never overwrite a status the user changed
  // (e.g. marked applied) in the meantime.
  const current = await jobsRepo.getJobById(job.id);
  if (!current || !LIVENESS_CHECKED_STATUSES.includes(current.status)) {
    return { kind: "unknown" };
  }

  await jobsRepo.updateJob(job.id, { status: "expired" });
  logger.info("Marked job as expired", {
    jobId: job.id,
    source: job.source,
    verdict: verdict.state,
    reason,
  });
  return {
    kind: "expired",
    expired: { id: job.id, title: job.title, employer: job.employer, reason },
  };
}

function summarize(
  total: number,
  outcomes: JobOutcome[],
): LivenessSweepSummary {
  const count = (kind: JobOutcome["kind"]): number =>
    outcomes.filter((outcome) => outcome.kind === kind).length;
  const expiredJobs = outcomes.flatMap((outcome) =>
    outcome.kind === "expired" ? [outcome.expired] : [],
  );
  const notReached = count("not-reached");

  return {
    total,
    checked: total - notReached,
    live: count("live"),
    unknown: count("unknown"),
    expired: expiredJobs.length,
    notReached,
    expiredJobs,
  };
}

/**
 * Check the given jobs. Hosts are processed in parallel; requests to the same
 * host are sequential and spaced out so boards are not hammered.
 */
export async function sweepJobs(
  jobs: readonly Job[],
  options: LivenessSweepOptions = {},
): Promise<LivenessSweepSummary> {
  const config = options.config ?? getJobLivenessConfig();
  const checkPosting = options.checkPosting ?? createPostingChecker(config);
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? defaultSleep;
  const shouldStop = options.shouldStop ?? (() => false);

  const eligible = jobs.slice(0, config.maxJobsPerSweep);

  const perHostOutcomes = await asyncPool<Job[], JobOutcome[]>({
    items: groupByHost(eligible),
    concurrency: config.hostConcurrency,
    task: async (hostJobs) => {
      const outcomes: JobOutcome[] = [];
      for (const [index, job] of hostJobs.entries()) {
        if (shouldStop()) {
          outcomes.push({ kind: "not-reached" });
          continue;
        }
        if (index > 0) await sleep(config.perHostDelayMs);
        try {
          outcomes.push(await checkJob(job, checkPosting, config, now));
        } catch (error) {
          logger.warn("Job liveness check failed", {
            jobId: job.id,
            error: sanitizeUnknown(error),
          });
          outcomes.push({ kind: "unknown" });
        }
      }
      return outcomes;
    },
  });

  return summarize(eligible.length, perHostOutcomes.flat());
}

/**
 * Sweep every open job in the current tenant/user scope, oldest first.
 */
export async function sweepOpenJobsInScope(
  options: LivenessSweepOptions = {},
): Promise<LivenessSweepSummary> {
  const openJobs = await jobsRepo.getAllJobs([...LIVENESS_CHECKED_STATUSES]);
  const oldestFirst = [...openJobs].sort((a, b) =>
    a.discoveredAt.localeCompare(b.discoveredAt),
  );
  return sweepJobs(oldestFirst, options);
}
