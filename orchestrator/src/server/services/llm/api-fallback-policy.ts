import { getSetting } from "@server/repositories/settings";
import { isSubscriptionProvider } from "./subscription-auth/status";

/**
 * Fork: a subscription primary (claude_cli / codex) runs on the caller's own
 * login. Its API fallback must not quietly switch that caller onto server
 * credentials, so it is only allowed when the fallback key is the tenant's
 * own stored `llmFallbackApiKey` — never LLM_FALLBACK_API_KEY / LLM_API_KEY
 * from the server environment, for admins and non-admins alike.
 */
export type ApiFallbackDecision = Readonly<{
  allowed: boolean;
  /** Pass to LlmService so it cannot pick env keys / base URLs either. */
  allowEnvironmentCredentials: boolean;
}>;

async function isTenantStoredKey(apiKey: string | null): Promise<boolean> {
  if (!apiKey) return false;
  const stored = (await getSetting("llmFallbackApiKey"))?.trim();
  return Boolean(stored) && stored === apiKey;
}

export async function decideApiFallback(
  primaryProvider: string | undefined,
  fallbackApiKey: string | null,
): Promise<ApiFallbackDecision> {
  if (!isSubscriptionProvider(primaryProvider)) {
    return { allowed: true, allowEnvironmentCredentials: true };
  }
  return {
    allowed: await isTenantStoredKey(fallbackApiKey),
    allowEnvironmentCredentials: false,
  };
}
