import { Router } from "express";
import type { RunsRepo } from "../store/runs-repo.js";
import type { SpendService } from "../usage/spend-service.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * What Claude cost: one run (the run card) and everything you've spent (Settings). Both read
 * only the signed-in user's own runs and trace; a run that isn't yours is "not found".
 */
export function createUsageRoutes(deps: {
  readonly runs: RunsRepo;
  readonly spend: SpendService;
}) {
  const { runs, spend } = deps;
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

  return router;
}
