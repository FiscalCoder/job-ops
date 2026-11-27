import { DEFAULT_CLAUDE_CLI_SCORING_MODEL } from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema";
import type {
  AppSettings,
  LlmPurpose,
  LlmPurposeOverrides,
} from "@shared/types";

export type SubscriptionProviderId = "claude_cli" | "codex";
export const INHERIT_CHOICE = "inherit";
export type TaskChoice = SubscriptionProviderId | typeof INHERIT_CHOICE;

export const SUBSCRIPTION_PROVIDER_LABELS: Record<
  SubscriptionProviderId,
  string
> = {
  claude_cli: "Claude",
  codex: "ChatGPT",
};

export const TASK_ROWS: ReadonlyArray<{ purpose: LlmPurpose; label: string }> =
  [
    { purpose: "scoring", label: "Scoring" },
    { purpose: "tailoring", label: "Resume tailoring" },
    { purpose: "projectSelection", label: "Project selection" },
  ];

const LEGACY_MODEL_KEY: Record<
  LlmPurpose,
  "modelScorer" | "modelTailoring" | "modelProjectSelection"
> = {
  scoring: "modelScorer",
  tailoring: "modelTailoring",
  projectSelection: "modelProjectSelection",
};

export function normalizeProvider(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/-/g, "_");
}

export function isSubscriptionProvider(
  value: string | null | undefined,
): value is SubscriptionProviderId {
  const normalized = normalizeProvider(value);
  return normalized === "claude_cli" || normalized === "codex";
}

/** Overrides that still pin a provider; provider-less ones carried a model
 * for the old default provider and are dropped, as the main form does. */
function keepPinnedOverrides(
  overrides: LlmPurposeOverrides,
): LlmPurposeOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, override]) =>
      Boolean(override?.provider),
    ),
  ) as LlmPurposeOverrides;
}

export function getSavedOverrides(
  settings: AppSettings | undefined,
): LlmPurposeOverrides {
  return settings?.llmPurposeOverrides?.override ?? {};
}

export function getDefaultProvider(settings: AppSettings | undefined): string {
  return normalizeProvider(settings?.llmProvider?.value);
}

export function getTaskChoice(
  overrides: LlmPurposeOverrides,
  purpose: LlmPurpose,
): string {
  const provider = overrides[purpose]?.provider;
  return provider ? normalizeProvider(provider) : INHERIT_CHOICE;
}

/** Switch the provider used by every task without its own override. */
export function buildDefaultProviderPatch(
  provider: SubscriptionProviderId,
  overrides: LlmPurposeOverrides,
): Partial<UpdateSettingsInput> {
  const pinned = keepPinnedOverrides(overrides);
  const droppedAny =
    Object.keys(pinned).length !== Object.keys(overrides).length;
  return {
    llmProvider: provider,
    // Subscriptions take no base URL; a leftover API one would be blanked by
    // the settings form on every load and keep the section "Unsaved".
    llmBaseUrl: null,
    model: null,
    modelScorer: null,
    modelTailoring: null,
    modelProjectSelection: null,
    ...(droppedAny ? { llmPurposeOverrides: pinned } : {}),
  };
}

/** Point one task at a subscription (or back to the default provider). Only
 * provider and an optional model are sent: never a base URL or API key. */
export function buildTaskPatch(
  purpose: LlmPurpose,
  choice: TaskChoice,
  overrides: LlmPurposeOverrides,
): Partial<UpdateSettingsInput> {
  const { [purpose]: _previous, ...others } = keepPinnedOverrides(overrides);
  const next: LlmPurposeOverrides =
    choice === INHERIT_CHOICE
      ? others
      : {
          ...others,
          [purpose]: {
            provider: choice,
            ...(purpose === "scoring" && choice === "claude_cli"
              ? { model: DEFAULT_CLAUDE_CLI_SCORING_MODEL }
              : {}),
          },
        };
  return { llmPurposeOverrides: next, [LEGACY_MODEL_KEY[purpose]]: null };
}

export function usesClaudeSubscription(
  settings: AppSettings | undefined,
): boolean {
  if (getDefaultProvider(settings) === "claude_cli") return true;
  return Object.values(getSavedOverrides(settings)).some(
    (override) => normalizeProvider(override?.provider) === "claude_cli",
  );
}
