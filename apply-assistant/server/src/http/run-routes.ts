import { type Response, Router } from "express";
import { z } from "zod";
import { type JobOpsApi, JobOpsError } from "../jobops/client.js";
import type { AnswerBankRepo } from "../store/answer-bank-repo.js";
import { RunConflictError, type RunsRepo } from "../store/runs-repo.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * What the extension needs during a supervised run: the tailored PDF, and a log of every action.
 * Completing a run as "submitted" (you clicked Submit) marks the job applied in Job Ops.
 */

const actionBody = z.object({
  seq: z.number().int().min(1),
  actionClass: z.string().min(1).max(30),
  fieldRef: z.string().min(1).max(200),
  valueMasked: z.string().max(500).nullable().optional(),
  source: z.string().max(200).nullable().optional(),
  decision: z.string().min(1).max(30),
  decidedBy: z.string().min(1).max(30),
  result: z.string().min(1).max(500),
});
const completeBody = z.object({ outcome: z.enum(["submitted", "aborted"]) });
const startBody = z.object({ jobId: z.string().min(1) });

const safeFilePart = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 40);

export interface RunRoutesDeps {
  readonly jobOps: JobOpsApi;
  readonly runs: RunsRepo;
  readonly answers: AnswerBankRepo;
}

export function createRunRoutes({ jobOps, runs, answers }: RunRoutesDeps) {
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  const failJobOps = (res: Response, error: unknown) => {
    if (error instanceof JobOpsError && error.status === 404) {
      sendError(
        res,
        404,
        "JOB_NOT_FOUND",
        "Job Ops has no job (or tailored PDF) with that id",
      );
      return;
    }
    sendJobOpsFailure(res, error);
  };

  const conflictOr = (res: Response, error: unknown) => {
    if (error instanceof RunConflictError) {
      sendError(res, 409, "RUN_CONFLICT", error.message);
      return;
    }
    throw error;
  };

  router.get(
    "/jobs/:jobId/resume.pdf",
    async (req: AuthedRequest, res: Response) => {
      try {
        const pdf = await jobOps.getPdf(tokenOf(req), String(req.params.jobId));
        const name = [
          answers.get("identity.first_name")?.value,
          answers.get("identity.last_name")?.value,
        ]
          .map((part) => safeFilePart(part ?? ""))
          .filter(Boolean);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${[...name, "Resume"].join("_")}.pdf"`,
        );
        res.setHeader("Cache-Control", "no-store");
        res.end(Buffer.from(pdf));
      } catch (error) {
        failJobOps(res, error);
      }
    },
  );

  router.post("/runs", async (req: AuthedRequest, res: Response) => {
    const body = startBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", "jobId is required");
      return;
    }
    try {
      await jobOps.getJob(tokenOf(req), body.data.jobId);
    } catch (error) {
      failJobOps(res, error);
      return;
    }
    sendOk(res, runs.create(body.data.jobId));
  });

  router.get("/runs", (req, res) => {
    const jobId = typeof req.query.jobId === "string" ? req.query.jobId : "";
    if (!jobId) {
      sendError(res, 400, "INVALID_REQUEST", "jobId is required");
      return;
    }
    sendOk(res, runs.listByJob(jobId));
  });

  router.get("/runs/:id", (req, res) => {
    const run = runs.get(String(req.params.id));
    if (!run) {
      sendError(res, 404, "RUN_NOT_FOUND", "No such run");
      return;
    }
    sendOk(res, { ...run, actions: runs.actions(run.id) });
  });

  router.post("/runs/:id/actions", (req, res) => {
    const body = actionBody.safeParse(req.body);
    if (!body.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid action",
        body.error.flatten(),
      );
      return;
    }
    try {
      const saved = runs.addAction(String(req.params.id), {
        ...body.data,
        valueMasked: body.data.valueMasked ?? null,
        source: body.data.source ?? null,
      });
      if (!saved) {
        sendError(res, 404, "RUN_NOT_FOUND", "No such run");
        return;
      }
      sendOk(res, saved);
    } catch (error) {
      conflictOr(res, error);
    }
  });

  router.post(
    "/runs/:id/complete",
    async (req: AuthedRequest, res: Response) => {
      const body = completeBody.safeParse(req.body);
      if (!body.success) {
        sendError(
          res,
          400,
          "INVALID_REQUEST",
          "outcome must be submitted or aborted",
        );
        return;
      }
      let finished: ReturnType<RunsRepo["complete"]>;
      try {
        finished = runs.complete(String(req.params.id), body.data.outcome);
      } catch (error) {
        conflictOr(res, error);
        return;
      }
      if (!finished) {
        sendError(res, 404, "RUN_NOT_FOUND", "No such run");
        return;
      }
      const { run, actions } = finished;
      if (run.outcome === "submitted") {
        try {
          await jobOps.updateJob(tokenOf(req), run.jobId, {
            status: "applied",
          });
          await jobOps.addNote(tokenOf(req), run.jobId, {
            title: "Applied via Apply Copilot",
            content: `Greenhouse application filled with Apply Copilot and submitted by you: ${actions.length} steps, ${run.interventions} by you. Run ${run.id}.`,
          });
        } catch (error) {
          sendJobOpsFailure(res, error);
          return;
        }
      }
      sendOk(res, { ...run, actions: actions.length });
    },
  );

  return router;
}
