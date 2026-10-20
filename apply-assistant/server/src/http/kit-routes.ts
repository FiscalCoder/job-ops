import { type Response, Router } from "express";
import { z } from "zod";
import type { QuestionAnswerer } from "../claude/answerer.js";
import type { ClaudeAnswer } from "../claude/questions.js";
import { traceUsage } from "../claude/usage-trace.js";
import { type JobOpsApi, JobOpsError } from "../jobops/client.js";
import { buildKit } from "../kit/kit.js";
import { resumeFacts } from "../plan/resume-facts.js";
import type { AnswerBankRepo } from "../store/answer-bank-repo.js";
import type { ApplyTargetsRepo } from "../store/apply-targets-repo.js";
import type { FillPlansRepo } from "../store/fill-plans-repo.js";
import type { TraceRecord } from "../store/trace-store.js";
import { type AuthedRequest, sendJobOpsFailure } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/** The apply kit for jobs without a filler, and Claude's answer to a pasted question. */

const answerBody = z.object({
  question: z.string().trim().min(3).max(500),
  options: z.array(z.string().trim().min(1).max(200)).max(60).optional(),
  /** A written answer (paragraph) rather than a short one. */
  long: z.boolean().optional(),
});

/** What you did with a job you handled by hand. */
const outcomeBody = z.object({ outcome: z.enum(["applied", "skipped"]) });

export interface KitRoutesDeps {
  readonly jobOps: JobOpsApi;
  readonly targets: ApplyTargetsRepo;
  readonly answers: AnswerBankRepo;
  readonly planStore: FillPlansRepo;
  readonly answerer: QuestionAnswerer | null;
  readonly trace?: TraceRecord;
}

/** A Claude reply as text to copy, or null when Claude had no answer. */
function replyValue(
  reply: ClaudeAnswer | undefined,
  bank: ReadonlyMap<string, string>,
): { value: string; how: string } | null {
  switch (reply?.kind) {
    case "bank": {
      const saved = bank.get(reply.key);
      return saved
        ? { value: saved, how: `your saved answer (${reply.key})` }
        : null;
    }
    case "answer":
      return {
        value: Array.isArray(reply.value)
          ? reply.value.join(", ")
          : (reply.value as string),
        how: `Claude, from your resume (${Math.round(reply.confidence * 100)}%)`,
      };
    case "draft":
      return {
        value: reply.value,
        how: "Claude's draft: read it before using",
      };
    default:
      return null;
  }
}

export function createKitRoutes(deps: KitRoutesDeps) {
  const { jobOps, targets, answers, planStore, answerer } = deps;
  const trace = deps.trace ?? (() => {});
  const router = Router();
  const tokenOf = (req: AuthedRequest) => req.jobOpsToken ?? "";
  const bankMap = () => new Map(answers.list().map((a) => [a.key, a.value]));

  const failJobOps = (res: Response, error: unknown) => {
    if (error instanceof JobOpsError && error.status === 404) {
      sendError(res, 404, "JOB_NOT_FOUND", "Job Ops has no job with that id");
      return;
    }
    sendJobOpsFailure(res, error);
  };

  router.get("/kit/:jobId", async (req: AuthedRequest, res: Response) => {
    const jobId = String(req.params.jobId);
    try {
      const [job, design] = await Promise.all([
        jobOps.getJob(tokenOf(req), jobId),
        jobOps.getDesignResume(tokenOf(req)),
      ]);
      const target = targets.get(jobId);
      const posting = target?.status === "matched" ? target.postingUrl : null;
      sendOk(
        res,
        buildKit({
          job: {
            jobId,
            title: job.title,
            employer: job.employer,
            location: job.location,
            applyUrl: posting ?? job.applicationLink ?? job.jobUrl,
            tailoredSummary: job.tailoredSummary ?? null,
          },
          resume: resumeFacts(design),
          bank: bankMap(),
          plan: planStore.get(jobId)?.plan ?? null,
        }),
      );
    } catch (error) {
      failJobOps(res, error);
    }
  });

  /** "I applied" / "Skip job": Job Ops' own actions, so its stages and dates stay right. */
  router.post(
    "/kit/:jobId/outcome",
    async (req: AuthedRequest, res: Response) => {
      const body = outcomeBody.safeParse(req.body);
      if (!body.success) {
        sendError(
          res,
          400,
          "INVALID_REQUEST",
          "outcome must be applied or skipped",
        );
        return;
      }
      const jobId = String(req.params.jobId);
      const { outcome } = body.data;
      try {
        const { status } = await jobOps.getJob(tokenOf(req), jobId);
        if (status === "applied" || status === outcome) {
          sendError(
            res,
            409,
            "ALREADY_DONE",
            status === "applied"
              ? "Job Ops already has this job as Applied"
              : "Job Ops already has this job as Skipped",
          );
          return;
        }
        if (outcome === "applied") {
          await jobOps.markApplied(tokenOf(req), jobId);
          await jobOps
            .addNote(tokenOf(req), jobId, {
              title: "Applied by hand",
              content:
                "You applied yourself, with the Apply Copilot kit, and marked it applied from the side panel.",
            })
            .catch((error: unknown) =>
              trace({
                jobId,
                kind: "error",
                message: `Couldn't add the Applied note: ${error instanceof Error ? error.message : String(error)}`,
              }),
            );
        } else {
          await jobOps.skipJob(tokenOf(req), jobId);
        }
        trace({
          jobId,
          kind: "kit-outcome",
          message:
            outcome === "applied"
              ? "You marked it Applied (applied by hand)"
              : "You skipped this job",
          data: { outcome, previousStatus: status },
        });
        sendOk(res, { status: outcome });
      } catch (error) {
        failJobOps(res, error);
      }
    },
  );

  router.post(
    "/kit/:jobId/answer",
    async (req: AuthedRequest, res: Response) => {
      const body = answerBody.safeParse(req.body);
      if (!body.success) {
        sendError(
          res,
          400,
          "INVALID_REQUEST",
          "Paste the question (3–500 characters)",
        );
        return;
      }
      if (!answerer) {
        sendError(
          res,
          503,
          "CLAUDE_OFF",
          "Claude isn't set up on the server (no Anthropic key)",
        );
        return;
      }
      const jobId = String(req.params.jobId);
      const { question, options = [], long = false } = body.data;
      try {
        const [job, design] = await Promise.all([
          jobOps.getJob(tokenOf(req), jobId),
          jobOps.getDesignResume(tokenOf(req)),
        ]);
        const bank = bankMap();
        const replies = await answerer.answer(
          [
            {
              ref: "kit",
              label: question,
              type: options.length ? "select" : long ? "textarea" : "text",
              options,
            },
          ],
          {
            job: {
              title: job.title,
              employer: job.employer,
              description: job.jobDescription,
            },
            resume: resumeFacts(design),
            bank,
          },
          traceUsage(trace, jobId),
        );
        const reply = replies.get("kit");
        const found = replyValue(reply, bank);
        trace({
          jobId,
          kind: "kit-answer",
          message: found
            ? `Claude answered "${question.slice(0, 80)}"`
            : `Claude had no answer for "${question.slice(0, 80)}"`,
          data: { question, options, reply: reply ?? null },
        });
        if (!found) {
          sendError(
            res,
            422,
            "NO_ANSWER",
            reply && "why" in reply
              ? `No answer: ${reply.why}`
              : "Claude couldn't answer this from your resume and saved answers",
          );
          return;
        }
        sendOk(res, found);
      } catch (error) {
        if (error instanceof JobOpsError) {
          failJobOps(res, error);
          return;
        }
        trace({
          jobId,
          kind: "error",
          message: `Ask Claude failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        sendError(
          res,
          502,
          "CLAUDE_FAILED",
          "Claude couldn't be reached; try again",
        );
      }
    },
  );

  return router;
}
