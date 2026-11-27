import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  SubscriptionCallBody,
  SubscriptionReply,
} from "../jobops/client.js";
import { currentUserOrNull, currentUserToken } from "../store/owner.js";
import { currentAiContext } from "./ai-context.js";
import type { MessagesApi } from "./answerer.js";

/**
 * Claude through the signed-in user's own Claude subscription (Job Ops runs the Claude CLI),
 * with the API key (`fallback`) for anything the subscription can't do or when it fails.
 * Replies are ordinary Messages; their model is prefixed "subscription:" so they're logged
 * with their tokens but no price (pricing.ts knows no such model).
 */

export const SUBSCRIPTION_MODEL_PREFIX = "subscription:";
/** After a usage limit, skip the subscription for this long instead of waiting on it per call. */
const LIMIT_COOLDOWN_MS = 5 * 60_000;
const EFFORTS = new Set(["low", "medium", "high"]);
const TEXT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

class Unsupported extends Error {}

type CallBody = SubscriptionCallBody;
type Content = Exclude<CallBody["messages"][number]["content"], string>;

function systemText(system: Anthropic.MessageCreateParams["system"]): string | undefined {
  if (!system) return undefined;
  return typeof system === "string" ? system : system.map((block) => block.text).join("\n\n");
}

function contentOf(content: Anthropic.MessageParam["content"]): string | Content {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (block.type === "image" && block.source.type === "base64")
      return { type: "image" as const, mediaType: block.source.media_type, data: block.source.data };
    throw new Unsupported(`a ${block.type} block`);
  });
}

/** The CLI call for these params; throws Unsupported for what it can't do (tools, documents). */
export function toSubscriptionCall(
  params: Anthropic.MessageCreateParamsNonStreaming,
): { body: CallBody; wrapped: boolean } {
  if (params.tools?.length) throw new Unsupported("tools");
  const config = (params as { output_config?: { effort?: string; format?: { type?: string; schema?: unknown } } })
    .output_config;
  const schema =
    config?.format?.type === "json_schema" && config.format.schema
      ? (config.format.schema as Record<string, unknown>)
      : null;
  const system = systemText(params.system);
  const effort = config?.effort && EFFORTS.has(config.effort) ? config.effort : undefined;
  return {
    body: {
      model: params.model,
      purpose: currentAiContext().purpose,
      ...(effort ? { effort: effort as CallBody["effort"] } : {}),
      ...(system ? { system } : {}),
      messages: params.messages.map((m) => {
        if (m.role !== "user" && m.role !== "assistant") throw new Unsupported(`a ${m.role} turn`);
        return { role: m.role, content: contentOf(m.content) };
      }),
      schema: schema ?? TEXT_SCHEMA,
    },
    wrapped: !schema,
  };
}

/** The CLI's reply as a Message the callers already read. */
export function toMessage(model: string, reply: SubscriptionReply, wrapped: boolean): Anthropic.Message {
  const text = wrapped ? String((JSON.parse(reply.text) as { text?: unknown }).text ?? "") : reply.text;
  const usage = reply.usage ?? {};
  return {
    id: `sub_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: `${SUBSCRIPTION_MODEL_PREFIX}${model}`,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

export function subscriptionFirst(deps: {
  readonly call: (token: string, body: CallBody) => Promise<SubscriptionReply>;
  /** The API key route (the user's own or the admin's); also used when the subscription fails. */
  readonly fallback: MessagesApi;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}): MessagesApi {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const limitedUntil = new Map<string, number>();

  return {
    async create(params) {
      const token = currentUserToken();
      const user = currentUserOrNull() ?? "";
      if (!token || (limitedUntil.get(user) ?? 0) > now()) return deps.fallback.create(params);
      let call: ReturnType<typeof toSubscriptionCall>;
      try {
        call = toSubscriptionCall(params);
      } catch (error) {
        if (error instanceof Unsupported) return deps.fallback.create(params);
        throw error;
      }
      try {
        return toMessage(params.model, await deps.call(token, call.body), call.wrapped);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 429) limitedUntil.set(user, now() + LIMIT_COOLDOWN_MS);
        log(`[claude] subscription call failed (${String(status ?? "")} ${error instanceof Error ? error.message : String(error)}); using the API key`);
        return deps.fallback.create(params);
      }
    },
  };
}
