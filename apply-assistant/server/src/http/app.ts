import type { DatabaseSync } from "node:sqlite";
import express, { type Response } from "express";
import { z } from "zod";
import type { JobOpsApi } from "../jobops/client.js";
import { createAnswerBankRepo } from "../store/answer-bank-repo.js";
import { createApplyTargetsRepo } from "../store/apply-targets-repo.js";
import { createGhBoardsRepo } from "../store/gh-boards-repo.js";
import {
  type AuthedRequest,
  createAuthMiddleware,
  sendJobOpsFailure,
} from "./auth.js";
import { sendError, sendOk } from "./envelope.js";
import { createLookupRoutes } from "./lookup-routes.js";

export interface AppDeps {
  readonly jobOps: JobOpsApi;
  readonly db: DatabaseSync;
  readonly authCacheSeconds: number;
}

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
const answerBody = z.object({
  value: z.string().max(5000),
  isProtected: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const answerKey = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9_.-]+$/i, "Use letters, digits, '.', '_' or '-'");

export function createApp({ jobOps, db, authCacheSeconds }: AppDeps) {
  const app = express();
  const answers = createAnswerBankRepo(db);
  const requireUser = createAuthMiddleware(jobOps, authCacheSeconds);

  app.disable("x-powered-by");
  // Lookup results can carry several job descriptions.
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => sendOk(res, { status: "ok" }));

  app.post("/auth/login", async (req, res) => {
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

  app.get("/answer-bank", requireUser, (_req, res) =>
    sendOk(res, answers.list()),
  );

  app.put(
    "/answer-bank/:key",
    requireUser,
    (req: AuthedRequest, res: Response) => {
      const key = answerKey.safeParse(req.params.key);
      const body = answerBody.safeParse(req.body);
      if (!key.success || !body.success) {
        return sendError(res, 400, "INVALID_REQUEST", "Invalid answer", {
          key: key.success ? undefined : key.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        });
      }
      const saved = answers.upsert({
        key: key.data,
        value: body.data.value,
        isProtected: body.data.isProtected ?? false,
        notes: body.data.notes ?? null,
        updatedBy: req.user?.username ?? "unknown",
      });
      return sendOk(res, saved);
    },
  );

  app.use(
    requireUser,
    createLookupRoutes({
      jobOps,
      targets: createApplyTargetsRepo(db),
      boards: createGhBoardsRepo(db),
    }),
  );

  app.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Not found"));

  return app;
}
