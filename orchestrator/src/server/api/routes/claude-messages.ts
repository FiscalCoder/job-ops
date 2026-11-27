import { badRequest, serviceUnavailable, tooManyRequests } from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { recordLlmUsageSafely } from "@server/services/ai-spend/usage-recorder";
import { ClaudeCliClient } from "@server/services/llm/claude-cli/client";
import { getLlmErrorStatus } from "@server/services/llm/claude-cli/errors";
import { getCliAuthScope } from "@server/services/llm/subscription-auth/scope";
import type {
  JsonSchemaDefinition,
  LlmRequestOptions,
} from "@server/services/llm/types";
import { CLAUDE_CLI_EFFORT_VALUES } from "@shared/settings-registry";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { createScopeRateLimiter, toRetryAfterSeconds } from "./llm-auth-guards";

/**
 * Fork: one Claude call on the caller's own Claude subscription login (the
 * Claude CLI), for the apply-assistant. Answers with the model's text and token
 * usage; the apply-assistant falls back to its API key on any failure.
 */
export const claudeMessagesRouter = Router();

const CALLS_PER_MINUTE = 30;
const limiter = createScopeRateLimiter({
  limit: CALLS_PER_MINUTE,
  windowMs: 60_000,
});

const MAX_TEXT = 400_000;
const textBlock = z.object({
  type: z.literal("text"),
  text: z.string().max(MAX_TEXT),
});
const imageBlock = z.object({
  type: z.literal("image"),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z.string().max(8_000_000),
});
const bodySchema = z.object({
  model: z.string().trim().min(1).max(100),
  purpose: z
    .string()
    .trim()
    .max(60)
    .regex(/^[\w-]*$/)
    .optional(),
  effort: z.enum(CLAUDE_CLI_EFFORT_VALUES).optional(),
  system: z.string().max(MAX_TEXT).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([
          z.string().max(MAX_TEXT),
          z.array(z.union([textBlock, imageBlock])).max(40),
        ]),
      }),
    )
    .min(1)
    .max(20),
  // The CLI only passes the schema through (--json-schema); Claude validates it.
  schema: z.object({ type: z.literal("object") }).passthrough(),
});
type Body = z.infer<typeof bodySchema>;

function toLlmMessages(body: Body): LlmRequestOptions<unknown>["messages"] {
  const turns = body.messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) =>
            block.type === "text"
              ? block
              : {
                  type: "image" as const,
                  imageUrl: `data:${block.mediaType};base64,${block.data}`,
                  mediaType: block.mediaType,
                },
          ),
  }));
  return body.system
    ? [{ role: "system", content: body.system }, ...turns]
    : turns;
}

claudeMessagesRouter.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, badRequest(parsed.error.message));
      return;
    }
    const body = parsed.data;
    const retryAfterMs = limiter.hit(getCliAuthScope().scopeKey);
    if (retryAfterMs !== null) {
      res.setHeader("Retry-After", String(toRetryAfterSeconds(retryAfterMs)));
      fail(res, tooManyRequests("Too many Claude calls; slow down."));
      return;
    }
    const purpose = body.purpose || "call";
    const client = new ClaudeCliClient(
      body.effort ? { resolveEffort: async () => body.effort ?? "low" } : {},
    );
    try {
      const result = await client.callJson({
        model: body.model,
        messages: toLlmMessages(body),
        jsonSchema: {
          name: `apply_${purpose}`,
          schema: body.schema as JsonSchemaDefinition["schema"],
        },
      });
      recordLlmUsageSafely({
        provider: "claude_cli",
        baseUrl: "",
        model: body.model,
        feature: `apply:${purpose}`,
        response: { usage: result.usage },
      });
      ok(res, { text: result.text, usage: result.usage ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Subscription Claude call failed", { purpose, message });
      fail(
        res,
        getLlmErrorStatus(error) === 429
          ? tooManyRequests(message)
          : serviceUnavailable(message),
      );
    }
  }),
);
