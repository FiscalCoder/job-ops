import { type Response, Router } from "express";
import { z } from "zod";
import type { JobOpsApi } from "../jobops/client.js";
import type { TraceRecord } from "../store/trace-store.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Adding a job from its link (Job Ops' manual import). The extension reads the page in your
 * browser and sends its text: this server never fetches the job's site itself.
 */

/** Pages never read (LinkedIn is copy-only; Job Ops doesn't auto-fetch Indeed either). */
const NOT_READ = /(^|\.)(linkedin\.com|indeed\.[a-z.]+)$/i;
/** Job Ops' own limit on a manual job's description. */
const MAX_DESCRIPTION = 40_000;

const pageUrl = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((u) => /^https?:\/\//i.test(u), "Not a web link")
  .refine((u) => !NOT_READ.test(new URL(u).hostname), "LinkedIn and Indeed pages aren't read");

const inferBody = z.object({
  url: pageUrl,
  content: z.string().trim().min(50).max(60_000),
});

const optional = z.string().trim().max(200).optional();
const importBody = z.object({
  job: z.object({
    title: z.string().trim().min(1).max(500),
    employer: z.string().trim().min(1).max(500),
    jobUrl: pageUrl,
    applicationLink: pageUrl.optional(),
    location: optional,
    salary: optional,
    deadline: z.string().trim().max(100).optional(),
    jobType: optional,
    jobLevel: optional,
    jobDescription: z.string().trim().min(1).max(60_000),
  }),
});

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "Invalid request";

export function createImportRoutes(deps: {
  readonly jobOps: JobOpsApi;
  readonly trace?: TraceRecord;
}) {
  const { jobOps } = deps;
  const trace = deps.trace ?? (() => {});
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  /** The job's details as Job Ops' model reads them from the page's text, for you to check. */
  router.post("/jobs/import/read", async (req: AuthedRequest, res: Response) => {
    const body = inferBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", firstIssue(body.error));
      return;
    }
    if (!jobOps.inferJob) {
      sendError(res, 501, "NOT_AVAILABLE", "Job Ops' import isn't available");
      return;
    }
    try {
      const read = await jobOps.inferJob(
        tokenOf(req),
        body.data.content.slice(0, MAX_DESCRIPTION),
      );
      sendOk(res, read);
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  /** Adds the job to Job Ops; it then tailors your resume and scores it as for any job. */
  router.post("/jobs/import", async (req: AuthedRequest, res: Response) => {
    const body = importBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", firstIssue(body.error));
      return;
    }
    if (!jobOps.importJob) {
      sendError(res, 501, "NOT_AVAILABLE", "Job Ops' import isn't available");
      return;
    }
    const job = {
      ...body.data.job,
      jobDescription: body.data.job.jobDescription.slice(0, MAX_DESCRIPTION),
    };
    try {
      const created = await jobOps.importJob(tokenOf(req), job);
      trace({
        jobId: created.id,
        kind: "imported",
        message: `Added from its link: ${job.title} · ${job.employer} (${job.jobUrl})`,
      });
      sendOk(res, { jobId: created.id, status: created.status });
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  return router;
}
