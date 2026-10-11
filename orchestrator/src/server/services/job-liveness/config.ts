/**
 * Configuration for stale-job detection.
 *
 * Read from environment variables rather than the settings registry so this
 * fork-only feature stays out of files that change upstream.
 *
 *   JOB_LIVENESS_ENABLED            "true" | "false"  (default: true)
 *   JOB_LIVENESS_CHECK_HOUR         0-23, UTC         (default: 3)
 *   JOB_LIVENESS_SWEEP_ON_SEARCH    "true" | "false"  (default: true)
 *   JOB_MAX_POSTING_AGE_DAYS        0 disables        (default: 30)
 *   JOB_EXPIRE_UNVERIFIED_AFTER_DAYS 0 disables       (default: 45)
 */

export interface JobLivenessConfig {
  /** Master switch for the pipeline check and the daily sweep. */
  enabled: boolean;
  /** UTC hour at which the daily sweep runs. */
  checkHour: number;
  /** Also re-check every open job in the background on each search run. */
  sweepOnSearch: boolean;
  /** Postings older than this are dropped at discovery. 0 disables. */
  maxPostingAgeDays: number;
  /** Jobs that cannot be verified are expired once this old. 0 disables. */
  expireUnverifiedAfterDays: number;
  /** Number of hosts checked in parallel. */
  hostConcurrency: number;
  /** Pause between two requests to the same host. */
  perHostDelayMs: number;
  /** Timeout for a single posting check, redirects included. */
  requestTimeoutMs: number;
  /** Upper bound on jobs checked in one sweep. */
  maxJobsPerSweep: number;
  /** Time budget for the check that runs inside a pipeline run. */
  pipelineBudgetMs: number;
}

const DEFAULT_CHECK_HOUR = 3;
const DEFAULT_MAX_POSTING_AGE_DAYS = 30;
const DEFAULT_EXPIRE_UNVERIFIED_AFTER_DAYS = 45;

function readInteger(
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < bounds.min || parsed > bounds.max) return fallback;
  return parsed;
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

export function getJobLivenessConfig(
  env: NodeJS.ProcessEnv = process.env,
): JobLivenessConfig {
  return {
    // Never make outbound posting checks from the test suite unless asked to.
    enabled: readBoolean(env.JOB_LIVENESS_ENABLED, env.NODE_ENV !== "test"),
    sweepOnSearch: readBoolean(env.JOB_LIVENESS_SWEEP_ON_SEARCH, true),
    checkHour: readInteger(env.JOB_LIVENESS_CHECK_HOUR, DEFAULT_CHECK_HOUR, {
      min: 0,
      max: 23,
    }),
    maxPostingAgeDays: readInteger(
      env.JOB_MAX_POSTING_AGE_DAYS,
      DEFAULT_MAX_POSTING_AGE_DAYS,
      { min: 0, max: 3650 },
    ),
    expireUnverifiedAfterDays: readInteger(
      env.JOB_EXPIRE_UNVERIFIED_AFTER_DAYS,
      DEFAULT_EXPIRE_UNVERIFIED_AFTER_DAYS,
      { min: 0, max: 3650 },
    ),
    hostConcurrency: 4,
    perHostDelayMs: 400,
    requestTimeoutMs: 12_000,
    maxJobsPerSweep: 500,
    pipelineBudgetMs: 60_000,
  };
}
