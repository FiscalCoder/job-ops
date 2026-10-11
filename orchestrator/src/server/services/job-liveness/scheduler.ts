/**
 * Daily sweep that expires open jobs whose postings have closed.
 */

import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { isDemoMode } from "@server/config/demo";
import { db, schema } from "@server/db/index";
import { isHostedUserIsolationEnabled } from "@server/tenancy/private-scope";
import { createScheduler } from "@server/utils/scheduler";
import { inArray } from "drizzle-orm";
import { getJobLivenessConfig } from "./config";
import {
  LIVENESS_CHECKED_STATUSES,
  type LivenessSweepSummary,
  sweepOpenJobsInScope,
} from "./sweep";

const { jobs } = schema;

interface SweepScope {
  tenantId: string;
  userId?: string;
}

interface SweepStatus {
  running: boolean;
  lastFinishedAt: string | null;
  lastSummary: LivenessSweepSummary | null;
}

const activeScopeKeys = new Set<string>();
const lastResultByScopeKey = new Map<
  string,
  { finishedAt: string; summary: LivenessSweepSummary }
>();

function toScopeKey(scope: SweepScope): string {
  return `${scope.tenantId}:${scope.userId ?? ""}`;
}

/** Every tenant (and, when users are isolated, every user) with open jobs. */
async function listScopesWithOpenJobs(): Promise<SweepScope[]> {
  const rows = await db
    .selectDistinct({ tenantId: jobs.tenantId, userId: jobs.userId })
    .from(jobs)
    .where(inArray(jobs.status, [...LIVENESS_CHECKED_STATUSES]));

  const isolateUsers = isHostedUserIsolationEnabled();
  const scopes = new Map<string, SweepScope>();
  for (const row of rows) {
    if (isolateUsers && !row.userId) continue;
    const scope: SweepScope = isolateUsers
      ? { tenantId: row.tenantId, userId: row.userId ?? undefined }
      : { tenantId: row.tenantId };
    scopes.set(toScopeKey(scope), scope);
  }
  return Array.from(scopes.values());
}

/**
 * Run a sweep for one scope, or return null if one is already in progress
 * for it.
 */
async function runSweepForScope(
  scope: SweepScope,
  excludeJobIds?: ReadonlySet<string>,
): Promise<LivenessSweepSummary | null> {
  const scopeKey = toScopeKey(scope);
  if (activeScopeKeys.has(scopeKey)) return null;

  activeScopeKeys.add(scopeKey);
  try {
    const summary = await runWithRequestContext(
      { tenantId: scope.tenantId, userId: scope.userId },
      () => sweepOpenJobsInScope({}, excludeJobIds),
    );
    lastResultByScopeKey.set(scopeKey, {
      finishedAt: new Date().toISOString(),
      summary,
    });
    return summary;
  } finally {
    activeScopeKeys.delete(scopeKey);
  }
}

export function getSweepStatus(scope: SweepScope): SweepStatus {
  const scopeKey = toScopeKey(scope);
  const last = lastResultByScopeKey.get(scopeKey);
  return {
    running: activeScopeKeys.has(scopeKey),
    lastFinishedAt: last?.finishedAt ?? null,
    lastSummary: last?.summary ?? null,
  };
}

/**
 * Start a sweep without waiting for it; a full sweep can take minutes.
 * Returns false if one is already running for the scope. Jobs in
 * `excludeJobIds` were just checked by the caller and are skipped.
 */
export function startSweepForScope(
  scope: SweepScope,
  excludeJobIds?: ReadonlySet<string>,
): boolean {
  if (activeScopeKeys.has(toScopeKey(scope))) return false;
  void runSweepForScope(scope, excludeJobIds).catch((error) => {
    logger.warn("Job liveness sweep failed", {
      tenantId: scope.tenantId,
      error: sanitizeUnknown(error),
    });
  });
  return true;
}

async function runSweepForAllScopes(): Promise<void> {
  const scopes = await listScopesWithOpenJobs();
  for (const scope of scopes) {
    try {
      const summary = await runSweepForScope(scope);
      if (!summary) continue;
      logger.info("Job liveness sweep finished", {
        tenantId: scope.tenantId,
        total: summary.total,
        checked: summary.checked,
        live: summary.live,
        unknown: summary.unknown,
        expired: summary.expired,
      });
    } catch (error) {
      logger.warn("Job liveness sweep failed", {
        tenantId: scope.tenantId,
        error: sanitizeUnknown(error),
      });
    }
  }
}

const scheduler = createScheduler("job-liveness", runSweepForAllScopes);

/** Start the daily sweep. Safe to call once at server startup. */
export function initializeJobLiveness(): void {
  const config = getJobLivenessConfig();
  if (!config.enabled || isDemoMode()) {
    logger.info("Job liveness sweep is disabled");
    return;
  }
  scheduler.start(config.checkHour);
}
