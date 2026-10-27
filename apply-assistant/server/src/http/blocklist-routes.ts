import { type Response, Router } from "express";
import { z } from "zod";
import { type JobOpsApi, JobOpsError } from "../jobops/client.js";
import type { BlockedSkipsRepo } from "../store/blocked-skips-repo.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Companies you never want to apply to. The list is Job Ops' own "blocked company keywords"
 * (Settings), so discovery drops them on every run and both apps show the same list. Blocking
 * also skips the company's Ready and Discovered jobs; unblocking puts those back as they were.
 */

/** Job Ops keeps at most this many keywords. */
const MAX_BLOCKED = 200;
/** What a job looked up for blocking may be: the rest are applied, skipped or closed. */
const ACTIVE_STATUSES = ["ready", "discovered"] as const;

const blockBody = z.object({ name: z.string().trim().min(2).max(200) });

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function createBlocklistRoutes(deps: {
  readonly jobOps: JobOpsApi;
  readonly skips: BlockedSkipsRepo;
}) {
  const { jobOps, skips } = deps;
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  const fail = (res: Response, error: unknown) => {
    if (error instanceof JobOpsError) {
      sendJobOpsFailure(res, error);
      return;
    }
    throw error;
  };

  router.get(
    "/blocked-companies",
    async (req: AuthedRequest, res: Response) => {
      if (!jobOps.getBlockedCompanies) {
        sendError(
          res,
          501,
          "UNSUPPORTED",
          "Blocking companies isn't available",
        );
        return;
      }
      try {
        const names = await jobOps.getBlockedCompanies(tokenOf(req));
        const counts = skips.counts();
        sendOk(
          res,
          names.map((name) => ({
            name,
            skippedJobs: counts.get(name.toLowerCase()) ?? 0,
          })),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.put(
    "/blocked-companies",
    async (req: AuthedRequest, res: Response) => {
      const body = blockBody.safeParse(req.body);
      if (!body.success) {
        sendError(
          res,
          400,
          "INVALID_REQUEST",
          "A company name (2 characters or more)",
        );
        return;
      }
      if (!jobOps.getBlockedCompanies || !jobOps.setBlockedCompanies) {
        sendError(
          res,
          501,
          "UNSUPPORTED",
          "Blocking companies isn't available",
        );
        return;
      }
      const token = tokenOf(req);
      const { name } = body.data;
      try {
        const names = await jobOps.getBlockedCompanies(token);
        if (!names.some((n) => same(n, name))) {
          if (names.length >= MAX_BLOCKED) {
            sendError(
              res,
              409,
              "LIST_FULL",
              `Job Ops keeps at most ${MAX_BLOCKED} blocked companies`,
            );
            return;
          }
          await jobOps.setBlockedCompanies(token, [...names, name]);
        }
        // As discovery matches: any company whose name contains it.
        const { jobs } = await jobOps.listJobs(token, ACTIVE_STATUSES);
        const matching = jobs.filter((job) =>
          job.employer.toLowerCase().includes(name.toLowerCase()),
        );
        for (const job of matching) {
          skips.add({
            keyword: name,
            jobId: job.id,
            previousStatus:
              job.status === "discovered" ? "discovered" : "ready",
          });
          await jobOps.skipJob(token, job.id);
          await jobOps.addNote(token, job.id, {
            title: "Skipped: company blocked",
            content: `You blocked "${name}" in Apply Copilot. Unblocking it there puts this job back.`,
          });
        }
        sendOk(res, { name, skippedJobs: matching.length });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.delete(
    "/blocked-companies/:name",
    async (req: AuthedRequest, res: Response) => {
      if (!jobOps.getBlockedCompanies || !jobOps.setBlockedCompanies) {
        sendError(
          res,
          501,
          "UNSUPPORTED",
          "Blocking companies isn't available",
        );
        return;
      }
      const token = tokenOf(req);
      const name = String(req.params.name);
      try {
        const names = await jobOps.getBlockedCompanies(token);
        const kept = names.filter((n) => !same(n, name));
        const skipped = skips.forKeyword(name);
        if (kept.length === names.length && skipped.length === 0) {
          sendError(res, 404, "NOT_FOUND", `"${name}" isn't blocked`);
          return;
        }
        if (kept.length !== names.length)
          await jobOps.setBlockedCompanies(token, kept);
        let restored = 0;
        for (const skip of skipped) {
          const job = await jobOps.getJob(token, skip.jobId).catch(() => null);
          // Only what is still skipped: a job you applied to or that closed stays as it is.
          if (job?.status !== "skipped") continue;
          await jobOps.updateJob(token, skip.jobId, {
            status: skip.previousStatus,
          });
          await jobOps.addNote(token, skip.jobId, {
            title: "Back: company unblocked",
            content: `You unblocked "${name}" in Apply Copilot.`,
          });
          restored++;
        }
        skips.clear(name);
        sendOk(res, { name, restoredJobs: restored });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  return router;
}
