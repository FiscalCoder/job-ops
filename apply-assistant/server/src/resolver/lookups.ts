import { z } from "zod";
import { ATS_LIST, ATS_NAMES, type Ats } from "../ats.js";
import type { JobOpsApi, JobOpsJob } from "../jobops/client.js";
import type { PlanSummary } from "../plan/planner.js";
import type { PlansService } from "../plan/plans-service.js";
import { parseFormSchema } from "../plan/schemas.js";
import type {
  ApplyTarget,
  ApplyTargetsRepo,
} from "../store/apply-targets-repo.js";
import type { AtsBoardsRepo } from "../store/ats-boards-repo.js";
import type { CompanyLimitsRepo } from "../store/company-limits-repo.js";
import type { FillPlansRepo } from "../store/fill-plans-repo.js";
import type { FormSchemasRepo } from "../store/form-schemas-repo.js";
import { classifyApplyUrl } from "./greenhouse-url.js";
import { matchOnBoard } from "./match.js";
import {
  companyWindow,
  limitFor,
  type PastApplication,
} from "./company-window.js";
import { employerKey } from "./text.js";

/**
 * Server half of the resolver. The extension (your browser, your IP) performs the outside
 * lookups; this decides WHAT to look up, matches the results, remembers them, and writes the
 * posting's link back to Job Ops. The server itself never contacts third-party sites.
 */

export const QUEUE_STATUSES = ["ready"] as const;
/** Your past applications: what limited companies (one per six months, ...) count. */
const APPLIED_STATUSES = ["applied", "in_progress"] as const;

/**
 * Lookups run before tailoring too, so you know which high scorers have a fillable form before
 * spending effort on a resume. Ready jobs are always looked up; Discovered ones only at 70+.
 */
export const LOOKUP_STATUSES = ["ready", "discovered"] as const;
const LOOKUP_MIN_DISCOVERED_SCORE = 70;

const worthLookingUp = (job: JobOpsJob) =>
  job.status === "ready" ||
  (job.suitabilityScore ?? 0) >= LOOKUP_MIN_DISCOVERED_SCORE;

export type LookupTask =
  | {
      type: "verify-job";
      ats: Ats;
      token: string;
      postingId: string;
      region: "us" | "eu";
    }
  | { type: "resolve-embedded"; postingId: string; pageUrl: string }
  | { type: "follow-short-link"; url: string }
  | { type: "list-board"; ats: Ats; token: string }
  | { type: "find-board"; employer: string }
  | { type: "fetch-schema"; ats: Ats; token: string; postingId: string };

export interface PendingLookup {
  readonly jobId: string;
  readonly employer: string;
  readonly title: string;
  readonly task: LookupTask;
}

// Older extension builds don't send the system: they only ever looked up Greenhouse.
const ats = z.enum(ATS_LIST).default("greenhouse");

const boardJob = z.object({
  id: z.string(),
  title: z.string(),
  location: z.string(),
  url: z.string().url(),
});

export const lookupResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("job"),
    ats,
    jobId: z.string().min(1),
    token: z.string().min(1),
    postingId: z.string().min(1),
    url: z.string().url(),
    live: z.boolean(),
  }),
  z.object({
    type: z.literal("board"),
    ats,
    jobId: z.string().min(1),
    employer: z.string().min(1),
    token: z.string().min(1).nullable(),
    method: z.string().min(1),
    jobs: z.array(boardJob).max(2000).optional(),
    details: z.record(z.string(), z.string().max(200_000)).optional(),
  }),
  z.object({
    type: z.literal("schema"),
    ats,
    jobId: z.string().min(1),
    token: z.string().min(1),
    postingId: z.string().min(1),
    /** The system's form definition as fetched (Greenhouse `?questions=true`, Ashby's form query). */
    payload: z.unknown(),
  }),
]);
export type LookupResult = z.infer<typeof lookupResultSchema>;

export type ResultOutcome =
  | { status: "need-details"; postingIds: string[] }
  | {
      status: "matched" | "possible";
      postingUrl: string;
      titleScore: number | null;
      descScore: number | null;
    }
  | { status: "none" | "closed"; reason: string }
  | { status: "planned"; summary: PlanSummary };

/** A lookup result the server can't accept (wrong posting, not a form of that system). */
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
  readonly boards: AtsBoardsRepo;
  readonly schemas: FormSchemasRepo;
  readonly plans: PlansService;
  readonly planStore: FillPlansRepo;
  /** Companies that take only so many applications from you (absent: none limited). */
  readonly limits?: CompanyLimitsRepo;
}

export function createLookups(deps: LookupsDeps) {
  const { jobOps, targets, boards, schemas, plans, planStore } = deps;

  const taskFor = (job: JobOpsJob): LookupTask | null => {
    const link = classifyApplyUrl(job.applicationLink ?? job.jobUrl);
    if (link.kind === "greenhouse-job")
      return {
        type: "verify-job",
        ats: "greenhouse",
        token: link.token,
        postingId: link.postingId,
        region: link.region,
      };
    if (link.kind === "greenhouse-embedded")
      return {
        type: "resolve-embedded",
        postingId: link.postingId,
        pageUrl: link.pageUrl,
      };
    if (link.kind === "greenhouse-short")
      return { type: "follow-short-link", url: link.url };
    if (link.kind === "posting")
      return {
        type: "verify-job",
        ats: link.ats,
        token: link.token,
        postingId: link.postingId,
        region: "us",
      };
    const cached = boards.getFresh(employerKey(job.employer));
    if (cached)
      return cached.ats && cached.token
        ? { type: "list-board", ats: cached.ats, token: cached.token }
        : null;
    return { type: "find-board", employer: job.employer };
  };

  /** Matched postings need their form fetched (again, once it goes stale) to be planned. */
  const nextTaskFor = (job: JobOpsJob): LookupTask | null => {
    const target = targets.get(job.id);
    if (!isSettled(target)) return taskFor(job);
    if (target?.status !== "matched" || !target.boardToken || !target.postingId)
      return null;
    return schemas.getFresh(target.ats, target.boardToken, target.postingId)
      ? null
      : {
          type: "fetch-schema",
          ats: target.ats,
          token: target.boardToken,
          postingId: target.postingId,
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
    postingUrl: string,
    note: { title: string; content: string },
  ) {
    if (currentLink !== postingUrl)
      await jobOps.updateJob(token, jobId, { applicationLink: postingUrl });
    await jobOps.addNote(token, jobId, note);
  }

  async function apply(
    token: string,
    result: LookupResult,
  ): Promise<ResultOutcome> {
    if (result.type === "schema") return applySchema(token, result);
    const job = await jobOps.getJob(token, result.jobId);

    if (result.type === "job") {
      const system = ATS_NAMES[result.ats];
      if (!result.live) {
        targets.upsert({
          jobId: job.id,
          ats: result.ats,
          boardToken: result.token,
          postingId: result.postingId,
          postingUrl: result.url,
          matchMethod: "direct",
          titleScore: null,
          descScore: null,
          status: "closed",
        });
        await jobOps.addNote(token, job.id, {
          title: `${system} posting closed`,
          content: `The ${system} posting is no longer open: ${result.url}`,
        });
        return { status: "closed", reason: "posting closed" };
      }
      targets.upsert({
        jobId: job.id,
        ats: result.ats,
        boardToken: result.token,
        postingId: result.postingId,
        postingUrl: result.url,
        matchMethod: "direct",
        titleScore: null,
        descScore: null,
        status: "matched",
      });
      await writeBack(token, job.id, job.applicationLink, result.url, {
        title: `${system} posting confirmed`,
        content: `Live ${system} posting (board ${result.token}, job ${result.postingId}): ${result.url}`,
      });
      return {
        status: "matched",
        postingUrl: result.url,
        titleScore: null,
        descScore: null,
      };
    }

    boards.save(
      employerKey(result.employer),
      result.token ? { ats: result.ats, token: result.token } : null,
      result.method,
    );
    if (!result.token) {
      targets.upsert({
        jobId: job.id,
        ats: result.ats,
        boardToken: null,
        postingId: null,
        postingUrl: null,
        matchMethod: result.method,
        titleScore: null,
        descScore: null,
        status: "none",
      });
      return {
        status: "none",
        reason: "company has no board on a supported system",
      };
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
        ats: result.ats,
        boardToken: result.token,
        postingId: null,
        postingUrl: null,
        matchMethod: result.method,
        titleScore: null,
        descScore: null,
        status: "none",
      });
      return { status: "none", reason: match.reason };
    }

    targets.upsert({
      jobId: job.id,
      ats: result.ats,
      boardToken: result.token,
      postingId: match.job.id,
      postingUrl: match.job.url,
      matchMethod: result.method,
      titleScore: match.titleScore,
      descScore: match.descScore,
      status: match.status,
    });
    if (match.status === "matched") {
      await writeBack(token, job.id, job.applicationLink, match.job.url, {
        title: `Matched on ${ATS_NAMES[result.ats]}`,
        content: `Board ${result.token} (${result.method}), posting ${match.job.id}: ${match.job.url}. Title ${match.titleScore.toFixed(2)}, description ${match.descScore?.toFixed(2) ?? "n/a"}.`,
      });
    }
    return {
      status: match.status,
      postingUrl: match.job.url,
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
      target.ats !== result.ats ||
      target.boardToken !== result.token ||
      target.postingId !== result.postingId
    )
      throw new InvalidLookupError(
        "That form isn't the posting matched to this job",
      );
    let schema: ReturnType<typeof parseFormSchema>;
    try {
      schema = parseFormSchema(result.ats, result.payload);
    } catch (error) {
      throw new InvalidLookupError(
        error instanceof Error
          ? error.message
          : `Not a ${ATS_NAMES[result.ats]} form`,
      );
    }
    if (schema.postingId !== result.postingId)
      throw new InvalidLookupError("The form is for a different posting");
    schemas.save(
      result.ats,
      result.token,
      result.postingId,
      result.payload,
      schema.hash,
    );
    const plan = await plans.build(token, result.jobId);
    return { status: "planned", summary: plan.summary };
  }

  async function queue(token: string) {
    const summaries = planStore.summaries();
    const limits = deps.limits?.list() ?? [];
    const [{ jobs }, applied] = await Promise.all([
      jobOps.listJobs(token, QUEUE_STATUSES),
      limits.length
        ? jobOps.listJobs(token, APPLIED_STATUSES).then((r) => r.jobs)
        : Promise.resolve([]),
    ]);
    const past: PastApplication[] = applied.flatMap((j) =>
      j.appliedAt
        ? [
            {
              jobId: j.id,
              title: j.title,
              employer: j.employer,
              appliedAt: j.appliedAt,
            },
          ]
        : [],
    );
    const now = new Date();
    return [...jobs]
      .sort((a, b) => (b.suitabilityScore ?? 0) - (a.suitabilityScore ?? 0))
      .map((job) => {
        const target = targets.get(job.id);
        return {
          jobId: job.id,
          title: job.title,
          employer: job.employer,
          score: job.suitabilityScore,
          // Where the job was found and where it takes applications: the side panel matches
          // the tab you're on against these (LinkedIn, Naukri, the company's page).
          jobUrl: job.jobUrl,
          applicationLink: job.applicationLink,
          target: target
            ? {
                ats: target.ats,
                status: target.status,
                postingUrl: target.postingUrl,
                titleScore: target.titleScore,
                descScore: target.descScore,
              }
            : // Nothing left to look up (the company has no board on file): not found, not
              // "not checked" for the week the board cache lasts.
              nextTaskFor(job) === null
              ? { status: "none" as const }
              : { status: "pending" as const },
          plan: summaries.get(job.id) ?? null,
          postedAt: job.datePosted ?? null,
          // A company that takes only so many applications from you: pick your best role.
          companyLimit: (() => {
            const limit = limitFor(job.employer, limits);
            return limit ? companyWindow(limit, past, now) : null;
          })(),
        };
      });
  }

  return { pending, apply, queue };
}
