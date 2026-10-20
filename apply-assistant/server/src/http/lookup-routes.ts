import { type Response, Router } from "express";
import { ATS_LIST, ATS_NAMES } from "../ats.js";
import { JobOpsError } from "../jobops/client.js";
import {
  createLookups,
  InvalidLookupError,
  type LookupResult,
  type LookupsDeps,
  lookupResultSchema,
  type ResultOutcome,
} from "../resolver/lookups.js";
import type { TraceRecord } from "../store/trace-store.js";
import type { AuthedRequest } from "./auth.js";
import { sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/** Resolver endpoints used by the extension, plus the queue the side panel shows. */
/** One line per lookup result, for the job's trace. */
function lookupLine(result: LookupResult, outcome: ResultOutcome): string {
  // "No board" covers every system searched, not just the one the result names.
  if (result.type === "board" && result.token === null)
    return `Lookup: ${result.employer} has no board on ${ATS_LIST.map((a) => ATS_NAMES[a]).join(", ")} (${result.method})`;
  const what =
    result.type === "board"
      ? `board ${result.token ?? "none"} (${result.method})`
      : result.type === "job"
        ? `posting ${result.postingId}${result.live ? "" : " (closed)"}`
        : `form for posting ${result.postingId}`;
  const status =
    outcome.status === "need-details"
      ? `needs details for ${outcome.postingIds.length} posting(s)`
      : outcome.status === "planned"
        ? `planned (${outcome.summary.fill} to fill, ${outcome.summary.needsYou} need you)`
        : "reason" in outcome
          ? `${outcome.status}: ${outcome.reason}`
          : outcome.status;
  return `Lookup on ${result.ats}: ${what} → ${status}`;
}

export function createLookupRoutes(
  deps: LookupsDeps & { readonly trace?: TraceRecord },
) {
  const router = Router();
  const lookups = createLookups(deps);
  const trace = deps.trace ?? (() => {});

  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  router.get("/lookups/pending", async (req: AuthedRequest, res: Response) => {
    try {
      sendOk(res, await lookups.pending(tokenOf(req)));
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  router.post("/lookups/results", async (req: AuthedRequest, res: Response) => {
    const parsed = lookupResultSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid lookup result",
        parsed.error.flatten(),
      );
      return;
    }
    try {
      const outcome = await lookups.apply(tokenOf(req), parsed.data);
      trace({
        jobId: parsed.data.jobId,
        kind: "lookup",
        message: lookupLine(parsed.data, outcome),
        data: { type: parsed.data.type, ats: parsed.data.ats, outcome },
      });
      sendOk(res, outcome);
    } catch (error) {
      if (error instanceof InvalidLookupError) {
        sendError(res, 400, "INVALID_LOOKUP", error.message);
        return;
      }
      if (error instanceof JobOpsError && error.status === 404) {
        sendError(res, 404, "JOB_NOT_FOUND", "Job Ops has no job with that id");
        return;
      }
      sendJobOpsFailure(res, error);
    }
  });

  router.get("/queue", async (req: AuthedRequest, res: Response) => {
    try {
      sendOk(res, await lookups.queue(tokenOf(req)));
    } catch (error) {
      sendJobOpsFailure(res, error);
    }
  });

  return router;
}
