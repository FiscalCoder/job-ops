import { type Response, Router } from "express";
import { z } from "zod";
import { MAX_ACT_HTML_CHARS, MAX_ACT_STEPS } from "../claude/act.js";
import { TellRejectedError } from "../claude/tell.js";
import { NotPlannableError, type PlansService } from "../plan/plans-service.js";
import type { SiteRecipesRepo } from "../store/site-recipes-repo.js";
import type { TraceRecord } from "../store/trace-store.js";
import type { AuthedRequest } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Any company's own form: Claude's steps for a field the extension couldn't fill, and the
 * per-site recipes those steps become once they've worked.
 */

const actBody = z.object({
  label: z.string().trim().min(1).max(500),
  wanted: z.string().max(2_000),
  html: z.string().min(1).max(MAX_ACT_HTML_CHARS * 2),
  failure: z.string().max(500).default(""),
});

const host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+(:\d+)?$/)
  .max(253);

const recipeBody = z.object({
  host,
  label: z.string().trim().min(1).max(500),
  steps: z
    .array(
      z.object({
        action: z.enum(["click", "type", "press", "pick", "wait"]),
        value: z.string().max(2_000),
      }),
    )
    .min(1)
    .max(MAX_ACT_STEPS),
  ok: z.boolean(),
  jobId: z.string().max(100).optional(),
});

export function createSiteRoutes(deps: {
  readonly plans: PlansService;
  readonly recipes: SiteRecipesRepo;
  readonly trace?: TraceRecord;
}) {
  const router = Router();
  const trace = deps.trace ?? (() => {});

  router.post(
    "/plans/:jobId/act",
    async (req: AuthedRequest, res: Response) => {
      const body = actBody.safeParse(req.body);
      if (!body.success) {
        sendError(res, 400, "INVALID_REQUEST", "The field, its value and its HTML are needed");
        return;
      }
      try {
        sendOk(res, await deps.plans.act(String(req.params.jobId), body.data));
      } catch (error) {
        if (error instanceof NotPlannableError) {
          sendError(res, 409, "NOT_PLANNABLE", error.message);
          return;
        }
        if (error instanceof TellRejectedError) {
          sendError(res, 422, "NO_ANSWER", error.message);
          return;
        }
        // Steps that aren't ours to run (unknown action or key, too many): none are run.
        if (
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          (error instanceof Error && error.name === "ClaudeReplyError")
        ) {
          sendError(res, 422, "NO_ANSWER", "Claude's steps for this field weren't usable");
          return;
        }
        sendError(res, 502, "CLAUDE_FAILED", "Claude couldn't be reached; try again");
      }
    },
  );

  router.get("/recipes", (req: AuthedRequest, res: Response) => {
    const parsed = host.safeParse(req.query.host);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_REQUEST", "Which site (host)?");
      return;
    }
    sendOk(res, deps.recipes.forHost(parsed.data));
  });

  router.post("/recipes", (req: AuthedRequest, res: Response) => {
    const body = recipeBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", "A site, a question and its steps are needed");
      return;
    }
    const { jobId, ...result } = body.data;
    const recipe = deps.recipes.record(result);
    if (jobId)
      trace({
        jobId,
        kind: "recipe",
        message: `${result.ok ? "Worked" : "Didn't work"} on ${result.host}: steps for "${result.label.slice(0, 80)}"${recipe ? ` (worked ${recipe.worked}, failed ${recipe.failed})` : ""}`,
        data: { host: result.host, label: result.label, ok: result.ok, steps: result.steps },
      });
    sendOk(res, recipe);
  });

  return router;
}

