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
import { createClaudeAccess } from "../claude/access.js";
import { claimUnowned } from "../store/owner.js";
import { createUserSettingsRepo } from "../store/user-settings-repo.js";
import { createRunsRepo } from "../store/runs-repo.js";
import { createTraceStore, type TraceStore } from "../store/trace-store.js";
import { createAnswerBankRoutes } from "./answer-bank-routes.js";
import { createAuthMiddleware, sendJobOpsFailure } from "./auth.js";
import { createCaptureRoutes } from "./capture-routes.js";
import { sendError, sendOk } from "./envelope.js";
import { createKitRoutes } from "./kit-routes.js";
import { createCompanyRoutes } from "./company-routes.js";
import { createImportRoutes } from "./import-routes.js";
import { createSettingsRoutes } from "./settings-routes.js";
import { createSiteRoutes } from "./site-routes.js";
import { createLearnedRoutes } from "./learned-routes.js";
import { createLookupRoutes } from "./lookup-routes.js";
import { createJobOwnership } from "./ownership.js";
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
  /**
   * Claude for unrecognised questions: each user's own key, or for Job Ops' admin the server's
   * (`messages`, null without one). Absent: no Claude at all.
   */
  readonly claude?: {
    readonly messages: MessagesApi | null;
    /** Claude's API with a user's own key (tests leave it out: their keys then aren't used). */
    readonly messagesFor?: (apiKey: string) => MessagesApi;
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
  // Data from before apply-assistant had users was all one person's: Job Ops' admin.
  let claimed = false;
  const requireUser = createAuthMiddleware(jobOps, authCacheSeconds, (user) => {
    if (claimed || !user.isSystemAdmin) return;
    claimed = true;
    const rows = claimUnowned(db, user.id);
    if (rows) log?.(`[users] ${rows} rows from before users given to ${user.username}`);
  });

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
  const userSettings = createUserSettingsRepo(db);
  const access = claude
    ? createClaudeAccess({
        settings: userSettings,
        serverMessages: claude.messages,
        messagesFor:
          claude.messagesFor ??
          (() => {
            throw new Error("Users' own Claude keys aren't set up here");
          }),
      })
    : null;
  const answerer =
    claude && access
      ? createClaudeAnswerer({
          messages: access.messages,
          unavailable: access.unavailable,
          mapModel: claude.mapModel,
          draftModel: claude.draftModel,
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

  // Per-job data (plan, posting, kit, trace) only for your own jobs.
  const ownership = createJobOwnership(jobOps);
  app.use(
    ["/plans/:jobId", "/kit/:jobId", "/jobs/:jobId", "/trace/jobs/:jobId"],
    requireUser,
    ownership.guard,
  );
  app.use(requireUser, createAnswerBankRoutes(answers));
  app.use(requireUser, createSettingsRoutes({ settings: userSettings, access }));
  app.use(requireUser, createCompanyRoutes(limits));
  app.use(requireUser, createImportRoutes({ jobOps, trace: record }));
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
      ownership,
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
