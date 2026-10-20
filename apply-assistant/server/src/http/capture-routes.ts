import { type Response, Router } from "express";
import {
  type CapturesDeps,
  captureSchema,
  createCaptures,
} from "../capture/captures.js";
import type { AuthedRequest } from "./auth.js";
import { sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/** LinkedIn apply-link capture from the extension. */
export function createCaptureRoutes(deps: CapturesDeps) {
  const router = Router();
  const captures = createCaptures(deps);

  router.post("/captures", async (req: AuthedRequest, res: Response) => {
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_REQUEST", "Invalid capture");
      return;
    }
    try {
      sendOk(res, await captures.capture(req.jobOpsToken ?? "", parsed.data));
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  router.get("/captures", (_req, res) => {
    sendOk(res, deps.links.recent(20));
  });

  return router;
}
