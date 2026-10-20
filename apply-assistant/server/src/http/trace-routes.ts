import { type Response, Router } from "express";
import { z } from "zod";
import type { JobOpsApi } from "../jobops/client.js";
import type { RunsRepo } from "../store/runs-repo.js";
import type { TraceStore } from "../store/trace-store.js";
import type { AuthedRequest } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Run trace endpoints: the extension sends events and snapshots; the Timeline page and the
 * export bundle read them back (APPLY_TRACE_AND_KIT_PLAN.md §T1).
 */

const MAX_EVENTS = 200;
const MAX_DATA_CHARS = 20_000;
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024;
const RECENT_JOBS = 40;

const id = z.string().min(1).max(100);
const eventBody = z.object({
  jobId: id,
  runId: id.nullable().optional(),
  ts: z.string().datetime().optional(),
  source: z.enum(["extension", "page"]),
  kind: z.string().regex(/^[a-z][a-z-]{0,39}$/),
  stepSeq: z.number().int().min(0).nullable().optional(),
  message: z.string().min(1).max(2_000),
  data: z.unknown().optional(),
});
/** Events are checked one by one, so one bad event can't cost the rest of its batch. */
const eventsBody = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS),
});
const snapshotBody = z.object({
  jobId: id,
  runId: id.nullable().optional(),
  ts: z.string().datetime().optional(),
  kind: z.enum(["dom", "screenshot"]),
  reason: z.string().min(1).max(200),
  url: z.string().max(2_000).nullable().optional(),
  content: z.string().min(1).max(MAX_SNAPSHOT_CHARS),
});

/** Keeps one event's data small: oversized data becomes a truncated preview. */
function boundedData(data: unknown): unknown {
  if (data === undefined) return undefined;
  const text = JSON.stringify(data);
  return text.length <= MAX_DATA_CHARS
    ? data
    : { truncated: true, preview: text.slice(0, MAX_DATA_CHARS) };
}

const isJpeg = (bytes: Buffer) =>
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;

/** The sandboxed snapshot can't run anything or load anything from elsewhere. */
const SNAPSHOT_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export interface TraceRoutesDeps {
  readonly jobOps: JobOpsApi;
  readonly runs: RunsRepo;
  readonly trace: TraceStore;
}

export function createTraceRoutes({ jobOps, runs, trace }: TraceRoutesDeps) {
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";

  router.post("/trace/events", (req, res) => {
    const body = eventsBody.safeParse(req.body);
    if (!body.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid trace events",
        body.error.flatten(),
      );
      return;
    }
    const checked = body.data.events.map((e) => eventBody.safeParse(e));
    const rejected = checked.flatMap((result, index) =>
      result.success
        ? []
        : [
            {
              index,
              problems: result.error.issues.map(
                (i) => `${i.path.join(".") || "event"}: ${i.message}`,
              ),
            },
          ],
    );
    const saved = trace.addEvents(
      checked.flatMap((result) =>
        result.success
          ? [{ ...result.data, data: boundedData(result.data.data) }]
          : [],
      ),
    );
    // Rejected events leave a note in the job's trail, so the gap is visible there.
    const jobId = body.data.events
      .map((e) => (e as { jobId?: unknown } | null)?.jobId)
      .find(
        (j): j is string => typeof j === "string" && id.safeParse(j).success,
      );
    if (rejected.length && jobId)
      trace.record({
        jobId,
        kind: "trace-problem",
        message: `${rejected.length} trace event(s) rejected: ${rejected[0]?.problems.join("; ")}`,
        data: { rejected },
      });
    sendOk(res, { saved, rejected });
  });

  router.post("/trace/snapshots", (req, res) => {
    const body = snapshotBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "INVALID_REQUEST", "Invalid snapshot");
      return;
    }
    const { content, ...meta } = body.data;
    const bytes =
      meta.kind === "dom"
        ? Buffer.from(content, "utf8")
        : Buffer.from(content, "base64");
    if (meta.kind === "screenshot" && !isJpeg(bytes)) {
      sendError(res, 400, "INVALID_REQUEST", "Screenshots must be JPEG");
      return;
    }
    sendOk(res, trace.saveSnapshot({ ...meta, content: bytes }));
  });

  router.get("/trace/jobs", async (req: AuthedRequest, res: Response) => {
    const jobs = trace.recentJobs(RECENT_JOBS);
    const details = await Promise.allSettled(
      jobs.map((j) => jobOps.getJob(tokenOf(req), j.jobId)),
    );
    sendOk(
      res,
      jobs.map((j, i) => {
        const detail = details[i];
        const job = detail?.status === "fulfilled" ? detail.value : null;
        return {
          ...j,
          title: job?.title ?? null,
          employer: job?.employer ?? null,
          status: job?.status ?? null,
        };
      }),
    );
  });

  router.get("/trace/jobs/:jobId", (req, res) => {
    const jobId = String(req.params.jobId);
    const runId = typeof req.query.runId === "string" ? req.query.runId : "";
    sendOk(res, {
      runs: runs.listByJob(jobId),
      events: trace.events(jobId, runId ? { runId } : {}),
      snapshots: trace.snapshots(jobId),
    });
  });

  /** Everything about one job in one JSON document: what to hand over when something broke. */
  router.get(
    "/trace/jobs/:jobId/export",
    async (req: AuthedRequest, res: Response) => {
      const jobId = String(req.params.jobId);
      const withScreenshots = req.query.screenshots === "1";
      const job = await jobOps
        .getJob(tokenOf(req), jobId)
        .then(({ jobDescription: _omit, ...rest }) => rest)
        .catch(() => null);
      const snapshots = trace.snapshots(jobId).map((meta) => {
        if (meta.kind === "screenshot" && !withScreenshots) return meta;
        const stored = trace.readSnapshot(meta.id);
        if (!stored) return { ...meta, missing: true };
        return meta.kind === "dom"
          ? { ...meta, html: stored.content.toString("utf8") }
          : { ...meta, jpegBase64: stored.content.toString("base64") };
      });
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="trace-${jobId.replace(/[^A-Za-z0-9-]/g, "")}.json"`,
      );
      sendOk(res, {
        exportedAt: new Date().toISOString(),
        job,
        runs: runs
          .listByJob(jobId)
          .map((run) => ({ ...run, actions: runs.actions(run.id) })),
        events: trace.events(jobId, { limit: 10_000 }),
        snapshots,
      });
    },
  );

  router.get("/trace/snapshots/:id", (req, res) => {
    const stored = trace.readSnapshot(String(req.params.id));
    if (!stored) {
      sendError(res, 404, "SNAPSHOT_NOT_FOUND", "No such snapshot");
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (stored.meta.kind === "dom") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", SNAPSHOT_CSP);
    } else {
      res.setHeader("Content-Type", "image/jpeg");
    }
    res.end(stored.content);
  });

  return router;
}
