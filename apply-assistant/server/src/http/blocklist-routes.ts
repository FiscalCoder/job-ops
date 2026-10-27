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
 * A block can last a number of days from your last application there: it ends by itself the
 * first time the list is read after that.
 */

/** Job Ops keeps at most this many keywords. */
const MAX_BLOCKED = 200;
/** What a job looked up for blocking may be: the rest are applied, skipped or closed. */
const ACTIVE_STATUSES = ["ready", "discovered"] as const;
/** Where your last application to a company is found. */
const APPLIED_STATUSES = ["applied", "in_progress"] as const;
const DAY_MS = 86_400_000;

const blockBody = z.object({
  name: z.string().trim().min(2).max(200),
  /** Days from your last application there (from today if none); absent blocks for good. */
  days: z.number().int().min(1).max(3650).optional(),
});

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const contains = (employer: string, name: string) =>
  employer.toLowerCase().includes(name.toLowerCase());
const day = (iso: string) => iso.slice(0, 10);

export function createBlocklistRoutes(deps: {
  readonly jobOps: JobOpsApi;
  readonly skips: BlockedSkipsRepo;
  readonly now?: () => Date;
}) {
  const { jobOps, skips } = deps;
  const now = deps.now ?? (() => new Date());
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  const fail = (res: Response, error: unknown) => {
    if (error instanceof JobOpsError) {
      sendJobOpsFailure(res, error);
      return;
    }
    throw error;
  };

  const unsupported = (res: Response) =>
    sendError(res, 501, "UNSUPPORTED", "Blocking companies isn't available");

  /** When a block for `days` ends: that many days after your last application there. */
  async function blockEnd(token: string, name: string, days: number) {
    const { jobs } = await jobOps.listJobs(token, APPLIED_STATUSES);
    const last = jobs
      .filter((job) => job.appliedAt && contains(job.employer, name))
      .map((job) => Date.parse(job.appliedAt ?? ""))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    const from = last ?? now().getTime();
    return {
      lastApplied: last === undefined ? null : new Date(last).toISOString(),
      until: new Date(from + days * DAY_MS).toISOString(),
    };
  }

  /** Takes the name off Job Ops' list and puts back the jobs blocking it skipped. */
  async function unblock(
    token: string,
    names: readonly string[],
    name: string,
  ) {
    const kept = names.filter((n) => !same(n, name));
    if (kept.length !== names.length)
      await jobOps.setBlockedCompanies?.(token, kept);
    let restored = 0;
    for (const skip of skips.forKeyword(name)) {
      const job = await jobOps.getJob(token, skip.jobId).catch(() => null);
      // Only what is still skipped: a job you applied to or that closed stays as it is.
      if (job?.status !== "skipped") continue;
      await jobOps.updateJob(token, skip.jobId, {
        status: skip.previousStatus,
      });
      await jobOps.addNote(token, skip.jobId, {
        title: "Back: company unblocked",
        content: `"${name}" was unblocked in Apply Copilot.`,
      });
      restored++;
    }
    skips.clear(name);
    return { kept, restored };
  }

  router.get(
    "/blocked-companies",
    async (req: AuthedRequest, res: Response) => {
      if (!jobOps.getBlockedCompanies || !jobOps.setBlockedCompanies) {
        unsupported(res);
        return;
      }
      const token = tokenOf(req);
      try {
        let names = await jobOps.getBlockedCompanies(token);
        // Blocks whose time is up end now.
        const at = now().getTime();
        for (const [keyword, until] of skips.untils()) {
          if (Date.parse(until) > at) continue;
          names = (await unblock(token, names, keyword)).kept;
        }
        const counts = skips.counts();
        const untils = skips.untils();
        sendOk(
          res,
          names.map((name) => ({
            name,
            skippedJobs: counts.get(name.toLowerCase()) ?? 0,
            until: untils.get(name.toLowerCase()) ?? null,
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
          "A company name (2 characters or more) and, optionally, whole days (1 to 3650)",
        );
        return;
      }
      if (!jobOps.getBlockedCompanies || !jobOps.setBlockedCompanies) {
        unsupported(res);
        return;
      }
      const token = tokenOf(req);
      const { name, days } = body.data;
      try {
        let until: string | null = null;
        if (days !== undefined) {
          const end = await blockEnd(token, name, days);
          if (Date.parse(end.until) <= now().getTime()) {
            sendError(
              res,
              409,
              "ALREADY_OVER",
              `You last applied to ${name} on ${day(end.lastApplied ?? "")}: ${days} days from then ended on ${day(end.until)}`,
            );
            return;
          }
          until = end.until;
        }
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
        skips.setUntil(name, until);
        // As discovery matches: any company whose name contains it.
        const { jobs } = await jobOps.listJobs(token, ACTIVE_STATUSES);
        const matching = jobs.filter((job) => contains(job.employer, name));
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
            content: `You blocked "${name}" in Apply Copilot${until ? ` until ${day(until)}` : ""}. Unblocking it puts this job back.`,
          });
        }
        sendOk(res, { name, skippedJobs: matching.length, until });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.delete(
    "/blocked-companies/:name",
    async (req: AuthedRequest, res: Response) => {
      if (!jobOps.getBlockedCompanies || !jobOps.setBlockedCompanies) {
        unsupported(res);
        return;
      }
      const token = tokenOf(req);
      const name = String(req.params.name);
      try {
        const names = await jobOps.getBlockedCompanies(token);
        const known =
          names.some((n) => same(n, name)) ||
          skips.forKeyword(name).length > 0 ||
          skips.untils().has(name.toLowerCase());
        if (!known) {
          sendError(res, 404, "NOT_FOUND", `"${name}" isn't blocked`);
          return;
        }
        const { restored } = await unblock(token, names, name);
        sendOk(res, { name, restoredJobs: restored });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  return router;
}
