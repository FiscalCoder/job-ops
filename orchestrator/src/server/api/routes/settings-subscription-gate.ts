import { forbidden } from "@infra/errors";
import { getTenantId, isSystemAdmin } from "@infra/request-context";
import { getJobOpsAppConfig } from "@server/config/app-mode";
import { getSetting } from "@server/repositories/settings";
import { countTenantMembers } from "@server/repositories/tenant-members";
import { settingsRegistry } from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema";
import type { LlmPurposeOverrides } from "@shared/types";

/**
 * Fork: non-admin users may point their own AI settings at the subscription
 * CLIs (each user's own Claude / ChatGPT login), but never at an API provider,
 * a base URL or an API key — those would use server-owned credentials.
 */
const SUBSCRIPTION_PROVIDERS = new Set(["claude_cli", "codex"]);

const SUBSCRIPTION_SETTING_KEYS = new Set<keyof UpdateSettingsInput>([
  "llmProvider",
  "model",
  "modelScorer",
  "modelTailoring",
  "modelProjectSelection",
  "llmPurposeOverrides",
  "claudeCliEffort",
  "subscriptionFallback",
]);

function isSubscriptionProviderValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    SUBSCRIPTION_PROVIDERS.has(value.trim().toLowerCase().replace(/-/g, "_"))
  );
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function hasOnlySubscriptionOverrides(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((override) => {
    if (typeof override !== "object" || override === null) return false;
    const { provider, baseUrl } = override as {
      provider?: unknown;
      baseUrl?: unknown;
    };
    const hasBaseUrl = typeof baseUrl === "string" && baseUrl.trim() !== "";
    return isSubscriptionProviderValue(provider) && !hasBaseUrl;
  });
}

export function isNonAdminSubscriptionSettingsUpdate(
  input: UpdateSettingsInput,
  searchSettingKeys: ReadonlySet<keyof UpdateSettingsInput>,
): boolean {
  const keys = Object.keys(input) as Array<keyof UpdateSettingsInput>;
  const subscriptionKeys = keys.filter((key) =>
    SUBSCRIPTION_SETTING_KEYS.has(key),
  );
  if (subscriptionKeys.length === 0) return false;
  if (
    !keys.every(
      (key) =>
        SUBSCRIPTION_SETTING_KEYS.has(key) ||
        searchSettingKeys.has(key) ||
        // Clearing a leftover base URL never points at server credentials.
        (key === "llmBaseUrl" && isBlank(input.llmBaseUrl)),
    )
  ) {
    return false;
  }
  if (
    Object.hasOwn(input, "llmProvider") &&
    !isSubscriptionProviderValue(input.llmProvider)
  ) {
    return false;
  }
  if (
    Object.hasOwn(input, "llmPurposeOverrides") &&
    !hasOnlySubscriptionOverrides(input.llmPurposeOverrides)
  ) {
    return false;
  }
  return true;
}

/**
 * Fork: LLM settings are tenant-wide in local mode while subscription logins
 * are per user, so a non-admin may only change them for a workspace they are
 * alone in, and only in ways that keep every LLM call on a subscription.
 */
export type NonAdminLlmGateState = Readonly<{
  memberCount: number;
  /** The provider currently in effect for the tenant (stored or default). */
  currentProvider: string | null;
  storedOverrides: LlmPurposeOverrides | null;
}>;

export const SHARED_WORKSPACE_MESSAGE =
  "Only an admin can change the AI provider for a shared workspace";
const MODEL_NEEDS_SUBSCRIPTION_MESSAGE =
  "Model settings can only be changed while a subscription provider (Claude or ChatGPT login) is selected.";
const ADMIN_OVERRIDES_MESSAGE =
  "An admin set per-purpose AI providers for this workspace; only an admin can change them.";
/**
 * Keys that name a model for the default provider. Setting one (to a non-null
 * value) only makes sense when that provider is a subscription. Resetting to
 * null, routing a task to a subscription override, or changing the Claude
 * effort never touches an API provider's model, so those are not listed.
 */
const MODEL_NAME_KEYS: ReadonlyArray<keyof UpdateSettingsInput> = [
  "model",
  "modelScorer",
  "modelTailoring",
  "modelProjectSelection",
];

function namesModelForDefaultProvider(input: UpdateSettingsInput): boolean {
  return MODEL_NAME_KEYS.some(
    (key) => Object.hasOwn(input, key) && input[key] != null,
  );
}

/** Overrides that only route to subscriptions (or inherit the primary). */
function storedOverridesStayOnSubscriptions(
  overrides: LlmPurposeOverrides | null,
): boolean {
  return Object.values(overrides ?? {}).every((override) => {
    if (!override) return true;
    const hasBaseUrl = Boolean(override.baseUrl?.trim());
    const provider = override.provider ?? null;
    return (
      !hasBaseUrl &&
      (provider === null || isSubscriptionProviderValue(provider))
    );
  });
}

function resultingProvider(
  input: UpdateSettingsInput,
  state: NonAdminLlmGateState,
): unknown {
  return Object.hasOwn(input, "llmProvider")
    ? input.llmProvider
    : state.currentProvider;
}

/** Error message for a non-admin LLM settings change, or null when allowed. */
export function checkNonAdminSubscriptionUpdate(
  input: UpdateSettingsInput,
  state: NonAdminLlmGateState,
): string | null {
  if (state.memberCount !== 1) return SHARED_WORKSPACE_MESSAGE;
  // Overrides are replaced as a whole object (their providers were already
  // checked to be subscriptions), so never let a non-admin replace or clear
  // admin-set API overrides.
  if (
    Object.hasOwn(input, "llmPurposeOverrides") &&
    !storedOverridesStayOnSubscriptions(state.storedOverrides)
  ) {
    return ADMIN_OVERRIDES_MESSAGE;
  }
  if (!namesModelForDefaultProvider(input)) return null;
  if (!isSubscriptionProviderValue(resultingProvider(input, state))) {
    return MODEL_NEEDS_SUBSCRIPTION_MESSAGE;
  }
  if (!storedOverridesStayOnSubscriptions(state.storedOverrides)) {
    return ADMIN_OVERRIDES_MESSAGE;
  }
  return null;
}

async function loadNonAdminLlmGateState(): Promise<NonAdminLlmGateState> {
  const tenantId = getTenantId();
  const [memberCount, rawProvider, rawOverrides] = await Promise.all([
    tenantId ? countTenantMembers(tenantId) : Promise.resolve(0),
    getSetting("llmProvider"),
    getSetting("llmPurposeOverrides"),
  ]);
  return {
    memberCount,
    currentProvider:
      settingsRegistry.llmProvider.parse(rawProvider ?? undefined) ??
      settingsRegistry.llmProvider.default(),
    storedOverrides: settingsRegistry.llmPurposeOverrides.parse(
      rawOverrides ?? undefined,
    ),
  };
}

/**
 * Enforce the rules above for a non-admin, local-mode PATCH that touches
 * subscription LLM settings. Throws 403; a no-op for everyone else.
 */
export async function enforceNonAdminSubscriptionRules(
  input: UpdateSettingsInput,
): Promise<void> {
  if (getJobOpsAppConfig().appMode === "hosted" || isSystemAdmin()) return;
  const keys = Object.keys(input) as Array<keyof UpdateSettingsInput>;
  if (!keys.some((key) => SUBSCRIPTION_SETTING_KEYS.has(key))) return;
  const message = checkNonAdminSubscriptionUpdate(
    input,
    await loadNonAdminLlmGateState(),
  );
  if (message) throw forbidden(message);
}
