import { logger } from "@infra/logger";
import { resolveLlmFallbackRuntimeSettings } from "@server/services/modelSelection";
import { LlmService } from "./service";
import type { LlmRequestOptions, LlmResponse } from "./types";

const RATE_LIMIT_STATUS = 429;

/**
 * Calls the primary LLM service. If it fails with a 429 (quota/rate-limit
 * exhausted) and a fallback provider is configured, retries once through the
 * fallback provider instead. Any other failure (bad request, capability
 * error, misconfigured credentials) is returned as-is — fallback only exists
 * for "primary is out of quota right now", not to mask real errors.
 */
export async function callJsonWithFallback<T>(
  primary: LlmService,
  options: LlmRequestOptions<T>,
): Promise<LlmResponse<T>> {
  const primaryResult = await primary.callJson<T>(options);
  if (primaryResult.success || primaryResult.status !== RATE_LIMIT_STATUS) {
    return primaryResult;
  }

  const fallbackRuntime = await resolveLlmFallbackRuntimeSettings();
  if (!fallbackRuntime) return primaryResult;

  logger.warn(
    "Primary LLM provider rate-limited — retrying via fallback provider",
    {
      jobId: options.jobId ?? "unknown",
      fallbackProvider: fallbackRuntime.provider,
    },
  );

  const fallbackService = new LlmService({
    provider: fallbackRuntime.provider,
    baseUrl: fallbackRuntime.baseUrl,
    apiKey: fallbackRuntime.apiKey,
  });

  const fallbackResult = await fallbackService.callJson<T>({
    ...options,
    model: fallbackRuntime.model,
  });

  if (fallbackResult.success) {
    logger.info("Fallback LLM provider succeeded after primary rate limit", {
      jobId: options.jobId ?? "unknown",
      fallbackProvider: fallbackRuntime.provider,
    });
  } else {
    logger.warn("Fallback LLM provider also failed", {
      jobId: options.jobId ?? "unknown",
      fallbackProvider: fallbackRuntime.provider,
      error: fallbackResult.error,
    });
  }

  return fallbackResult;
}
