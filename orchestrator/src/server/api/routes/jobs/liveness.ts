import { badRequest, conflict, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { isDemoMode, sendDemoBlocked } from "@server/config/demo";
import { expireJobsManually } from "@server/services/job-liveness/manual-expire";
import {
  getSweepStatus,
  startSweepForScope,
} from "@server/services/job-liveness/scheduler";
import { getPrivateDataScope } from "@server/tenancy/private-scope";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const jobsLivenessRouter = Router();

const expireJobsSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(500),
});

function getCallerSweepScope(): { tenantId: string; userId?: string } {
  const scope = getPrivateDataScope();
  return {
    tenantId: scope.tenantId,
    userId: scope.enforceUserIsolation
      ? (scope.userId ?? undefined)
      : undefined,
  };
}

/**
 * Start re-checking every open job in the caller's scope; closed postings are
 * marked expired. The sweep runs in the background (it can take minutes) —
 * poll GET /api/jobs/liveness/status for the result. Expired jobs can then be
 * purged with DELETE /api/jobs/status/expired.
 */
jobsLivenessRouter.post(
  "/liveness/check",
  async (_req: Request, res: Response) => {
    try {
      if (isDemoMode()) {
        return sendDemoBlocked(
          res,
          "Checking for closed postings is disabled to keep the demo stable.",
          { route: "POST /api/jobs/liveness/check" },
        );
      }

      if (!startSweepForScope(getCallerSweepScope())) {
        return fail(
          res,
          conflict("A closed-posting check is already running."),
        );
      }

      ok(res, { message: "Closed-posting check started", started: true });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

/**
 * Mark the given discovered/ready jobs expired by hand (single or bulk).
 */
jobsLivenessRouter.post(
  "/liveness/expire",
  async (req: Request, res: Response) => {
    try {
      if (isDemoMode()) {
        return sendDemoBlocked(
          res,
          "Expiring jobs is disabled to keep the demo stable.",
          { route: "POST /api/jobs/liveness/expire" },
        );
      }

      const parsed = expireJobsSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(
          res,
          badRequest("jobIds must be a list of 1 to 500 job ids"),
        );
      }

      ok(res, await expireJobsManually(parsed.data.jobIds));
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

jobsLivenessRouter.get(
  "/liveness/status",
  async (_req: Request, res: Response) => {
    try {
      ok(res, getSweepStatus(getCallerSweepScope()));
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);
