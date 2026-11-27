import { logger } from "@infra/logger";
import * as settingsRepo from "@server/repositories/settings";
import {
  type CliAuthScope,
  getCliAuthScope,
} from "@server/services/llm/subscription-auth/scope";
import {
  isSubscriptionConnected,
  isSubscriptionProvider,
  type SubscriptionProvider,
} from "@server/services/llm/subscription-auth/status";
import { getUsageExhaustedUntil } from "@server/services/llm/subscription-auth/usage-backoff";
import { resolveLlmRuntimeSettings } from "@server/services/modelSelection";
import { LlmNotConfiguredError } from "@server/services/scorer";
import { settingsRegistry } from "@shared/settings-registry";

/**
 * Fork: scoring through a subscription CLI (Claude Code / Codex) is spread
 * out instead of bursting, and checks the user's login before the first job
 * so a missing login pauses the run once instead of failing every job.
 */
export const DEFAULT_SCORING_CONCURRENCY = 4;

export type CliScoringThrottleConfig = Readonly<{
  concurrency: number;
  delayMs: number;
  batchSize: number;
  batchPauseMs: number;
}>;

export type ScoringPlan = Readonly<{
  concurrency: number;
  throttled: boolean;
  beforeScore: () => Promise<void>;
  /**
   * When scoring runs on a subscription that is out of usage, its reset time;
   * otherwise null. Scoring stops early then instead of failing every job.
   */
  usageExhaustedUntil?: () => number | null;
}>;

export type CliScoringDeps = {
  resolveScoringProvider: () => Promise<string | null>;
  resolveScope: () => CliAuthScope;
  isConnected: (
    scope: CliAuthScope,
    provider: SubscriptionProvider,
  ) => Promise<boolean>;
  isFallbackEnabled: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  getExhaustedUntil?: (key: string) => number | null;
};

const THROTTLE_DEFAULTS: CliScoringThrottleConfig = {
  concurrency: 3,
  delayMs: 500,
  batchSize: 0,
  batchPauseMs: 30_000,
};

const LOGIN_MISSING_MESSAGES: Record<SubscriptionProvider, string> = {
  claude_cli:
    "Your Claude login is missing or expired — connect it in Settings, then Resume.",
  codex:
    "Your ChatGPT (Codex) login is missing or expired — connect it in Settings, then Resume.",
};

const NO_USER_MESSAGE =
  "This run has no signed-in Job Ops user (for example a webhook trigger or a scheduled search without an owner), so a personal Claude/ChatGPT subscription cannot be used. Start the run from the app, or pick an API provider for scoring.";

function readInt(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function readCliScoringThrottleConfig(
  env: NodeJS.ProcessEnv = process.env,
): CliScoringThrottleConfig {
  return {
    concurrency: readInt(
      env.JOBOPS_CLI_SCORING_CONCURRENCY,
      THROTTLE_DEFAULTS.concurrency,
      1,
    ),
    delayMs: readInt(
      env.JOBOPS_CLI_SCORING_DELAY_MS,
      THROTTLE_DEFAULTS.delayMs,
      0,
    ),
    batchSize: readInt(
      env.JOBOPS_CLI_SCORING_BATCH_SIZE,
      THROTTLE_DEFAULTS.batchSize,
      0,
    ),
    batchPauseMs: readInt(
      env.JOBOPS_CLI_SCORING_BATCH_PAUSE_MS,
      THROTTLE_DEFAULTS.batchPauseMs,
      0,
    ),
  };
}

/**
 * Serialises job starts: the first starts at once, each later one waits
 * `delayMs` (or `batchPauseMs` after every `batchSize` starts when enabled).
 */
export function createStartThrottle(
  config: CliScoringThrottleConfig,
  sleep: (ms: number) => Promise<void>,
): () => Promise<void> {
  let started = 0;
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const next = tail.then(async () => {
      if (started > 0) {
        const batchBoundary =
          config.batchSize > 0 && started % config.batchSize === 0;
        const waitMs = batchBoundary ? config.batchPauseMs : config.delayMs;
        if (waitMs > 0) await sleep(waitMs);
      }
      started += 1;
    });
    tail = next;
    return next;
  };
}

export async function assertSubscriptionScoringReady(
  provider: string | null,
  deps: CliScoringDeps,
): Promise<void> {
  if (!isSubscriptionProvider(provider)) return;
  let scope: CliAuthScope;
  try {
    scope = deps.resolveScope();
  } catch {
    throw new LlmNotConfiguredError(NO_USER_MESSAGE);
  }
  if (await deps.isConnected(scope, provider)) return;

  const other: SubscriptionProvider =
    provider === "claude_cli" ? "codex" : "claude_cli";
  const [fallbackEnabled, otherConnected] = await Promise.all([
    deps.isFallbackEnabled(),
    deps.isConnected(scope, other),
  ]);
  if (fallbackEnabled && otherConnected) {
    logger.warn(
      "Scoring subscription login missing — using the other subscription",
      {
        fromProvider: provider,
        toProvider: other,
      },
    );
    return;
  }
  throw new LlmNotConfiguredError(LOGIN_MISSING_MESSAGES[provider]);
}

async function readFallbackEnabled(): Promise<boolean> {
  try {
    const raw = await settingsRepo.getSetting("subscriptionFallback");
    return (
      settingsRegistry.subscriptionFallback.parse(raw ?? undefined) ??
      settingsRegistry.subscriptionFallback.default()
    );
  } catch {
    return settingsRegistry.subscriptionFallback.default();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDeps: CliScoringDeps = {
  resolveScoringProvider: async () =>
    (await resolveLlmRuntimeSettings("scoring")).provider,
  resolveScope: getCliAuthScope,
  isConnected: (scope, provider) => isSubscriptionConnected(scope, provider),
  isFallbackEnabled: readFallbackEnabled,
  sleep: defaultSleep,
};

export async function resolveScoringPlan(
  deps: CliScoringDeps = defaultDeps,
): Promise<ScoringPlan> {
  const provider = await deps.resolveScoringProvider();
  if (!isSubscriptionProvider(provider)) {
    return {
      concurrency: DEFAULT_SCORING_CONCURRENCY,
      throttled: false,
      beforeScore: async () => undefined,
    };
  }
  await assertSubscriptionScoringReady(provider, deps);
  const config = readCliScoringThrottleConfig();
  const usageKey = `${deps.resolveScope().scopeKey}:${provider}`;
  const getExhaustedUntil = deps.getExhaustedUntil ?? getUsageExhaustedUntil;
  return {
    concurrency: config.concurrency,
    throttled: true,
    beforeScore: createStartThrottle(config, deps.sleep),
    usageExhaustedUntil: () => getExhaustedUntil(usageKey),
  };
}
