import { ATS_NAMES } from "../ats.js";
import type { ActAnswer, ActRequest } from "../claude/act.js";
import type { QuestionAnswerer } from "../claude/answerer.js";
import { claudeOff } from "../claude/off.js";
import type { ClaudeAnswer } from "../claude/questions.js";
import {
  isAnswerable,
  type Question,
  toQuestion,
} from "../claude/questions.js";
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
import { parseGenericPage } from "./generic-schema.js";
import {
  buildPlan,
  type FillPlan,
  hasRememberedAnswer,
  locationSettles,
  type PlanInput,
  summarise,
} from "./planner.js";
import { blocksToAdd } from "./history-blocks.js";
import { normalizeQuestion } from "./question-norm.js";
import { type ResumeFacts, resumeFacts } from "./resume-facts.js";
import { parseFormSchema } from "./schemas.js";
import { tailoredFor } from "./tailored-resume.js";
import {
  entriesToAdd,
  parseWorkdayPage,
  type WorkdayPage,
} from "./workday-schema.js";

/**
 * A Workday page's plan, plus the entries to add first: the extension clicks Add that many
 * times in each section, reads the page again and asks for its plan once more.
 */
export type WorkdayPagePlan = FillPlan & {
  readonly add: readonly { section: string; count: number }[];
};

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

/** Questions about a fact (education, employment): matched, never re-picked by fit. */
const FACTUAL_FIELD =
  /\b(school|college|universit|institut|degree|field of study|major|discipline|speciali[sz]ation|qualification|company|employer)/i;
/** What Claude replies when a fact has no matching choice (the field then waits for you). */
const NO_MATCH = "NO MATCH";
/** Broader searches Claude may suggest for one answer. */
const MAX_SEARCH_TERMS = 4;

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
    const off = claudeOff(answerer);
    if (!answerer || off)
      return {
        claudeProblem: `No saved answer for this question yet. ${off}`,
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

  /** A field of the job's stored form (Greenhouse, Ashby, Lever), as Claude is asked it. */
  function storedQuestion(jobId: string, ref: string): Question {
    const { target, stored } = formOf(jobId);
    const field = parseFormSchema(target.ats, stored.payload).fields.find(
      (f) => f.ref === ref,
    );
    if (!field)
      throw new NotPlannableError(jobId, "That field isn't on this form");
    return toQuestion(field);
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

  /** Your remembered answers, Claude for what's left, then the plan. */
  async function planSchema(
    jobId: string,
    schema: FormSchema,
    job: Awaited<ReturnType<JobOpsApi["getJob"]>>,
    resume: ResumeFacts,
    bank: ReadonlyMap<string, string>,
  ) {
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
    return { plan, fromClaude };
  }

  async function buildWith(
    token: string,
    jobId: string,
    baseResume: ResumeFacts,
    bank: ReadonlyMap<string, string>,
  ): Promise<FillPlan> {
    const { target, stored } = formOf(jobId);
    const job = await jobOps.getJob(token, jobId);
    const resume = tailoredFor(baseResume, job);
    const schema = parseFormSchema(target.ats, stored.payload);
    const { plan, fromClaude } = await planSchema(
      jobId,
      schema,
      job,
      resume,
      bank,
    );
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

  /** The job, and the resume as its tailored PDF has it (Claude writes from this). */
  const jobAndResume = async (token: string, jobId: string) => {
    const [job, base] = await Promise.all([
      jobOps.getJob(token, jobId),
      loadResume(token),
    ]);
    return { job, resume: tailoredFor(base, job) };
  };

  const loadResume = async (token: string) =>
    resumeFacts(await jobOps.getDesignResume(token));

  /** Claude picks the closest of a field's choices to your answer (traced). */
  /**
   * A fact about you (school, degree, field of study, employer) is matched, never swapped for
   * something that "fits": Accounting is no answer for an AI/ML degree. A preference (work
   * model) may be re-picked from your saved answers when the planned answer doesn't fit.
   */
  function closestInstruction(ask: { label: string; wanted: string }): string {
    if (ask.wanted && FACTUAL_FIELD.test(ask.label))
      return `My answer is "${ask.wanted}", but the form doesn't list it. Pick the choice that means the same, or the broader field or category that contains it (e.g. "Computer Science" for "Artificial Intelligence and Machine Learning"). A school, college, university or company must be the same one. When no choice is that, pick "Other" if there is one; otherwise reply with the value "${NO_MATCH}". Never pick an unrelated choice, and never one based on a different part of my resume.`;
    return `${ask.wanted ? `My answer is "${ask.wanted}", but the form doesn't list it. Pick the choice that means the same or is closest to it. If my answer doesn't fit these choices at all (it may answer a different question), pick the choice that fits me best from my saved answers and resume.` : "I have no saved answer for this: pick the choice that fits me best from my saved answers and resume."} A school, college, university or company must be the same one: when it isn't listed, pick the "Other" choice if there is one, never a different institution.`;
  }

  async function closest(
    claude: NonNullable<typeof answerer>,
    jobId: string,
    job: Awaited<ReturnType<JobOpsApi["getJob"]>>,
    resume: ResumeFacts,
    ask: { label: string; wanted: string; options: readonly string[] },
  ): Promise<TellAnswer> {
    const answer = await claude.tell(
      { ref: "choose", label: ask.label, type: "select", options: ask.options },
      closestInstruction(ask),
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
      kind: "choose",
      message: `Claude picked "${String(answer.value).slice(0, 80)}" for "${ask.label.slice(0, 80)}" (your answer: "${ask.wanted.slice(0, 80)}")`,
      data: { ...ask, options: ask.options.length, answer },
    });
    return answer;
  }

  /**
   * Workday: a dropdown answered from your resume (Degree) whose choices word it differently
   * ("B.com" vs "Bachelors of Commerce"): Claude picks the closest choice, for you to confirm.
   */
  async function withClosestChoices(
    jobId: string,
    schema: FormSchema,
    plan: FillPlan,
    job: Awaited<ReturnType<JobOpsApi["getJob"]>>,
    resume: ResumeFacts,
  ): Promise<FillPlan> {
    const claude = answerer;
    if (!claude || claudeOff(claude)) return plan;
    const fields = new Map(schema.fields.map((f) => [f.ref, f]));
    const entries = await Promise.all(
      plan.entries.map(async (entry) => {
        const field = fields.get(entry.ref);
        const wanted = entry.value;
        if (
          entry.status !== "needs-you" ||
          !entry.source.startsWith("resume:") ||
          typeof wanted !== "string" ||
          !field?.options.length
        )
          return entry;
        const answer = await closest(claude, jobId, job, resume, {
          label: field.label,
          wanted,
          options: field.options.map((o) => o.label),
        }).catch(() => null);
        const option = field.options.find((o) => o.label === answer?.value);
        if (!option) return entry;
        return {
          ...entry,
          status: "fill" as const,
          value: option.label,
          optionValues: [option.value],
          actionClass: "confirm" as const,
          reason: `Claude picked the closest to "${wanted}"`,
        };
      }),
    );
    return { ...plan, entries, summary: summarise(entries) };
  }

  return {
    /** "Tell agent": Claude's proposal for one field, following your instruction. */
    async tell(
      token: string,
      jobId: string,
      ref: string,
      instruction: string,
      shown?: Omit<Question, "ref">,
    ): Promise<TellAnswer> {
      const field = shown ? { ref, ...shown } : storedQuestion(jobId, ref);
      const off = claudeOff(answerer);
      if (!answerer || off) throw new NotPlannableError(jobId, off ?? "");
      const { job, resume } = await jobAndResume(token, jobId);
      const answer = await answerer.tell(
        field,
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

    /**
     * Any company's own form: steps that set a field the extension couldn't fill by itself.
     * Traced with your answer replaced by "{value}".
     */
    async act(jobId: string, request: ActRequest): Promise<ActAnswer> {
      const off = claudeOff(answerer);
      if (!answerer || off) throw new NotPlannableError(jobId, off ?? "");
      const answer = await answerer.act(request, traceUsage(trace, jobId));
      const masked = answer.steps.map((s) => ({
        ...s,
        value: request.wanted
          ? s.value.split(request.wanted).join("{value}")
          : s.value,
      }));
      trace({
        jobId,
        kind: "act",
        message: answer.steps.length
          ? `Claude worked out ${answer.steps.length} step(s) for "${request.label.slice(0, 80)}"`
          : `Claude found no way to set "${request.label.slice(0, 80)}": ${answer.why}`,
        data: {
          label: request.label,
          failure: request.failure,
          steps: masked,
          why: answer.why,
        },
      });
      return answer;
    },

    /**
     * Workday: a field whose choices differ by company (Field of Study, Degree) and none of
     * which matches your answer as such: Claude picks the closest of the choices found.
     */
    async choose(
      token: string,
      jobId: string,
      ask: { label: string; wanted: string; options: readonly string[] },
    ): Promise<TellAnswer> {
      const off = claudeOff(answerer);
      if (!answerer || off) throw new NotPlannableError(jobId, off ?? "");
      const { job, resume } = await jobAndResume(token, jobId);
      return closest(answerer, jobId, job, resume, ask);
    },

    /**
     * Workday: what to search a list for when your answer's own words found nothing that is
     * it ("Computer Science" for an AI/ML degree). Only the same thing or broader.
     */
    async searchTerms(
      token: string,
      jobId: string,
      ask: { label: string; wanted: string },
    ): Promise<{ terms: string[] }> {
      const off = claudeOff(answerer);
      if (!answerer || off) throw new NotPlannableError(jobId, off ?? "");
      const { job, resume } = await jobAndResume(token, jobId);
      const answer = await answerer.tell(
        { ref: "search", label: ask.label, type: "text", options: [] },
        `My answer is "${ask.wanted}", but searching the form's list for its words found nothing that is it. Give up to ${MAX_SEARCH_TERMS} short search words (one to three words each) that such a list would use for the same thing or the broader field or category containing it, separated by commas. Nothing unrelated.`,
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
      const terms = [
        ...new Set(
          String(answer.value)
            .split(/[,\n]/)
            .map((t) => t.trim().replace(/^["'-]+|["'.]+$/g, ""))
            .filter((t) => t.length > 1 && t.length <= 40),
        ),
      ].slice(0, MAX_SEARCH_TERMS);
      trace({
        jobId,
        kind: "choose",
        message: `Claude suggested searching for ${terms.map((t) => `"${t}"`).join(", ") || "nothing"} for "${ask.label.slice(0, 80)}" (your answer: "${ask.wanted.slice(0, 80)}")`,
        data: { ...ask, terms },
      });
      return { terms };
    },

    /**
     * Workday: plans the one page you're on from the fields the extension read there (its form
     * only exists after you sign in). Not stored: each page is planned as you reach it.
     */
    async planPage(
      token: string,
      jobId: string,
      page: WorkdayPage,
    ): Promise<WorkdayPagePlan> {
      const { job, resume } = await jobAndResume(token, jobId);
      const generic = page.system === "generic";
      const schema = generic
        ? parseGenericPage(page, job.title, resume)
        : parseWorkdayPage(page, job.title);
      const { plan: planned, fromClaude } = await planSchema(
        jobId,
        schema,
        job,
        resume,
        bankMap(),
      );
      const plan = await withClosestChoices(
        jobId,
        schema,
        planned,
        job,
        resume,
      );
      const { summary } = plan;
      // Fewer job or degree blocks than on your resume: the site's Add More, then planned again.
      const add = generic
        ? blocksToAdd(page.fields, resume)
        : entriesToAdd(page, resume);
      trace({
        jobId,
        kind: "plan",
        message: add.length
          ? `${generic ? "Page" : "Workday page"} "${page.step}": adding ${add.map((a) => `${a.count} to ${a.section.replace(/-section$/, "").replace(/-/g, " ")}`).join(", ")} for your resume first`
          : `Plan built for ${generic ? "page" : "Workday page"} "${page.step}": ${summary.fill} to fill, ${summary.needsYou} need you`,
        data: {
          ats: generic ? "generic" : "workday",
          step: page.step,
          summary,
          ...(fromClaude.claudeProblem
            ? { claudeProblem: fromClaude.claudeProblem }
            : {}),
          claudeAnswers: fromClaude.claude?.size ?? 0,
          ...(add.length ? { add } : {}),
        },
      });
      return { ...plan, add };
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
