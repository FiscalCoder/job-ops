import type { JobOpsApi } from "../jobops/client.js";
import type { AnswerBankRepo } from "../store/answer-bank-repo.js";
import type { ApplyTargetsRepo } from "../store/apply-targets-repo.js";
import type { FillPlansRepo } from "../store/fill-plans-repo.js";
import type { FormSchemasRepo } from "../store/form-schemas-repo.js";
import { parseGreenhouseSchema } from "./gh-schema.js";
import { buildPlan, type FillPlan } from "./planner.js";
import { type ResumeFacts, resumeFacts } from "./resume-facts.js";

/**
 * Builds and stores fill plans. Inputs: the matched Greenhouse posting's stored form, your Job
 * Ops design resume, the answer bank, and the job's location. Rebuilt whenever the form is
 * re-fetched or you change the answer bank.
 */

export class NotPlannableError extends Error {
  constructor(
    readonly jobId: string,
    message: string,
  ) {
    super(message);
    this.name = "NotPlannableError";
  }
}

export interface PlansDeps {
  readonly jobOps: JobOpsApi;
  readonly targets: ApplyTargetsRepo;
  readonly schemas: FormSchemasRepo;
  readonly plans: FillPlansRepo;
  readonly answers: AnswerBankRepo;
}

export interface RebuildResult {
  readonly rebuilt: number;
  readonly failed: readonly { jobId: string; reason: string }[];
}

export function createPlans(deps: PlansDeps) {
  const { jobOps, targets, schemas, plans, answers } = deps;

  const bankMap = () => new Map(answers.list().map((a) => [a.key, a.value]));

  async function buildWith(
    token: string,
    jobId: string,
    resume: ResumeFacts,
    bank: ReadonlyMap<string, string>,
  ): Promise<FillPlan> {
    const target = targets.get(jobId);
    if (
      !target ||
      target.status !== "matched" ||
      !target.ghToken ||
      !target.ghJobId
    )
      throw new NotPlannableError(
        jobId,
        "This job has no confirmed Greenhouse posting yet",
      );
    const stored = schemas.getAny(target.ghToken, target.ghJobId);
    if (!stored)
      throw new NotPlannableError(
        jobId,
        "The Greenhouse form hasn't been fetched yet",
      );
    const job = await jobOps.getJob(token, jobId);
    const plan = buildPlan({
      schema: parseGreenhouseSchema(stored.payload),
      resume,
      bank,
      jobLocation: job.location,
    });
    plans.save(jobId, plan);
    return plan;
  }

  const loadResume = async (token: string) =>
    resumeFacts(await jobOps.getDesignResume(token));

  return {
    async build(token: string, jobId: string): Promise<FillPlan> {
      return buildWith(token, jobId, await loadResume(token), bankMap());
    },

    /** Rebuilds every stored plan (after an answer-bank change); one resume fetch for all. */
    async rebuildAll(token: string): Promise<RebuildResult> {
      const jobIds = plans.jobIds();
      if (jobIds.length === 0) return { rebuilt: 0, failed: [] };
      const resume = await loadResume(token);
      const bank = bankMap();
      const outcomes = await Promise.all(
        jobIds.map((jobId) =>
          buildWith(token, jobId, resume, bank).then(
            () => null,
            (error: unknown) => ({
              jobId,
              reason: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
      );
      const failed = outcomes.filter((o) => o !== null);
      return { rebuilt: jobIds.length - failed.length, failed };
    },
  };
}

export type PlansService = ReturnType<typeof createPlans>;
