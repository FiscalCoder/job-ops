import { normalizeLlmProvider } from "@client/pages/settings/utils";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type { AppSettings } from "@shared/types.js";

/**
 * Fork fix: the Settings page rendered the fallback-provider card but never
 * loaded its saved values into the form nor sent them on save (only
 * onboarding did), so it always showed "off" and edits were lost. These
 * helpers load and save it the same way onboarding does.
 */
type FallbackFields = Pick<
  UpdateSettingsInput,
  | "llmFallbackEnabled"
  | "llmFallbackProvider"
  | "llmFallbackBaseUrl"
  | "llmFallbackModel"
  | "llmFallbackApiKey"
>;

const FALLBACK_KEYS: ReadonlyArray<keyof FallbackFields> = [
  "llmFallbackEnabled",
  "llmFallbackProvider",
  "llmFallbackBaseUrl",
  "llmFallbackModel",
  "llmFallbackApiKey",
];

export const FALLBACK_FORM_DEFAULTS: FallbackFields = {
  llmFallbackEnabled: false,
  llmFallbackProvider: null,
  llmFallbackBaseUrl: "",
  llmFallbackModel: "",
  llmFallbackApiKey: "",
};

/** Saved fallback settings as form values; the key is never loaded back. */
export function mapFallbackToForm(data: AppSettings): FallbackFields {
  return {
    llmFallbackEnabled: data.llmFallbackEnabled?.value ?? false,
    llmFallbackProvider: data.llmFallbackProvider?.value
      ? normalizeLlmProvider(data.llmFallbackProvider.value)
      : null,
    llmFallbackBaseUrl: data.llmFallbackBaseUrl?.value ?? "",
    llmFallbackModel: data.llmFallbackModel?.value ?? "",
    llmFallbackApiKey: "",
  };
}

/**
 * The fallback part of a save, only when a fallback field was edited. A blank
 * key keeps the stored one (omitted), matching the other key fields.
 */
export function buildFallbackPayload(
  data: UpdateSettingsInput,
  dirtyFields: Partial<Record<keyof UpdateSettingsInput, unknown>>,
): Partial<FallbackFields> {
  if (!FALLBACK_KEYS.some((key) => dirtyFields[key])) return {};
  const enabled = data.llmFallbackEnabled === true;
  const provider = (data.llmFallbackProvider ?? "").trim();
  const apiKey = (data.llmFallbackApiKey ?? "").trim();
  return {
    llmFallbackEnabled: enabled,
    llmFallbackProvider:
      enabled && provider ? normalizeLlmProvider(provider) : null,
    llmFallbackBaseUrl: (data.llmFallbackBaseUrl ?? "").trim() || null,
    llmFallbackModel: (data.llmFallbackModel ?? "").trim() || null,
    ...(apiKey ? { llmFallbackApiKey: apiKey } : {}),
  };
}
