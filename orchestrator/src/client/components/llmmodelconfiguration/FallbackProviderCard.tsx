import * as api from "@client/api";
import { ClaudeCliSetupHint } from "@client/components/ClaudeCliSetupHint";
import { CodexAuthPanel } from "@client/components/CodexAuthPanel";
import { GeminiCliSetupHint } from "@client/components/GeminiCliSetupHint";
import { getDefaultModelForProvider } from "@shared/settings-registry";
import { useEffect, useState } from "react";
import { SettingsInput } from "@/client/pages/settings/components/SettingsInput";
import {
  formatSecretHint,
  getLlmProviderConfig,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  normalizeLlmProvider,
  supportsLlmModelSuggestions,
} from "@/client/pages/settings/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildModelOptions,
  renderKeyHelper,
} from "./llm-model-configuration-helpers";
import ModelField from "./ModelField";

/**
 * Optional second LLM provider used when the primary provider fails with a
 * 429 (quota/rate-limit exhausted). Rendered inside LlmModelConfiguration so
 * it shows up in both onboarding's model step and the Settings LLM section.
 */
export default function FallbackProviderCard({
  enabled,
  provider,
  baseUrl,
  model,
  apiKeyValue,
  apiKeyHint,
  disabled,
  onEnabledChange,
  onProviderChange,
  onBaseUrlChange,
  onModelChange,
  onApiKeyChange,
}: {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyValue: string;
  apiKeyHint: string | null;
  disabled: boolean;
  onEnabledChange: (value: boolean) => void;
  onProviderChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
}) {
  const hasProvider = Boolean(provider);
  const selectedProvider = hasProvider
    ? normalizeLlmProvider(provider)
    : undefined;
  const providerConfig = selectedProvider
    ? getLlmProviderConfig(selectedProvider)
    : null;
  const isCodexProvider = providerConfig?.normalizedProvider === "codex";
  const isGeminiCliProvider =
    providerConfig?.normalizedProvider === "gemini_cli";
  const isClaudeCliProvider =
    providerConfig?.normalizedProvider === "claude_cli";
  const supportsModelSuggestions = selectedProvider
    ? supportsLlmModelSuggestions(selectedProvider)
    : false;
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const providerDefaultModel = selectedProvider
    ? getDefaultModelForProvider(selectedProvider)
    : "";
  const hasSavedKey = Boolean(apiKeyHint);
  const keyHint = apiKeyHint ? formatSecretHint(apiKeyHint) : "Not set";
  const modelOptions = buildModelOptions({
    models: availableModels,
    emptyLabel: `Use ${providerConfig?.label ?? "provider"} default`,
    emptyValue: "",
    fallbackValue: model,
  });

  useEffect(() => {
    if (!enabled || !selectedProvider || !providerConfig) {
      setAvailableModels([]);
      setModelsError(null);
      setIsLoadingModels(false);
      return;
    }

    if (!supportsModelSuggestions) {
      setAvailableModels([]);
      setModelsError(null);
      setIsLoadingModels(false);
      return;
    }

    if (providerConfig.requiresApiKey && !apiKeyValue.trim() && !hasSavedKey) {
      setAvailableModels([]);
      setModelsError(null);
      setIsLoadingModels(false);
      return;
    }

    let cancelled = false;
    setIsLoadingModels(true);
    setModelsError(null);

    void api
      .getLlmModels({
        provider: selectedProvider,
        baseUrl: providerConfig.showBaseUrl
          ? baseUrl.trim() || undefined
          : undefined,
        apiKey: providerConfig.showApiKey
          ? apiKeyValue.trim() || undefined
          : undefined,
      })
      .then((models) => {
        if (cancelled) return;
        setAvailableModels(models);
      })
      .catch((error) => {
        if (cancelled) return;
        setAvailableModels([]);
        setModelsError(
          error instanceof Error ? error.message : "Failed to load models.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoadingModels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    apiKeyValue,
    baseUrl,
    hasSavedKey,
    providerConfig,
    selectedProvider,
    supportsModelSuggestions,
  ]);

  const modelHelper = supportsModelSuggestions
    ? isLoadingModels
      ? "Loading available models..."
      : modelsError
        ? modelsError
        : `Leave blank to use ${providerConfig?.label ?? "the provider"}'s default.`
    : `Type the exact model name — e.g. deepseek-chat for DeepSeek. Leave blank to use ${providerConfig?.label ?? "the provider"}'s default.`;

  return (
    <div className="space-y-4">
      <div className="flex items-start space-x-3">
        <Checkbox
          id="llmFallbackEnabled"
          checked={enabled}
          onCheckedChange={(checked) => onEnabledChange(checked === true)}
          disabled={disabled}
        />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="llmFallbackEnabled"
            className="text-sm font-medium leading-none cursor-pointer"
          >
            Use a fallback provider when the primary is rate-limited
          </label>
          <p className="text-xs text-muted-foreground">
            If the primary provider returns a 429 (quota/rate limit exhausted)
            after retrying, JobOps retries that one call through this provider
            instead. Any other kind of failure is left alone — this is only for
            "out of quota right now."
          </p>
        </div>
      </div>

      {enabled ? (
        <div className="space-y-2 pl-7">
          <label htmlFor="llmFallbackProvider" className="text-sm font-medium">
            Fallback provider
          </label>
          <Select
            value={provider || undefined}
            onValueChange={(nextValue) => {
              onProviderChange(nextValue);
              onBaseUrlChange("");
              onModelChange("");
            }}
            disabled={disabled}
          >
            <SelectTrigger id="llmFallbackProvider" className="h-9">
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectContent>
              {LLM_PROVIDERS.map((providerId) => (
                <SelectItem key={providerId} value={providerId}>
                  {LLM_PROVIDER_LABELS[providerId]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasProvider && isCodexProvider ? (
            <CodexAuthPanel isBusy={disabled} />
          ) : null}
          {hasProvider && isGeminiCliProvider ? <GeminiCliSetupHint /> : null}
          {hasProvider && isClaudeCliProvider ? <ClaudeCliSetupHint /> : null}

          {hasProvider && providerConfig?.showBaseUrl ? (
            <SettingsInput
              label="Base URL"
              inputProps={{
                name: "llmFallbackBaseUrl",
                value: baseUrl,
                onChange: (event) => onBaseUrlChange(event.target.value),
              }}
              placeholder={providerConfig.baseUrlPlaceholder}
              disabled={disabled}
              helper={providerConfig.baseUrlHelper}
              current={baseUrl || providerConfig.baseUrlPlaceholder}
            />
          ) : null}

          {hasProvider && providerConfig?.showApiKey ? (
            <SettingsInput
              label={
                providerConfig.requiresApiKey ? "API key" : "API key (optional)"
              }
              inputProps={{
                name: "llmFallbackApiKey",
                value: apiKeyValue,
                onChange: (event) => onApiKeyChange(event.target.value),
              }}
              type="password"
              placeholder={
                providerConfig.requiresApiKey
                  ? "Paste a new key"
                  : "Optional bearer token"
              }
              disabled={disabled}
              helper={renderKeyHelper(
                providerConfig.keyHelperText,
                providerConfig.keyHelperHref,
                hasSavedKey,
              )}
              current={keyHint}
            />
          ) : null}

          {hasProvider ? (
            <ModelField
              id="llmFallbackModel"
              label="Model"
              value={model}
              onChange={onModelChange}
              supportsModelSuggestions={supportsModelSuggestions}
              options={modelOptions}
              placeholder={providerDefaultModel || "Model name"}
              helper={modelHelper}
              current={model || providerDefaultModel || "-"}
              disabled={disabled || isLoadingModels}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
