import { type Response, Router } from "express";
import { z } from "zod";
import { type JobOpsApi, JobOpsError } from "../jobops/client.js";
import type { PlansService } from "../plan/plans-service.js";
import { normalizeQuestion } from "../plan/question-norm.js";
import type { LearnedAnswersRepo } from "../store/learned-answers-repo.js";
import type { TraceRecord } from "../store/trace-store.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Remembered answers: what you answered a form question with (edited in the side panel, or
 * typed on the page), reused the next time a form asks the same question. Listed and deletable
 * on the answer-bank page.
 */

const learnBody = z.object({
  jobId: z.string().min(1).max(100),
  label: z.string().trim().min(2).max(500),
  type: z.string().min(1).max(30),
  value: z.union([
    z.string().trim().min(1).max(2_000),
    z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  ]),
  how: z.enum(["edited", "typed"]),
});

export interface LearnedRoutesDeps {
  readonly jobOps: JobOpsApi;
  readonly learned: LearnedAnswersRepo;
  readonly plans: PlansService;
  readonly trace?: TraceRecord;
  readonly log?: (line: string) => void;
}

export function createLearnedRoutes(deps: LearnedRoutesDeps) {
  const { jobOps, learned, plans } = deps;
  const trace = deps.trace ?? (() => {});
  const log = deps.log ?? (() => {});
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  /** Other queued jobs may ask the same question: refresh their plans in the background. */
  const refreshPlans = (token: string) => {
    void plans
      .rebuildAll(token)
      .catch((error: unknown) =>
        log(`[learned] couldn't rebuild plans: ${String(error)}`),
      );
  };

  router.post("/learned", async (req: AuthedRequest, res: Response) => {
    const body = learnBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", "Invalid answer to remember");
      return;
    }
    const { jobId, label, type, value, how } = body.data;
    let employer: string;
    try {
      ({ employer } = await jobOps.getJob(tokenOf(req), jobId));
    } catch (error) {
      if (error instanceof JobOpsError && error.status === 404) {
        sendError(res, 404, "JOB_NOT_FOUND", "Job Ops has no job with that id");
        return;
      }
      sendJobOpsFailure(res, error);
      return;
    }
    const saved = learned.save({
      questionNorm: normalizeQuestion(label, employer),
      label,
      fieldType: type,
      value,
      how,
      jobId,
    });
    trace({
      jobId,
      kind: "learned",
      message: `Remembered your answer to "${label.slice(0, 100)}"`,
      data: { questionNorm: saved.questionNorm, how },
    });
    refreshPlans(tokenOf(req));
    sendOk(res, saved);
  });

  router.get("/learned", (_req, res) => {
    sendOk(res, learned.list());
  });

  router.delete("/learned/:id", (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !learned.delete(id)) {
      sendError(res, 404, "NOT_FOUND", "No such remembered answer");
      return;
    }
    refreshPlans(tokenOf(req));
    sendOk(res, { deleted: id });
  });

  return router;
}
