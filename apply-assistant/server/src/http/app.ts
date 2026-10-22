import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { createClaudeAnswerer, type MessagesApi } from "../claude/answerer.js";
import type { JobOpsApi } from "../jobops/client.js";
import { createPlans } from "../plan/plans-service.js";
import { createAnswerBankRepo } from "../store/answer-bank-repo.js";
import { createApplyTargetsRepo } from "../store/apply-targets-repo.js";
import { createAtsBoardsRepo } from "../store/ats-boards-repo.js";
import { createCapturedLinksRepo } from "../store/captured-links-repo.js";
import { createClaudeAnswersRepo } from "../store/claude-answers-repo.js";
import { createFillPlansRepo } from "../store/fill-plans-repo.js";
import { createFormSchemasRepo } from "../store/form-schemas-repo.js";
import { createCompanyLimitsRepo } from "../store/company-limits-repo.js";
import { createSiteRecipesRepo } from "../store/site-recipes-repo.js";
import { createLearnedAnswersRepo } from "../store/learned-answers-repo.js";
import { createRunsRepo } from "../store/runs-repo.js";
import { createTraceStore, type TraceStore } from "../store/trace-store.js";
import { createAnswerBankRoutes } from "./answer-bank-routes.js";
import { createAuthMiddleware, sendJobOpsFailure } from "./auth.js";
import { createCaptureRoutes } from "./capture-routes.js";
import { sendError, sendOk } from "./envelope.js";
import { createKitRoutes } from "./kit-routes.js";
import { createCompanyRoutes } from "./company-routes.js";
import { createSiteRoutes } from "./site-routes.js";
import { createLearnedRoutes } from "./learned-routes.js";
import { createLookupRoutes } from "./lookup-routes.js";
import { createPlanRoutes } from "./plan-routes.js";
import { createProgressRoutes } from "./progress-routes.js";
import { createRunRoutes } from "./run-routes.js";
import {
  createApiLimiter,
  createLoginLimiter,
  securityHeaders,
} from "./security.js";
import { createTraceRoutes } from "./trace-routes.js";

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
  /** The run trace; tests leave it out and share one in the temp folder (made on first snapshot). */
  readonly trace?: TraceStore;
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
  trace = createTraceStore({
    db,
    dir: path.join(tmpdir(), "apply-assistant-test-trace"),
  }),
}: AppDeps) {
  const app = express();
  const record = trace.record;
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
  const answerer = claude
    ? createClaudeAnswerer({
        ...claude,
        cache: createClaudeAnswersRepo(db),
        ...(log ? { log } : {}),
      })
    : null;
  const learned = createLearnedAnswersRepo(db);
  const limits = createCompanyLimitsRepo(db);
  const plans = createPlans({
    jobOps,
    targets,
    schemas,
    plans: planStore,
    answers,
    answerer,
    ...(log ? { log } : {}),
    trace: record,
    learned,
  });

  app.use(requireUser, createAnswerBankRoutes(answers));
  app.use(requireUser, createCompanyRoutes(limits));
  app.use(requireUser, createPlanRoutes(plans));
  app.use(
    requireUser,
    createSiteRoutes({ plans, recipes: createSiteRecipesRepo(db), trace: record }),
  );
  const runs = createRunsRepo(db);
  app.use(
    requireUser,
    createRunRoutes({ jobOps, runs, answers, trace: record }),
  );
  app.use(requireUser, createTraceRoutes({ jobOps, runs, trace }));
  app.use(requireUser, createProgressRoutes({ jobOps, runs, trace }));
  app.use(
    requireUser,
    createLearnedRoutes({
      jobOps,
      learned,
      plans,
      trace: record,
      ...(log ? { log } : {}),
    }),
  );
  app.use(
    requireUser,
    createKitRoutes({
      jobOps,
      targets,
      answers,
      planStore,
      answerer,
      trace: record,
    }),
  );
  app.use(
    requireUser,
    createLookupRoutes({
      jobOps,
      targets,
      boards: createAtsBoardsRepo(db),
      schemas,
      plans,
      planStore,
      limits,
      trace: record,
    }),
  );

  app.use(
    requireUser,
    createCaptureRoutes({
      jobOps,
      targets,
      links: createCapturedLinksRepo(db),
      trace: record,
    }),
  );

  app.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Not found"));

  return app;
}
