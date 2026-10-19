import { type Response, Router } from "express";
import { JobOpsError } from "../jobops/client.js";
import { NotPlannableError, type PlansService } from "../plan/plans-service.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/** Fill plans: one per job with a matched, fetched Greenhouse form. */
export function createPlanRoutes(plans: PlansService) {
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  // Declared before /plans/:jobId so "rebuild" isn't read as a job id.
  router.post("/plans/rebuild", async (req: AuthedRequest, res: Response) => {
    try {
      sendOk(res, await plans.rebuildAll(tokenOf(req)));
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  router.get("/plans/:jobId", async (req: AuthedRequest, res: Response) => {
    try {
      sendOk(res, await plans.build(tokenOf(req), String(req.params.jobId)));
    } catch (error) {
      if (error instanceof NotPlannableError) {
        sendError(res, 409, "NOT_PLANNABLE", error.message);
        return;
      }
      if (error instanceof JobOpsError && error.status === 404) {
        sendError(res, 404, "JOB_NOT_FOUND", "Job Ops has no job with that id");
        return;
      }
      sendJobOpsFailure(res, error);
    }
  });

  return router;
}
