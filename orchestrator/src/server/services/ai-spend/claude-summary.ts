import { logger } from "@infra/logger";
import { z } from "zod";

const TIMEOUT_MS = 3_000;
const DEFAULT_URL = "http://apply-assistant:3006";

const claudeSummarySchema = z.object({
  ok: z.literal(true),
  data: z.object({
    totalUsd: z.number(),
    monthUsd: z.number(),
    todayUsd: z.number(),
    calls: z.number(),
    unpriced: z.number(),
    byModel: z.array(
      z.object({ model: z.string(), usd: z.number(), calls: z.number() }),
    ),
    since: z.string().nullable(),
    credit: z
      .object({
        amountUsd: z.number(),
        asOf: z.string(),
        spentSinceUsd: z.number(),
        remainingUsd: z.number(),
      })
      .nullable(),
  }),
});

export type ClaudeSpendSummary = z.infer<typeof claudeSummarySchema>["data"];

function summaryUrl(): string {
  const base = (process.env.APPLY_ASSISTANT_URL?.trim() || DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
  return `${base}/usage/claude/summary`;
}

/** Fetches Claude spend from apply-assistant, forwarding the caller's auth. */
export async function fetchClaudeSummary(
  authorization: string | undefined,
): Promise<ClaudeSpendSummary | null> {
  const headers: Record<string, string> = {};
  if (authorization) headers.Authorization = authorization;
  try {
    const response = await fetch(summaryUrl(), {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = claudeSummarySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.data : null;
  } catch (error) {
    logger.warn("Claude spend summary unavailable", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
