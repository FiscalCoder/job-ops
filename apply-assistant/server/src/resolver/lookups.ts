import { z } from "zod";
import type { JobOpsApi, JobOpsJob } from "../jobops/client.js";
import { parseGreenhouseSchema } from "../plan/gh-schema.js";
import type { PlanSummary } from "../plan/planner.js";
import type { PlansService } from "../plan/plans-service.js";
import type {
  ApplyTarget,
  ApplyTargetsRepo,
} from "../store/apply-targets-repo.js";
import type { FillPlansRepo } from "../store/fill-plans-repo.js";
import type { FormSchemasRepo } from "../store/form-schemas-repo.js";
import type { GhBoardsRepo } from "../store/gh-boards-repo.js";
import { classifyApplyUrl } from "./greenhouse-url.js";
import { matchOnBoard } from "./match.js";
import { employerKey } from "./text.js";

/**
 * Server half of the resolver. The extension (your browser, your IP) performs the outside
 * lookups; this decides WHAT to look up, matches the results, remembers them, and writes the
 * Greenhouse link back to Job Ops. The server itself never contacts third-party sites.
 */

export const QUEUE_STATUSES = ["ready"] as const;

/**
 * Lookups run before tailoring too, so you know which high scorers are on Greenhouse before
 * spending effort on a resume. Ready jobs are always looked up; Discovered ones only at 70+.
 */
const LOOKUP_STATUSES = ["ready", "discovered"] as const;
const LOOKUP_MIN_DISCOVERED_SCORE = 70;

const worthLookingUp = (job: JobOpsJob) =>
  job.status === "ready" ||
  (job.suitabilityScore ?? 0) >= LOOKUP_MIN_DISCOVERED_SCORE;

export type LookupTask =
  | { type: "verify-job"; token: string; ghJobId: string; region: "us" | "eu" }
  | { type: "resolve-embedded"; ghJobId: string; pageUrl: string }
  | { type: "follow-short-link"; url: string }
  | { type: "list-board"; token: string }
  | { type: "find-board"; employer: string }
  | { type: "fetch-schema"; token: string; ghJobId: string };

export interface PendingLookup {
  readonly jobId: string;
  readonly employer: string;
  readonly title: string;
  readonly task: LookupTask;
}

const boardJob = z.object({
  id: z.string(),
  title: z.string(),
  location: z.string(),
  url: z.string().url(),
});

export const lookupResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("job"),
    jobId: z.string().min(1),
    token: z.string().min(1),
    ghJobId: z.string().min(1),
    url: z.string().url(),
    live: z.boolean(),
  }),
  z.object({
    type: z.literal("board"),
    jobId: z.string().min(1),
    employer: z.string().min(1),
    token: z.string().min(1).nullable(),
    method: z.string().min(1),
    jobs: z.array(boardJob).max(2000).optional(),
    details: z.record(z.string(), z.string().max(200_000)).optional(),
  }),
  z.object({
    type: z.literal("schema"),
    jobId: z.string().min(1),
    token: z.string().min(1),
    ghJobId: z.string().min(1),
    /** Greenhouse's `?questions=true` job payload, as fetched. */
    payload: z.unknown(),
  }),
]);
export type LookupResult = z.infer<typeof lookupResultSchema>;

export type ResultOutcome =
  | { status: "need-details"; ghJobIds: string[] }
  | {
      status: "matched" | "possible";
      ghUrl: string;
      titleScore: number | null;
      descScore: number | null;
    }
  | { status: "none" | "closed"; reason: string }
  | { status: "planned"; summary: PlanSummary };

/** A lookup result the server can't accept (wrong posting, not a Greenhouse form). */
export class InvalidLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLookupError";
  }
}

const isSettled = (target: ApplyTarget | null) =>
  target !== null && target.status !== "none";

export interface LookupsDeps {
  readonly jobOps: JobOpsApi;
  readonly targets: ApplyTargetsRepo;
  readonly boards: GhBoardsRepo;
  readonly schemas: FormSchemasRepo;
  readonly plans: PlansService;
  readonly planStore: FillPlansRepo;
}

export function createLookups(deps: LookupsDeps) {
  const { jobOps, targets, boards, schemas, plans, planStore } = deps;

  const taskFor = (job: JobOpsJob): LookupTask | null => {
    const link = classifyApplyUrl(job.applicationLink ?? job.jobUrl);
    if (link.kind === "greenhouse-job")
      return {
        type: "verify-job",
        token: link.token,
        ghJobId: link.ghJobId,
        region: link.region,
      };
    if (link.kind === "greenhouse-embedded")
      return {
        type: "resolve-embedded",
        ghJobId: link.ghJobId,
        pageUrl: link.pageUrl,
      };
    if (link.kind === "greenhouse-short")
      return { type: "follow-short-link", url: link.url };
    const cached = boards.getFresh(employerKey(job.employer));
    if (cached)
      return cached.token ? { type: "list-board", token: cached.token } : null;
    return { type: "find-board", employer: job.employer };
  };

  /** Matched postings need their form fetched (again, once it goes stale) to be planned. */
  const nextTaskFor = (job: JobOpsJob): LookupTask | null => {
    const target = targets.get(job.id);
    if (!isSettled(target)) return taskFor(job);
    if (target?.status !== "matched" || !target.ghToken || !target.ghJobId)
      return null;
    return schemas.getFresh(target.ghToken, target.ghJobId)
      ? null
      : {
          type: "fetch-schema",
          token: target.ghToken,
          ghJobId: target.ghJobId,
        };
  };

  async function pending(token: string): Promise<PendingLookup[]> {
    const { jobs } = await jobOps.listJobs(token, LOOKUP_STATUSES);
    return jobs
      .filter(worthLookingUp)
      .map((job) => ({ job, task: nextTaskFor(job) }))
      .filter(
        (entry): entry is { job: JobOpsJob; task: LookupTask } =>
          entry.task !== null,
      )
      .map(({ job, task }) => ({
        jobId: job.id,
        employer: job.employer,
        title: job.title,
        task,
      }));
  }

  async function writeBack(
    token: string,
    jobId: string,
    currentLink: string | null,
    ghUrl: string,
    note: { title: string; content: string },
  ) {
    if (currentLink !== ghUrl)
      await jobOps.updateJob(token, jobId, { applicationLink: ghUrl });
    await jobOps.addNote(token, jobId, note);
  }

  async function apply(
    token: string,
    result: LookupResult,
  ): Promise<ResultOutcome> {
    if (result.type === "schema") return applySchema(token, result);
    const job = await jobOps.getJob(token, result.jobId);

    if (result.type === "job") {
      if (!result.live) {
        targets.upsert({
          jobId: job.id,
          ghToken: result.token,
          ghJobId: result.ghJobId,
          ghUrl: result.url,
          matchMethod: "direct",
          titleScore: null,
          descScore: null,
          status: "closed",
        });
        await jobOps.addNote(token, job.id, {
          title: "Greenhouse posting closed",
          content: `The Greenhouse posting is no longer open: ${result.url}`,
        });
        return { status: "closed", reason: "posting closed" };
      }
      targets.upsert({
        jobId: job.id,
        ghToken: result.token,
        ghJobId: result.ghJobId,
        ghUrl: result.url,
        matchMethod: "direct",
        titleScore: null,
        descScore: null,
        status: "matched",
      });
      await writeBack(token, job.id, job.applicationLink, result.url, {
        title: "Greenhouse posting confirmed",
        content: `Live Greenhouse posting (board ${result.token}, job ${result.ghJobId}): ${result.url}`,
      });
      return {
        status: "matched",
        ghUrl: result.url,
        titleScore: null,
        descScore: null,
      };
    }

    boards.save(employerKey(result.employer), result.token, result.method);
    if (!result.token) {
      targets.upsert({
        jobId: job.id,
        ghToken: null,
        ghJobId: null,
        ghUrl: null,
        matchMethod: result.method,
        titleScore: null,
        descScore: null,
        status: "none",
      });
      return { status: "none", reason: "company has no Greenhouse board" };
    }

    const match = matchOnBoard(
      {
        title: job.title,
        location: job.location ?? "",
        description: job.jobDescription ?? "",
      },
      result.jobs ?? [],
      result.details ?? {},
    );
    if (match.status === "need-details") return match;
    if (match.status === "none") {
      targets.upsert({
        jobId: job.id,
        ghToken: result.token,
        ghJobId: null,
        ghUrl: null,
        matchMethod: result.method,
        titleScore: null,
        descScore: null,
        status: "none",
      });
      return { status: "none", reason: match.reason };
    }

    targets.upsert({
      jobId: job.id,
      ghToken: result.token,
      ghJobId: match.job.id,
      ghUrl: match.job.url,
      matchMethod: result.method,
      titleScore: match.titleScore,
      descScore: match.descScore,
      status: match.status,
    });
    if (match.status === "matched") {
      await writeBack(token, job.id, job.applicationLink, match.job.url, {
        title: "Matched on Greenhouse",
        content: `Board ${result.token} (${result.method}), posting ${match.job.id}: ${match.job.url}. Title ${match.titleScore.toFixed(2)}, description ${match.descScore?.toFixed(2) ?? "n/a"}.`,
      });
    }
    return {
      status: match.status,
      ghUrl: match.job.url,
      titleScore: match.titleScore,
      descScore: match.descScore,
    };
  }

  async function applySchema(
    token: string,
    result: Extract<LookupResult, { type: "schema" }>,
  ): Promise<ResultOutcome> {
    const target = targets.get(result.jobId);
    if (
      target?.status !== "matched" ||
      target.ghToken !== result.token ||
      target.ghJobId !== result.ghJobId
    )
      throw new InvalidLookupError(
        "That form isn't the Greenhouse posting matched to this job",
      );
    let schema: ReturnType<typeof parseGreenhouseSchema>;
    try {
      schema = parseGreenhouseSchema(result.payload);
    } catch (error) {
      throw new InvalidLookupError(
        error instanceof Error ? error.message : "Not a Greenhouse form",
      );
    }
    if (schema.ghJobId !== result.ghJobId)
      throw new InvalidLookupError("The form is for a different posting");
    schemas.save(result.token, result.ghJobId, result.payload, schema.hash);
    const plan = await plans.build(token, result.jobId);
    return { status: "planned", summary: plan.summary };
  }

  async function queue(token: string) {
    const summaries = planStore.summaries();
    const { jobs } = await jobOps.listJobs(token, QUEUE_STATUSES);
    return [...jobs]
      .sort((a, b) => (b.suitabilityScore ?? 0) - (a.suitabilityScore ?? 0))
      .map((job) => {
        const target = targets.get(job.id);
        return {
          jobId: job.id,
          title: job.title,
          employer: job.employer,
          score: job.suitabilityScore,
          greenhouse: target
            ? {
                status: target.status,
                ghUrl: target.ghUrl,
                titleScore: target.titleScore,
                descScore: target.descScore,
              }
            : { status: "pending" as const },
          plan: summaries.get(job.id) ?? null,
        };
      });
  }

  return { pending, apply, queue };
}
