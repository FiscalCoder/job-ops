import { type Response, Router } from "express";
import { z } from "zod";
import type { QuestionAnswerer } from "../claude/answerer.js";
import { claudeOff } from "../claude/off.js";
import {
  OperateLimitError,
  type Operator,
  type OperateTurn,
  operateNext,
  operateStart,
} from "../claude/operate.js";
import { traceUsage } from "../claude/usage-trace.js";
import { currentUser } from "../store/owner.js";
import type { TraceRecord } from "../store/trace-store.js";
import type { AuthedRequest } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * "Let Claude do it" for one field: the extension starts a session with a screenshot and the
 * field's outline, then sends each action's result and gets Claude's next actions, until
 * Claude stops or a limit does. Claude's calls go out with your own key, and every turn (its
 * actions and cost) is in the job's trail.
 */

const stopBody = z.object({ session: z.string().uuid() });

/** What Claude did this turn, for the trail: action names, and refs or points, never text typed. */
function summary(turn: OperateTurn): string {
  if (turn.done)
    return turn.value
      ? `Claude finished: the field shows "${turn.value.slice(0, 80)}". ${turn.why}`
      : `Claude stopped: ${turn.why || "done"}`;
  return `Claude: ${turn.calls
    .map((c) => {
      const input = (c.input ?? {}) as { ref?: string; action?: string; coordinate?: number[] };
      if (c.toolset) return `${c.name}${input.coordinate ? ` at ${input.coordinate.join(",")}` : ""}`;
      return `${input.action ?? c.name}${input.ref ? ` ${input.ref}` : ""}`;
    })
    .join(", ")}`;
}

export function createOperateRoutes(deps: {
  readonly operator: Operator | null;
  readonly answerer: QuestionAnswerer | null;
  readonly trace?: TraceRecord;
  /** Your saved answers for the prompt (private ones hidden), so Claude can pick what fits you. */
  readonly savedAnswers?: () => string;
}) {
  const router = Router();
  const trace = deps.trace ?? (() => {});

  const respond = async (
    req: AuthedRequest,
    res: Response,
    work: (operator: Operator, jobId: string) => Promise<OperateTurn>,
  ) => {
    const off = deps.operator ? claudeOff(deps.answerer) : "Claude isn't set up on the server";
    if (!deps.operator || off) {
      sendError(res, 503, "CLAUDE_OFF", off ?? "Claude isn't set up on the server");
      return;
    }
    const jobId = String(req.params.jobId);
    try {
      const turn = await work(deps.operator, jobId);
      const label = turn.label;
      trace({
        jobId,
        kind: "operate",
        message: `${label.slice(0, 80)}: ${summary(turn)}`.slice(0, 500),
        data: {
          label,
          session: turn.session,
          done: turn.done,
          why: turn.why,
          cost: turn.cost,
          calls: turn.calls.map((c) => ({ name: c.name, toolset: c.toolset })),
        },
      });
      sendOk(res, turn);
    } catch (error) {
      if (error instanceof OperateLimitError) {
        sendError(res, 409, "OPERATE_LIMIT", error.message);
        return;
      }
      sendError(res, 502, "CLAUDE_FAILED", "Claude couldn't be reached; try again");
    }
  };

  router.post("/plans/:jobId/operate", (req: AuthedRequest, res: Response) => {
    const start = operateStart.safeParse(req.body);
    const next = start.success ? null : operateNext.safeParse(req.body);
    if (!start.success && !next?.success) {
      sendError(res, 400, "INVALID_REQUEST", "A field with its screenshot, or a session's results, is needed");
      return;
    }
    return respond(
      req,
      res,
      (operator, jobId) =>
        start.success
          ? operator.start(
              currentUser(),
              jobId,
              start.data,
              traceUsage(trace, jobId),
              deps.savedAnswers?.() ?? "",
            )
          : operator.next(
              currentUser(),
              jobId,
              (next as { data: z.infer<typeof operateNext> }).data,
              traceUsage(trace, jobId),
            ),
    );
  });

  router.post("/plans/:jobId/operate/stop", (req: AuthedRequest, res: Response) => {
    const body = stopBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", "Which session?");
      return;
    }
    deps.operator?.stop(currentUser(), body.data.session);
    sendOk(res, { stopped: true });
  });

  return router;
}
