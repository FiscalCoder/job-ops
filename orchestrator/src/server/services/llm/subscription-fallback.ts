import { logger } from "@infra/logger";
import * as settingsRepo from "@server/repositories/settings";
import {
  DEFAULT_CLAUDE_CLI_SCORING_MODEL,
  DEFAULT_CODEX_MODEL,
  settingsRegistry,
} from "@shared/settings-registry";
import { isConfigurationFailure } from "./policies/configuration-error";
import { LlmService } from "./service";
import { type CliAuthScope, getCliAuthScope } from "./subscription-auth/scope";
import {
  isSubscriptionConnected,
  isSubscriptionProvider,
  type SubscriptionProvider,
} from "./subscription-auth/status";
import { waitForUsageBackoff } from "./subscription-auth/usage-backoff";
import type { LlmRequestOptions, LlmResponse } from "./types";

/**
 * Fork: recovery for calls made through a user's subscription CLI.
 *  1. Usage limit (429): wait out a shared per-user backoff, retry once.
 *  2. Still limited, or the login is missing/expired: if the user enabled
 *     `subscriptionFallback` and has the OTHER subscription connected, retry
 *     the call through it. Only the same user's scope is ever used.
 * Anything else is returned unchanged for the existing fallback/pause logic.
 */
type JsonCaller = {
  callJson: <T>(options: LlmRequestOptions<T>) => Promise<LlmResponse<T>>;
};
type PrimaryService = JsonCaller & { getProvider?: () => string };

export type SubscriptionRecoveryDeps = {
  resolveScope: () => CliAuthScope;
  isConnected: (
    scope: CliAuthScope,
    provider: SubscriptionProvider,
  ) => Promise<boolean>;
  isFallbackEnabled: () => Promise<boolean>;
  createService: (provider: SubscriptionProvider) => JsonCaller;
  waitForBackoff: (key: string) => Promise<void>;
};

const RATE_LIMIT_STATUS = 429;
/** Set by the CLI clients only when the CLI's own error field says so. */
const AUTH_FAILURE_STATUS = 401;

async function readSubscriptionFallbackSetting(): Promise<boolean> {
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

const defaultDeps: SubscriptionRecoveryDeps = {
  resolveScope: getCliAuthScope,
  isConnected: (scope, provider) => isSubscriptionConnected(scope, provider),
  isFallbackEnabled: readSubscriptionFallbackSetting,
  createService: (provider) =>
    new LlmService({ provider, allowCliProviders: true }),
  waitForBackoff: (key) => waitForUsageBackoff(key),
};

function otherSubscription(
  provider: SubscriptionProvider,
): SubscriptionProvider {
  return provider === "claude_cli" ? "codex" : "claude_cli";
}

function fallbackModelFor(provider: SubscriptionProvider): string {
  return provider === "claude_cli"
    ? DEFAULT_CLAUDE_CLI_SCORING_MODEL
    : DEFAULT_CODEX_MODEL;
}

function isRecoverable(result: LlmResponse<unknown>): boolean {
  return (
    !result.success &&
    (result.status === RATE_LIMIT_STATUS ||
      result.status === AUTH_FAILURE_STATUS ||
      isConfigurationFailure(result.error))
  );
}

export async function callJsonWithSubscriptionRecovery<T>(
  primary: PrimaryService,
  options: LlmRequestOptions<T>,
  deps: SubscriptionRecoveryDeps = defaultDeps,
): Promise<LlmResponse<T>> {
  const provider = primary.getProvider?.();
  const first = await primary.callJson<T>(options);
  if (first.success || !isSubscriptionProvider(provider)) return first;
  if (!isRecoverable(first)) return first;

  let scope: CliAuthScope;
  try {
    scope = deps.resolveScope();
  } catch {
    return first;
  }

  let latest: LlmResponse<T> = first;
  if (!first.success && first.status === RATE_LIMIT_STATUS) {
    logger.warn("Subscription usage limit hit — backing off before retry", {
      jobId: options.jobId ?? "unknown",
      provider,
    });
    await deps.waitForBackoff(`${scope.scopeKey}:${provider}`);
    latest = await primary.callJson<T>(options);
    if (latest.success || !isRecoverable(latest)) return latest;
  }

  const fallbackProvider = otherSubscription(provider);
  const [enabled, connected] = await Promise.all([
    deps.isFallbackEnabled(),
    deps.isConnected(scope, fallbackProvider),
  ]);
  if (!enabled || !connected) return latest;

  logger.warn(
    "Subscription call failed — retrying via the user's other subscription",
    {
      jobId: options.jobId ?? "unknown",
      fromProvider: provider,
      toProvider: fallbackProvider,
    },
  );
  const fallbackResult = await deps
    .createService(fallbackProvider)
    .callJson<T>({ ...options, model: fallbackModelFor(fallbackProvider) });
  if (fallbackResult.success) {
    logger.info("Subscription fallback succeeded", {
      jobId: options.jobId ?? "unknown",
      fromProvider: provider,
      toProvider: fallbackProvider,
    });
    return fallbackResult;
  }
  logger.warn("Subscription fallback also failed", {
    jobId: options.jobId ?? "unknown",
    fromProvider: provider,
    toProvider: fallbackProvider,
    error: fallbackResult.error,
  });
  return latest;
}
