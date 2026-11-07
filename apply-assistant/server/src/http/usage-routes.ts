import { Router } from "express";
import { type JobOpsApi, JobOpsError } from "../jobops/client.js";
import type { RunsRepo } from "../store/runs-repo.js";
import type { SpendService } from "../usage/spend-service.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * What Claude cost: one run (the run card) and everything you've spent (Settings). Both read
 * only the signed-in user's own runs and trace; a run that isn't yours is "not found".
 * DeepSeek's spend lives in Job Ops (it scores the jobs): /usage/deepseek passes it through.
 */
export function createUsageRoutes(deps: {
  readonly runs: RunsRepo;
  readonly spend: SpendService;
  readonly jobOps?: JobOpsApi;
}) {
  const { runs, spend, jobOps } = deps;
  const router = Router();

  router.get("/runs/:runId/cost", (req, res) => {
    const run = runs.get(String(req.params.runId));
    if (!run) {
      sendError(res, 404, "RUN_NOT_FOUND", "No such run");
      return;
    }
    sendOk(res, spend.runCost(run));
  });

  router.get("/usage/claude/summary", (_req, res) =>
    sendOk(res, spend.summary()),
  );

  router.get("/usage/deepseek", async (req, res) => {
    if (!jobOps?.getAiSpend) {
      sendError(res, 501, "UNSUPPORTED", "DeepSeek spend isn't available");
      return;
    }
    try {
      const spent = await jobOps.getAiSpend((req as AuthedRequest).jobOpsToken ?? "");
      sendOk(res, spent.deepseek);
    } catch (error) {
      if (error instanceof JobOpsError) {
        sendJobOpsFailure(res, error);
        return;
      }
      throw error;
    }
  });

  return router;
}
