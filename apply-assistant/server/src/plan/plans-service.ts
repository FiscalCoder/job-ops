import { ATS_NAMES } from "../ats.js";
import type { QuestionAnswerer } from "../claude/answerer.js";
import type { ClaudeAnswer } from "../claude/questions.js";
import { isAnswerable, toQuestion } from "../claude/questions.js";
import type { TellAnswer } from "../claude/tell.js";
import { traceUsage } from "../claude/usage-trace.js";
import type { JobOpsApi } from "../jobops/client.js";
import type { AnswerBankRepo } from "../store/answer-bank-repo.js";
import type { ApplyTargetsRepo } from "../store/apply-targets-repo.js";
import type { FillPlansRepo } from "../store/fill-plans-repo.js";
import type { FormSchemasRepo } from "../store/form-schemas-repo.js";
import type { LearnedAnswersRepo } from "../store/learned-answers-repo.js";
import type { TraceRecord } from "../store/trace-store.js";
import { classifyField } from "./classify.js";
import type { FormSchema } from "./form-schema.js";
import {
  buildPlan,
  type FillPlan,
  hasRememberedAnswer,
  locationSettles,
  type PlanInput,
} from "./planner.js";
import { normalizeQuestion } from "./question-norm.js";
import { type ResumeFacts, resumeFacts } from "./resume-facts.js";
import { parseFormSchema } from "./schemas.js";

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
  /** Null without an Anthropic key: unrecognised questions then stay "needs you". */
  readonly answerer?: QuestionAnswerer | null;
  readonly log?: (line: string) => void;
  readonly trace?: TraceRecord;
  /** Your answers to earlier forms' questions, reused before asking Claude. */
  readonly learned?: LearnedAnswersRepo;
}

export interface RebuildResult {
  readonly rebuilt: number;
  readonly failed: readonly { jobId: string; reason: string }[];
}

export function createPlans(deps: PlansDeps) {
  const { jobOps, targets, schemas, plans, answers } = deps;
  const answerer = deps.answerer ?? null;
  const log = deps.log ?? (() => {});
  const trace = deps.trace ?? (() => {});

  /** Claude's answers for the questions the rules leave open (never throws). */
  async function askClaude(
    jobId: string,
    schema: FormSchema,
    context: Parameters<QuestionAnswerer["answer"]>[1],
    learned: PlanInput["learned"],
  ): Promise<{
    claude?: ReadonlyMap<string, ClaudeAnswer>;
    claudeProblem?: string;
  }> {
    // Only what nothing else answers: not your remembered answers, and not "located in"
    // questions your saved location settles.
    const questions = schema.fields
      .filter((f) => {
        if (!isAnswerable(f) || hasRememberedAnswer(f, learned)) return false;
        const { rule } = classifyField(f);
        return (
          rule.kind === "question" ||
          (rule.kind === "located-in" &&
            !locationSettles(rule.place, context.bank))
        );
      })
      .map(toQuestion);
    if (questions.length === 0) return {};
    if (!answerer)
      return {
        claudeProblem:
          "No saved answer for this question yet (Claude isn't set up on the server)",
      };
    try {
      return {
        claude: await answerer.answer(
          questions,
          context,
          traceUsage(trace, jobId),
        ),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(
        `[claude] couldn't answer ${questions.length} question(s): ${reason}`,
      );
      return {
        claudeProblem:
          "Claude couldn't be reached; answer it yourself or rebuild the plan later",
      };
    }
  }

  const bankMap = () => new Map(answers.list().map((a) => [a.key, a.value]));

  /** The job's matched posting and its stored form, or NotPlannableError. */
  function formOf(jobId: string) {
    const target = targets.get(jobId);
    if (
      !target ||
      target.status !== "matched" ||
      !target.boardToken ||
      !target.postingId
    )
      throw new NotPlannableError(
        jobId,
        "This job has no confirmed posting on a supported system yet",
      );
    const stored = schemas.getAny(
      target.ats,
      target.boardToken,
      target.postingId,
    );
    if (!stored)
      throw new NotPlannableError(
        jobId,
        `The ${ATS_NAMES[target.ats]} form hasn't been fetched yet`,
      );
    return { target, stored };
  }

  async function buildWith(
    token: string,
    jobId: string,
    resume: ResumeFacts,
    bank: ReadonlyMap<string, string>,
  ): Promise<FillPlan> {
    const { target, stored } = formOf(jobId);
    const job = await jobOps.getJob(token, jobId);
    const schema = parseFormSchema(target.ats, stored.payload);
    const learned: PlanInput["learned"] = (label) =>
      deps.learned?.get(normalizeQuestion(label, job.employer)) ?? null;
    const fromClaude = await askClaude(
      jobId,
      schema,
      {
        job: {
          title: job.title,
          employer: job.employer,
          description: job.jobDescription,
        },
        resume,
        bank,
      },
      learned,
    );
    const plan = buildPlan({
      schema,
      resume,
      bank,
      jobLocation: job.location,
      learned,
      ...fromClaude,
    });
    const previous = plans.get(jobId)?.plan;
    plans.save(jobId, plan);
    // Plans are rebuilt on every view and answer-bank save: trace only real changes.
    if (previous && JSON.stringify(previous) === JSON.stringify(plan))
      return plan;
    const { summary } = plan;
    trace({
      jobId,
      kind: "plan",
      message: `${previous ? "Plan changed" : "Plan built"} for ${ATS_NAMES[target.ats]}: ${summary.fill} to fill, ${summary.needsYou} need you`,
      data: {
        ats: target.ats,
        postingId: target.postingId,
        summary,
        ...(fromClaude.claudeProblem
          ? { claudeProblem: fromClaude.claudeProblem }
          : {}),
        claudeAnswers: fromClaude.claude?.size ?? 0,
      },
    });
    return plan;
  }

  const loadResume = async (token: string) =>
    resumeFacts(await jobOps.getDesignResume(token));

  return {
    /** "Tell agent": Claude's proposal for one field, following your instruction. */
    async tell(
      token: string,
      jobId: string,
      ref: string,
      instruction: string,
    ): Promise<TellAnswer> {
      const { target, stored } = formOf(jobId);
      const field = parseFormSchema(target.ats, stored.payload).fields.find(
        (f) => f.ref === ref,
      );
      if (!field)
        throw new NotPlannableError(jobId, "That field isn't on this form");
      if (!answerer)
        throw new NotPlannableError(
          jobId,
          "Claude isn't set up on the server (no Anthropic key)",
        );
      const [job, resume] = await Promise.all([
        jobOps.getJob(token, jobId),
        loadResume(token),
      ]);
      const answer = await answerer.tell(
        toQuestion(field),
        instruction,
        {
          job: {
            title: job.title,
            employer: job.employer,
            description: job.jobDescription,
          },
          resume,
          bank: bankMap(),
        },
        traceUsage(trace, jobId),
      );
      trace({
        jobId,
        kind: "tell-agent",
        message: `Told Claude how to answer "${field.label.slice(0, 80)}"`,
        data: { ref, instruction, answer },
      });
      return answer;
    },

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
