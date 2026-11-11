import type { AiCallStore } from "../store/ai-call-store.js";
import { currentAiContext } from "./ai-context.js";
import type { MessagesApi } from "./answerer.js";
import { usageOfMessage } from "./pricing.js";

/**
 * Claude's API with every call logged end to end (ai-call-store.ts): the request, the reply or
 * the error, tokens, cost and time, tied to whatever job, run, field and purpose it ran for.
 * Logging never changes the call: its result or error passes through as it was.
 */
export function loggedMessages(
  inner: MessagesApi,
  calls: Pick<AiCallStore, "record">,
  clock: () => number = Date.now,
): MessagesApi {
  return {
    async create(params) {
      const context = currentAiContext();
      const started = clock();
      try {
        const message = await inner.create(params);
        calls.record({
          context,
          model: message.model,
          request: params,
          response: message,
          stopReason: message.stop_reason,
          usage: usageOfMessage(message),
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
          durationMs: clock() - started,
        });
        return message;
      } catch (error) {
        calls.record({
          context,
          model: params.model,
          request: params,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          durationMs: clock() - started,
        });
        throw error;
      }
    },
  };
}
