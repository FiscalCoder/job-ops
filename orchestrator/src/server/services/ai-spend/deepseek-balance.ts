import { logger } from "@infra/logger";
import { z } from "zod";
import { isDeepSeekHost } from "./pricing";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const TIMEOUT_MS = 5_000;
export const BALANCE_CACHE_TTL_MS = 10 * 60 * 1000;

const balanceResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(
    z.object({
      currency: z.string(),
      total_balance: z.string(),
      granted_balance: z.string(),
      topped_up_balance: z.string(),
    }),
  ),
});

export interface DeepSeekBalance {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
  isAvailable: boolean;
}

export interface BalanceResult {
  balance: DeepSeekBalance | null;
  /** Short, key-free reason when balance is null. */
  error?: string;
}

const cache = new Map<string, { at: number; value: DeepSeekBalance }>();

export function clearDeepSeekBalanceCache(): void {
  cache.clear();
}

function hostFromBaseUrl(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function parseBalance(payload: unknown): BalanceResult {
  const parsed = balanceResponseSchema.safeParse(payload);
  if (!parsed.success) return { balance: null, error: "unexpected response" };
  const infos = parsed.data.balance_infos;
  const info = infos.find((i) => i.currency === "USD") ?? infos[0];
  if (!info) return { balance: null, error: "no balance info" };
  const total = Number(info.total_balance);
  const granted = Number(info.granted_balance);
  const toppedUp = Number(info.topped_up_balance);
  if (![total, granted, toppedUp].every(Number.isFinite)) {
    return { balance: null, error: "unexpected response" };
  }
  return {
    balance: {
      currency: info.currency,
      total,
      granted,
      toppedUp,
      isAvailable: parsed.data.is_available,
    },
  };
}

function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError"
    ? "timeout"
    : "request failed";
}

/**
 * Fetches the DeepSeek account balance for the configured key. Never logs or
 * returns the key; only used when the base URL host is api.deepseek.com.
 */
export async function getDeepSeekBalance(args: {
  baseUrl: string | null;
  apiKey: string | null;
  cacheKey: string;
  now?: number;
}): Promise<BalanceResult> {
  if (!isDeepSeekHost(hostFromBaseUrl(args.baseUrl))) {
    return { balance: null, error: "not a DeepSeek endpoint" };
  }
  if (!args.apiKey) return { balance: null, error: "no API key configured" };

  const now = args.now ?? Date.now();
  const hit = cache.get(args.cacheKey);
  if (hit && now - hit.at < BALANCE_CACHE_TTL_MS) {
    return { balance: hit.value };
  }

  try {
    const response = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${args.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { balance: null, error: `HTTP ${response.status}` };
    }
    const result = parseBalance(await response.json());
    if (result.balance)
      cache.set(args.cacheKey, { at: now, value: result.balance });
    return result;
  } catch (error) {
    logger.warn("DeepSeek balance lookup failed", {
      reason: describeFailure(error),
    });
    return { balance: null, error: describeFailure(error) };
  }
}
