import type { JsonSchemaDefinition } from "@server/services/llm/types";
import {
  createConfiguredLlmService,
  resolveLlmModel,
} from "@server/services/modelSelection";
import {
  messageTypeFromStageTarget,
  normalizeStageTarget,
} from "@server/services/post-application/stage-target";
import type {
  Job,
  PostApplicationMessageType,
  PostApplicationRouterStageTarget,
} from "@shared/types";
import { POST_APPLICATION_ROUTER_STAGE_TARGETS } from "@shared/types";
import { normalizeWhitespace } from "@shared/utils/string";

export const ROUTER_EMAIL_CHAR_LIMIT = 12_000;

const SMART_ROUTER_SCHEMA: JsonSchemaDefinition = {
  name: "post_application_email_router",
  schema: {
    type: "object",
    properties: {
      bestMatchIndex: {
        type: ["integer", "null"],
        description:
          "Best matching active-job index from provided list (1-based), or null.",
      },
      confidence: {
        type: "integer",
        description:
          "Confidence 0-100 that this email belongs to the bestMatchIndex job. MUST be 0 when bestMatchIndex is null.",
      },
      stageTarget: {
        type: "string",
        enum: [...POST_APPLICATION_ROUTER_STAGE_TARGETS],
        description:
          "Normalized stage target for this message, matching Log Event options.",
      },
      isRelevant: {
        type: "boolean",
        description:
          "Whether this is a relevant recruitment/application email.",
      },
      stageEventPayload: {
        type: ["object", "null"],
        description: "Structured metadata for a potential stage event.",
        additionalProperties: true,
      },
      reason: {
        type: "string",
        description: "One sentence reason for the routing decision.",
      },
    },
    required: [
      "bestMatchIndex",
      "confidence",
      "stageTarget",
      "isRelevant",
      "stageEventPayload",
      "reason",
    ],
    additionalProperties: false,
  },
};

export type IndexedActiveJob = {
  index: number;
  id: string;
  company: string;
  title: string;
};

export type SmartRouterResult = {
  bestMatchId: string | null;
  confidence: number;
  stageTarget: PostApplicationRouterStageTarget;
  messageType: PostApplicationMessageType;
  isRelevant: boolean;
  stageEventPayload: Record<string, unknown> | null;
  reason: string;
};

export function minifyActiveJobs(jobs: Job[]): Array<{
  id: string;
  company: string;
  title: string;
}> {
  return jobs.map((job) => ({
    id: job.id,
    company: job.employer,
    title: job.title,
  }));
}

function sanitizeJobPromptValue(value: string): string {
  return normalizeWhitespace(value);
}

export function buildIndexedActiveJobs(
  jobs: Array<{ id: string; company: string; title: string }>,
): IndexedActiveJob[] {
  return jobs.map((job, offset) => ({
    index: offset + 1,
    id: job.id,
    company: sanitizeJobPromptValue(job.company || "Unknown company"),
    title: sanitizeJobPromptValue(job.title || "Unknown title"),
  }));
}

export function buildCompactActiveJobsList(jobs: IndexedActiveJob[]): string {
  return jobs
    .map((job) => `${job.index}. ${job.company}: ${job.title}`)
    .join("\n");
}

export function normalizeBestMatchIndex(
  value: unknown,
  max: number,
): number | null {
  if (value === null || value === undefined || max <= 0) return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  if (rounded < 1 || rounded > max) return null;
  return rounded;
}

export async function classifyWithSmartRouter(args: {
  emailText: string;
  activeJobs: Array<{ id: string; company: string; title: string }>;
}): Promise<SmartRouterResult> {
  const model = await resolveLlmModel();
  const llmEmailText = args.emailText.slice(0, ROUTER_EMAIL_CHAR_LIMIT);
  const indexedActiveJobs = buildIndexedActiveJobs(args.activeJobs);
  const compactActiveJobsList = buildCompactActiveJobsList(indexedActiveJobs);
  const messages = [
    {
      role: "system" as const,
      content:
        "You are a strict router for post-application recruitment emails. Return only strict JSON. Ignore sensitive data and include only routing fields.",
    },
    {
      role: "user" as const,
      content: `Classify this email and route it to one of the user's applied jobs only when it clearly belongs to that application.

RELEVANCE — isRelevant is true ONLY for emails about the user's own submitted job applications:
- application received/acknowledged, interview invitations or scheduling, online assessments or coding tests, recruiter replies about an existing application, offers, rejections, background checks, onboarding.
isRelevant is false, even when the email is career-themed:
- job board alerts, digests, or marketing (LinkedIn, Naukri, Indeed, Glassdoor notifications), "recruiters viewed your profile", new-job recommendations
- course/learning platforms, webinars, bootcamps, newsletters, community digests
- promotional, transactional, or social-notification email
- cold recruiter outreach about NEW roles the user has not applied to.
When unsure, use isRelevant=false.

MATCHING:
- bestMatchIndex: choose a listed job number (1-based) ONLY when the email explicitly references that job's company or role (or an obvious variant of them). Otherwise null.
- Never pick a job just because the list is short or it is the only option.
- confidence: 0-100 that the email belongs to the chosen job. MUST be 0 when bestMatchIndex is null.

OTHER FIELDS:
- stageTarget must be one of: ${POST_APPLICATION_ROUTER_STAGE_TARGETS.join("|")}. Use no_change for irrelevant emails.
- stageEventPayload should be minimal structured data or null.

Active jobs (index. company: title):
${compactActiveJobsList}

Email:
${llmEmailText}`,
    },
  ];

  const llm = await createConfiguredLlmService();
  const result = await llm.callJson<{
    bestMatchIndex: number | null;
    confidence: number;
    stageTarget: string;
    isRelevant: boolean;
    stageEventPayload: Record<string, unknown> | null;
    reason: string;
  }>({
    model,
    messages,
    jsonSchema: SMART_ROUTER_SCHEMA,
    maxRetries: 1,
    retryDelayMs: 400,
  });

  if (!result.success) {
    throw new Error(`LLM classification failed: ${result.error}`);
  }

  const confidence = Math.max(
    0,
    Math.min(100, Math.round(Number(result.data.confidence) || 0)),
  );
  const bestMatchIndex = normalizeBestMatchIndex(
    result.data.bestMatchIndex,
    indexedActiveJobs.length,
  );
  const bestMatchId =
    bestMatchIndex !== null
      ? (indexedActiveJobs[bestMatchIndex - 1]?.id ?? null)
      : null;
  const stageTarget =
    normalizeStageTarget(result.data.stageTarget) ?? "no_change";
  const messageType = messageTypeFromStageTarget(stageTarget);

  return {
    bestMatchId,
    // confidence measures the job match; without a match it is meaningless,
    // so clamp to 0 rather than letting the model's decision-certainty leak
    // into matchConfidence displays and auto-link thresholds.
    confidence: bestMatchId ? confidence : 0,
    stageTarget,
    messageType,
    isRelevant: Boolean(result.data.isRelevant),
    stageEventPayload:
      result.data.stageEventPayload &&
      typeof result.data.stageEventPayload === "object"
        ? result.data.stageEventPayload
        : null,
    reason: String(result.data.reason ?? "").trim(),
  };
}
