import { type Response, Router } from "express";
import { JobOpsError } from "../jobops/client.js";
import {
  createLookups,
  InvalidLookupError,
  type LookupsDeps,
  lookupResultSchema,
} from "../resolver/lookups.js";
import type { AuthedRequest } from "./auth.js";
import { sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/** Resolver endpoints used by the extension, plus the queue the side panel shows. */
export function createLookupRoutes(deps: LookupsDeps) {
  const router = Router();
  const lookups = createLookups(deps);

  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  router.get("/lookups/pending", async (req: AuthedRequest, res: Response) => {
    try {
      sendOk(res, await lookups.pending(tokenOf(req)));
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  router.post("/lookups/results", async (req: AuthedRequest, res: Response) => {
    const parsed = lookupResultSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid lookup result",
        parsed.error.flatten(),
      );
      return;
    }
    try {
      sendOk(res, await lookups.apply(tokenOf(req), parsed.data));
    } catch (error) {
      if (error instanceof InvalidLookupError) {
        sendError(res, 400, "INVALID_LOOKUP", error.message);
        return;
      }
      if (error instanceof JobOpsError && error.status === 404) {
        sendError(res, 404, "JOB_NOT_FOUND", "Job Ops has no job with that id");
        return;
      }
      sendJobOpsFailure(res, error);
    }
  });

  router.get("/queue", async (req: AuthedRequest, res: Response) => {
    try {
      sendOk(res, await lookups.queue(tokenOf(req)));
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  return router;
}
