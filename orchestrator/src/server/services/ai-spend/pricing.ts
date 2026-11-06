/**
 * DeepSeek pricing and peak-hour logic (USD per 1M tokens, fetched 2026-11-06).
 * Pure module: no IO, no clock access except via the `at` argument.
 */

export const DEEPSEEK_HOST = "api.deepseek.com";

export interface ModelRates {
  cacheHitPerM: number;
  cacheMissPerM: number;
  outputPerM: number;
}

interface PeakRates {
  peak: ModelRates;
  offPeak: ModelRates;
}

const FLASH_RATES: PeakRates = {
  peak: { cacheHitPerM: 0.006, cacheMissPerM: 0.3, outputPerM: 1.2 },
  offPeak: { cacheHitPerM: 0.003, cacheMissPerM: 0.15, outputPerM: 0.6 },
};

const PRO_RATES: PeakRates = {
  peak: { cacheHitPerM: 0.044, cacheMissPerM: 1.32, outputPerM: 3.96 },
  offPeak: { cacheHitPerM: 0.022, cacheMissPerM: 0.66, outputPerM: 1.98 },
};

const RATES_BY_MODEL: Readonly<Record<string, PeakRates>> = {
  "deepseek-flash": FLASH_RATES,
  "deepseek-v4-flash": FLASH_RATES,
  "deepseek-v4-pro": PRO_RATES,
};

export interface TokenUsage {
  promptTokens: number;
  cacheHitTokens: number | null;
  completionTokens: number;
}

export interface CostResult {
  costUsd: number | null;
  peak: boolean;
}

/** Peak = 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday. */
export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function isDeepSeekHost(host: string | null | undefined): boolean {
  return (host ?? "").trim().toLowerCase() === DEEPSEEK_HOST;
}

function lookupRates(model: string): PeakRates | null {
  const key = model.trim().toLowerCase();
  if (RATES_BY_MODEL[key]) return RATES_BY_MODEL[key];
  // Legacy names like "deepseek-v4-flash-0501" bill at the flash price.
  if (key.startsWith("deepseek-v4-flash")) return FLASH_RATES;
  if (key.startsWith("deepseek-v4-pro")) return PRO_RATES;
  return null;
}

/** Cost for one call, or costUsd=null when host/model is not priced. */
export function computeDeepSeekCost(args: {
  host: string | null;
  model: string;
  usage: TokenUsage;
  at: Date;
}): CostResult {
  const peak = isDeepSeekPeak(args.at);
  if (!isDeepSeekHost(args.host)) return { costUsd: null, peak };
  const rates = lookupRates(args.model);
  if (!rates) return { costUsd: null, peak };

  const r = peak ? rates.peak : rates.offPeak;
  const hit = Math.min(
    Math.max(args.usage.cacheHitTokens ?? 0, 0),
    args.usage.promptTokens,
  );
  const miss = Math.max(args.usage.promptTokens - hit, 0);
  const usd =
    (hit * r.cacheHitPerM +
      miss * r.cacheMissPerM +
      args.usage.completionTokens * r.outputPerM) /
    1_000_000;
  return { costUsd: usd, peak };
}
