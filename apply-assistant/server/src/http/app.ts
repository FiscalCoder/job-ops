import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { createClaudeAnswerer, type MessagesApi } from "../claude/answerer.js";
import type { JobOpsApi } from "../jobops/client.js";
import { createPlans } from "../plan/plans-service.js";
import { createAnswerBankRepo } from "../store/answer-bank-repo.js";
import { createApplyTargetsRepo } from "../store/apply-targets-repo.js";
import { createClaudeAnswersRepo } from "../store/claude-answers-repo.js";
import { createFillPlansRepo } from "../store/fill-plans-repo.js";
import { createFormSchemasRepo } from "../store/form-schemas-repo.js";
import { createGhBoardsRepo } from "../store/gh-boards-repo.js";
import { createRunsRepo } from "../store/runs-repo.js";
import { createAnswerBankRoutes } from "./answer-bank-routes.js";
import { createAuthMiddleware, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";
import { createLookupRoutes } from "./lookup-routes.js";
import { createPlanRoutes } from "./plan-routes.js";
import { createRunRoutes } from "./run-routes.js";
import {
  createApiLimiter,
  createLoginLimiter,
  securityHeaders,
} from "./security.js";

/** The web page (answer bank + queue), served from the same origin as the API. */
const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

export interface AppDeps {
  readonly jobOps: JobOpsApi;
  readonly db: DatabaseSync;
  readonly authCacheSeconds: number;
  /** Claude for unrecognised questions; null or absent without an Anthropic key. */
  readonly claude?: {
    readonly messages: MessagesApi;
    readonly mapModel: string;
    readonly draftModel: string;
  } | null;
  readonly log?: (line: string) => void;
}

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export function createApp({
  jobOps,
  db,
  authCacheSeconds,
  claude,
  log,
}: AppDeps) {
  const app = express();
  const answers = createAnswerBankRepo(db);
  const requireUser = createAuthMiddleware(jobOps, authCacheSeconds);

  app.disable("x-powered-by");
  // One hop: nginx (CloudPanel) is the only way in, so its X-Forwarded-For is the client.
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(express.static(PUBLIC_DIR, { index: "index.html" }));
  app.use(createApiLimiter());
  // Lookup results can carry several job descriptions.
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => sendOk(res, { status: "ok" }));

  app.post("/auth/login", createLoginLimiter(), async (req, res) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success)
      return sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Username and password are required",
      );
    try {
      return sendOk(
        res,
        await jobOps.login(body.data.username, body.data.password),
      );
    } catch (error) {
      return sendJobOpsFailure(res, error);
    }
  });

  const targets = createApplyTargetsRepo(db);
  const schemas = createFormSchemasRepo(db);
  const planStore = createFillPlansRepo(db);
  const plans = createPlans({
    jobOps,
    targets,
    schemas,
    plans: planStore,
    answers,
    answerer: claude
      ? createClaudeAnswerer({
          ...claude,
          cache: createClaudeAnswersRepo(db),
          ...(log ? { log } : {}),
        })
      : null,
    ...(log ? { log } : {}),
  });

  app.use(requireUser, createAnswerBankRoutes(answers));
  app.use(requireUser, createPlanRoutes(plans));
  app.use(
    requireUser,
    createRunRoutes({ jobOps, runs: createRunsRepo(db), answers }),
  );
  app.use(
    requireUser,
    createLookupRoutes({
      jobOps,
      targets,
      boards: createGhBoardsRepo(db),
      schemas,
      plans,
      planStore,
    }),
  );

  app.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Not found"));

  return app;
}
