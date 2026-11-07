import { randomUUID } from "node:crypto";
import { logger } from "@infra/logger";
import { getPrivateDataScope } from "@server/tenancy/private-scope";
import { computeDeepSeekCost, type TokenUsage } from "./pricing";

export interface RecordableCall {
  provider: string;
  baseUrl: string;
  model: string;
  /** Short call-site label, e.g. the structured-output schema name. */
  feature: string | null;
  /** Parsed JSON body of the provider response. */
  response: unknown;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads token usage from a chat-completions (`prompt_tokens`) or
 * responses-API (`input_tokens`) body. Returns null if absent.
 */
export function extractTokenUsage(response: unknown): TokenUsage | null {
  const usage = asRecord(asRecord(response)?.usage);
  if (!usage) return null;
  const prompt = asCount(usage.prompt_tokens) ?? asCount(usage.input_tokens);
  const completion =
    asCount(usage.completion_tokens) ?? asCount(usage.output_tokens);
  if (prompt === null && completion === null) return null;
  const details = asRecord(usage.prompt_tokens_details);
  const cacheHit =
    asCount(usage.prompt_cache_hit_tokens) ?? asCount(details?.cached_tokens);
  return {
    promptTokens: prompt ?? 0,
    cacheHitTokens: cacheHit,
    completionTokens: completion ?? 0,
  };
}

export function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Persists one usage row for the current request scope. */
export async function recordLlmUsage(
  call: RecordableCall,
  now: Date = new Date(),
): Promise<boolean> {
  const usage = extractTokenUsage(call.response);
  if (!usage) return false;
  const scope = getPrivateDataScope();
  const host = hostOf(call.baseUrl);
  const { costUsd, peak } = computeDeepSeekCost({
    host,
    model: call.model,
    usage,
    at: now,
  });
  // Lazy import keeps the DB out of modules (and tests) that never record.
  const { db, schema } = await import("@server/db");
  await db.insert(schema.llmUsage).values({
    id: randomUUID(),
    tenantId: scope.tenantId,
    userId: scope.userId,
    provider: call.provider,
    model: call.model,
    host,
    feature: call.feature,
    promptTokens: usage.promptTokens,
    cacheHitTokens: usage.cacheHitTokens,
    completionTokens: usage.completionTokens,
    costUsd,
    peak: peak ? 1 : 0,
    createdAt: now.toISOString(),
  });
  return true;
}

/**
 * Fire-and-forget wrapper for the LLM hot path. The request scope is read
 * synchronously inside recordLlmUsage before its first await, so async
 * context is preserved; failures are logged and never thrown.
 */
/** Providers whose responses carry OpenAI-style usage counts (DeepSeek is openai_compatible). */
const RECORDED_PROVIDERS = new Set(["openai_compatible", "openai"]);

export function recordLlmUsageSafely(call: RecordableCall): void {
  if (!RECORDED_PROVIDERS.has(call.provider)) return;
  try {
    void recordLlmUsage(call).catch((error: unknown) => {
      logger.warn("Failed to record LLM usage", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("Failed to record LLM usage", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
