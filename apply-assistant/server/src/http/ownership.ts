import type { NextFunction, Response } from "express";
import { type JobOpsApi, JobOpsError } from "../jobops/client.js";
import type { AuthedRequest } from "./auth.js";
import { sendJobOpsFailure } from "./auth.js";
import { sendError } from "./envelope.js";

/**
 * Data kept per job (its plan, posting match, kit) is yours only if the job is: Job Ops keeps
 * each user's jobs apart, so a job it shows you is yours. Answers are cached briefly.
 */

const CACHE_MS = 10 * 60_000;
/** Words in a job's place in a path that aren't job IDs ("/plans/rebuild", "/jobs/import"). */
const NOT_JOB_IDS = new Set(["rebuild", "import"]);

export function createJobOwnership(jobOps: JobOpsApi) {
  const known = new Map<string, number>();

  /** True when the signed-in user's Job Ops has this job. */
  async function owns(req: AuthedRequest, jobId: string): Promise<boolean> {
    const key = `${req.user?.id ?? ""}:${jobId}`;
    if ((known.get(key) ?? 0) > Date.now()) return true;
    try {
      await jobOps.getJob(req.jobOpsToken ?? "", jobId);
    } catch (error) {
      if (error instanceof JobOpsError && (error.status === 404 || error.status === 403))
        return false;
      throw error;
    }
    known.set(key, Date.now() + CACHE_MS);
    return true;
  }

  /** For routes with a :jobId: someone else's job is "not found". */
  async function guard(req: AuthedRequest, res: Response, next: NextFunction) {
    const jobId = String(req.params.jobId ?? "");
    if (!jobId || NOT_JOB_IDS.has(jobId)) return next();
    try {
      if (await owns(req, jobId)) return next();
      sendError(res, 404, "NOT_FOUND", "No such job");
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  }

  return { owns, guard };
}

export type JobOwnership = ReturnType<typeof createJobOwnership>;
