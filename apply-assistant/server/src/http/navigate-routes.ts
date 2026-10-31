import { type Response, Router } from "express";
import { z } from "zod";
import type { QuestionAnswerer } from "../claude/answerer.js";
import {
  NavigateLimitError,
  type Navigator,
  navigateRequest,
} from "../claude/navigate.js";
import { claudeOff } from "../claude/off.js";
import { traceUsage } from "../claude/usage-trace.js";
import type { JobOpsApi } from "../jobops/client.js";
import { currentUser } from "../store/owner.js";
import type { TraceRecord } from "../store/trace-store.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Autopilot (AUTOPILOT_PLAN.md §C, §D): Claude's next step from a job's link to its form, and
 * marking a posting you agreed is closed as expired in Job Ops. Both are per job, so the
 * ownership guard in app.ts covers them.
 */

const expireBody = z.object({ reason: z.string().trim().min(1).max(300) });

export function createNavigateRoutes(deps: {
  readonly navigator: Navigator | null;
  readonly answerer: QuestionAnswerer | null;
  readonly jobOps: JobOpsApi;
  readonly trace?: TraceRecord;
}) {
  const router = Router();
  const trace = deps.trace ?? (() => {});

  router.post(
    "/plans/:jobId/navigate",
    async (req: AuthedRequest, res: Response) => {
      const body = navigateRequest.safeParse(req.body);
      if (!body.success) {
        sendError(res, 400, "INVALID_REQUEST", "A page with its screenshot and outline is needed");
        return;
      }
      const off = deps.navigator
        ? claudeOff(deps.answerer)
        : "Claude isn't set up on the server";
      if (!deps.navigator || off) {
        sendError(res, 503, "CLAUDE_OFF", off ?? "Claude isn't set up on the server");
        return;
      }
      const jobId = String(req.params.jobId);
      try {
        const answer = await deps.navigator.next(
          currentUser(),
          jobId,
          body.data,
          traceUsage(trace, jobId),
        );
        trace({
          jobId,
          kind: "navigate",
          message: `Claude on ${body.data.url.slice(0, 120)}: ${answer.action}${answer.ref ? ` ${answer.ref}` : ""}: ${answer.why}`.slice(0, 500),
          data: {
            url: body.data.url,
            action: answer.action,
            ref: answer.ref,
            why: answer.why,
            cost: answer.cost,
            spent: answer.spent,
            history: body.data.history,
          },
        });
        sendOk(res, answer);
      } catch (error) {
        if (error instanceof NavigateLimitError) {
          sendError(res, 409, "NAVIGATE_LIMIT", error.message);
          return;
        }
        sendError(res, 502, "CLAUDE_FAILED", "Claude couldn't be reached; try again");
      }
    },
  );

  /** You agreed the posting is closed (or its link is broken): it leaves your queue. */
  router.post("/jobs/:jobId/expire", async (req: AuthedRequest, res: Response) => {
    const body = expireBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", "Why is it closed?");
      return;
    }
    const jobId = String(req.params.jobId);
    try {
      await deps.jobOps.updateJob(req.jobOpsToken ?? "", jobId, { status: "expired" });
      trace({
        jobId,
        kind: "expired",
        message: `Marked expired in Job Ops: ${body.data.reason}`,
        data: { reason: body.data.reason },
      });
      sendOk(res, { jobId, status: "expired" });
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  return router;
}
