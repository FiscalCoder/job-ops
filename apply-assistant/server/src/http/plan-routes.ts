import { type Response, Router } from "express";
import { z } from "zod";
import { TellRejectedError } from "../claude/tell.js";
import { JobOpsError } from "../jobops/client.js";
import { NotPlannableError, type PlansService } from "../plan/plans-service.js";
import { workdayPageSchema } from "../plan/workday-schema.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

const tellBody = z.object({
  ref: z.string().min(1).max(200),
  instruction: z.string().trim().min(2).max(500),
});

/** Workday: the choices found for a field none of which matches your answer as such. */
const chooseBody = z.object({
  label: z.string().trim().min(1).max(500),
  wanted: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(300)).min(1).max(300),
});

/** Fill plans: one per job with a matched, fetched form, and "Tell agent" for one field. */
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

  /** Workday: Claude picks the closest of a field's choices to your answer. */
  router.post(
    "/plans/:jobId/choose",
    async (req: AuthedRequest, res: Response) => {
      const body = chooseBody.safeParse(req.body);
      if (!body.success) {
        sendError(res, 400, "INVALID_REQUEST", "The field and its choices are needed");
        return;
      }
      try {
        sendOk(res, await plans.choose(tokenOf(req), String(req.params.jobId), body.data));
      } catch (error) {
        if (error instanceof NotPlannableError) {
          sendError(res, 409, "NOT_PLANNABLE", error.message);
          return;
        }
        if (error instanceof TellRejectedError) {
          sendError(res, 422, "NO_ANSWER", error.message);
          return;
        }
        if (error instanceof JobOpsError) {
          sendJobOpsFailure(res, error);
          return;
        }
        sendError(res, 502, "CLAUDE_FAILED", "Claude couldn't be reached; try again");
      }
    },
  );

  /** "Tell agent": Claude proposes one field's value from your instruction (nothing is filled). */
  router.post(
    "/plans/:jobId/tell",
    async (req: AuthedRequest, res: Response) => {
      const body = tellBody.safeParse(req.body);
      if (!body.success) {
        sendError(
          res,
          400,
          "INVALID_REQUEST",
          "Say how to answer (a few words), and which field",
        );
        return;
      }
      try {
        sendOk(
          res,
          await plans.tell(
            tokenOf(req),
            String(req.params.jobId),
            body.data.ref,
            body.data.instruction,
          ),
        );
      } catch (error) {
        if (error instanceof NotPlannableError) {
          sendError(res, 409, "NOT_PLANNABLE", error.message);
          return;
        }
        if (error instanceof TellRejectedError) {
          sendError(res, 422, "NO_ANSWER", error.message);
          return;
        }
        if (error instanceof JobOpsError) {
          sendJobOpsFailure(res, error);
          return;
        }
        sendError(
          res,
          502,
          "CLAUDE_FAILED",
          "Claude couldn't be reached; try again",
        );
      }
    },
  );

  /** Workday: a plan for the page you're on, from the fields the extension read. */
  router.post(
    "/plans/:jobId/page",
    async (req: AuthedRequest, res: Response) => {
      const page = workdayPageSchema.safeParse(req.body);
      if (!page.success) {
        // Which part was off (e.g. "fields.2.options"), so the run's trail shows it.
        const where = page.error.issues[0]?.path.join(".") ?? "";
        sendError(
          res,
          400,
          "INVALID_REQUEST",
          `The page's fields couldn't be read (${where}); reload the page and try again`,
        );
        return;
      }
      try {
        sendOk(
          res,
          await plans.planPage(
            tokenOf(req),
            String(req.params.jobId),
            page.data,
          ),
        );
      } catch (error) {
        if (error instanceof JobOpsError && error.status === 404) {
          sendError(
            res,
            404,
            "JOB_NOT_FOUND",
            "Job Ops has no job with that id",
          );
          return;
        }
        sendJobOpsFailure(res, error);
      }
    },
  );

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
