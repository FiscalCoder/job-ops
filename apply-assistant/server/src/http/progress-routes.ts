import { type Response, Router } from "express";
import type { JobOpsApi } from "../jobops/client.js";
import { computeProgress } from "../progress/progress.js";
import type { RunsRepo } from "../store/runs-repo.js";
import type { TraceStore } from "../store/trace-store.js";
import type { AuthedRequest } from "./auth.js";
import { sendOk } from "./envelope.js";

/** GET /progress: the M4 targets and each submitted supervised application. */
export function createProgressRoutes(deps: {
  readonly jobOps: JobOpsApi;
  readonly runs: RunsRepo;
  readonly trace: TraceStore;
}) {
  const { jobOps, runs, trace } = deps;
  const router = Router();

  router.get("/progress", async (req: AuthedRequest, res: Response) => {
    const progress = computeProgress({
      runs: runs.all(),
      actionsOf: (runId) => runs.actions(runId),
      eventsOf: (jobId) => trace.events(jobId, { limit: 10_000 }),
      manualApplications: trace
        .eventsOfKind("kit-outcome")
        .filter(
          (e) =>
            e.source === "server" &&
            (e.data as { outcome?: string } | null)?.outcome === "applied",
        ).length,
    });
    const jobIds = [...new Set(progress.applications.map((a) => a.jobId))];
    const details = await Promise.allSettled(
      jobIds.map((id) => jobOps.getJob(req.jobOpsToken ?? "", id)),
    );
    const titles = new Map(
      jobIds.map((id, i) => {
        const d = details[i];
        return [
          id,
          d?.status === "fulfilled"
            ? { title: d.value.title, employer: d.value.employer }
            : { title: null, employer: null },
        ];
      }),
    );
    sendOk(res, {
      ...progress,
      applications: progress.applications.map((a) => ({
        ...a,
        ...titles.get(a.jobId),
      })),
    });
  });

  return router;
}
