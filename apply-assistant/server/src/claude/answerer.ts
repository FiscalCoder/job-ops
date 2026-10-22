import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeAnswersRepo } from "../store/claude-answers-repo.js";
import { type ClaudeUsage, usageOf } from "./pricing.js";
import {
  type ClaudeAnswer,
  cacheKey,
  checkMapItem,
  DRAFT_SYSTEM,
  draftPrompt,
  MAP_SCHEMA,
  MAP_SYSTEM,
  MAX_DRAFT_CHARS,
  mapPrompt,
  parseMapReply,
  type Question,
  type QuestionContext,
} from "./questions.js";
import {
  ACT_SCHEMA,
  ACT_SYSTEM,
  type ActAnswer,
  type ActRequest,
  actPrompt,
  checkActReply,
} from "./act.js";
import {
  checkTellReply,
  TELL_SCHEMA,
  TELL_SYSTEM,
  type TellAnswer,
  TellRejectedError,
  tellPrompt,
} from "./tell.js";

/**
 * Answers the questions the rules don't recognise: one mapping call (Haiku) for all of a form's
 * questions, then one drafting call (Sonnet) per question that needs a written answer. Every
 * reply is checked (questions.ts) and cached; nothing here decides what gets submitted.
 */

/** Told about every call Claude actually made (cached answers make none). */
export type UsageListener = (usage: ClaudeUsage) => void;

export interface QuestionAnswerer {
  answer(
    questions: readonly Question[],
    context: QuestionContext,
    onUsage?: UsageListener,
  ): Promise<ReadonlyMap<string, ClaudeAnswer>>;
  /** "Tell agent": one field, answered your way. Throws when the proposal doesn't fit. */
  tell(
    question: Question,
    instruction: string,
    context: QuestionContext,
    onUsage?: UsageListener,
  ): Promise<TellAnswer>;
  /** Any company's form: steps that set one field the extension couldn't fill by itself. */
  act(request: ActRequest, onUsage?: UsageListener): Promise<ActAnswer>;
  /** Why Claude is off for the signed-in user (no Claude key); null or absent when it's on. */
  unavailable?(): string | null;
}

/** The one SDK call used (the real client's `messages`, or a fake in tests). */
export interface MessagesApi {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message>;
}

export interface AnswererOptions {
  readonly messages: MessagesApi;
  /** Why Claude is off for the signed-in user (see access.ts); absent: always on. */
  readonly unavailable?: () => string | null;
  readonly cache: ClaudeAnswersRepo;
  readonly mapModel: string;
  readonly draftModel: string;
  readonly log?: (line: string) => void;
}

type Cached = ClaudeAnswer | { kind: "write" };

const MAP_MAX_TOKENS = 8_000;
const DRAFT_MAX_TOKENS = 4_000;

export class ClaudeReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeReplyError";
  }
}

function replyText(message: Anthropic.Message): string {
  if (message.stop_reason === "max_tokens")
    throw new ClaudeReplyError("Claude's reply was cut off");
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new ClaudeReplyError("Claude's reply was empty");
  return text;
}

export function createClaudeAnswerer(
  options: AnswererOptions,
): QuestionAnswerer {
  const { messages, cache, mapModel, draftModel } = options;
  const log = options.log ?? (() => {});

  const usage = (
    what: string,
    message: Anthropic.Message,
    onUsage: UsageListener,
  ) => {
    log(
      `[claude] ${what} ${message.model}: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`,
    );
    onUsage(
      usageOf(
        message.model,
        message.usage.input_tokens,
        message.usage.output_tokens,
      ),
    );
  };

  async function map(
    questions: readonly Question[],
    context: QuestionContext,
    onUsage: UsageListener,
  ): Promise<Map<string, Cached>> {
    const message = await messages.create({
      model: mapModel,
      max_tokens: MAP_MAX_TOKENS,
      system: MAP_SYSTEM,
      messages: [{ role: "user", content: mapPrompt(questions, context) }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: MAP_SCHEMA },
      },
    });
    usage(`mapped ${questions.length} question(s)`, message, onUsage);
    const declined = message.stop_reason === "refusal";
    const items = declined ? [] : parseMapReply(replyText(message));
    return new Map(
      questions.map((q) => {
        const checked: Cached = declined
          ? {
              kind: "unknown",
              why: "Claude declined to answer",
              model: mapModel,
            }
          : checkMapItem(
              q,
              items.find((i) => i.ref === q.ref),
              mapModel,
            );
        if (!declined)
          cache.save(cacheKey("map", mapModel, q, context), checked, mapModel);
        return [q.ref, checked];
      }),
    );
  }

  async function draft(
    question: Question,
    context: QuestionContext,
    onUsage: UsageListener,
  ): Promise<ClaudeAnswer> {
    const key = cacheKey("draft", draftModel, question, context);
    const cached = cache.get(key) as ClaudeAnswer | null;
    if (cached) return cached;
    const message = await messages.create({
      model: draftModel,
      max_tokens: DRAFT_MAX_TOKENS,
      system: DRAFT_SYSTEM,
      messages: [{ role: "user", content: draftPrompt(question, context) }],
      output_config: { effort: "low" },
    });
    usage("drafted 1 answer", message, onUsage);
    if (message.stop_reason === "refusal")
      return {
        kind: "unknown",
        why: "Claude declined to draft this",
        model: draftModel,
      };
    const answer: ClaudeAnswer = {
      kind: "draft",
      value: replyText(message).slice(0, MAX_DRAFT_CHARS),
      model: draftModel,
    };
    cache.save(key, answer, draftModel);
    return answer;
  }

  return {
    unavailable: () => options.unavailable?.() ?? null,
    async act(request, onUsage = () => {}) {
      // Reading a widget's markup is harder than answering: the drafting model.
      const message = await messages.create({
        model: draftModel,
        max_tokens: DRAFT_MAX_TOKENS,
        system: ACT_SYSTEM,
        messages: [{ role: "user", content: actPrompt(request) }],
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: ACT_SCHEMA },
        },
      });
      usage("worked out steps for 1 field", message, onUsage);
      if (message.stop_reason === "refusal")
        throw new TellRejectedError("Claude declined to operate this field");
      return checkActReply(replyText(message), draftModel);
    },

    async tell(question, instruction, context, onUsage = () => {}) {
      // Long-answer fields get the drafting model; everything else the quick one.
      const model = question.type === "textarea" ? draftModel : mapModel;
      const message = await messages.create({
        model,
        max_tokens: DRAFT_MAX_TOKENS,
        system: TELL_SYSTEM,
        messages: [
          {
            role: "user",
            content: tellPrompt(question, instruction, context),
          },
        ],
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: TELL_SCHEMA },
        },
      });
      usage("answered 1 field as told", message, onUsage);
      if (message.stop_reason === "refusal")
        throw new TellRejectedError("Claude declined to answer this");
      return checkTellReply(question, replyText(message), model);
    },

    async answer(questions, context, onUsage = () => {}) {
      if (questions.length === 0) return new Map();
      const known = new Map<string, Cached>();
      for (const q of questions) {
        const cached = cache.get(cacheKey("map", mapModel, q, context));
        if (cached) known.set(q.ref, cached as Cached);
      }
      const fresh = questions.filter((q) => !known.has(q.ref));
      const mapped =
        fresh.length > 0
          ? await map(fresh, context, onUsage)
          : new Map<string, Cached>();

      const results = new Map<string, ClaudeAnswer>();
      for (const q of questions) {
        const step = known.get(q.ref) ?? mapped.get(q.ref);
        if (!step) continue;
        results.set(
          q.ref,
          step.kind === "write" ? await draft(q, context, onUsage) : step,
        );
      }
      return results;
    },
  };
}
