import type { LlmAuthStatus } from "@client/api/llm-auth";
import type { AppSettings, LlmPurpose } from "@shared/types";
import type { StateBadgeView } from "./status-helpers";
import { formatDate } from "./status-helpers";
import {
  getSavedOverrides,
  isSubscriptionProvider,
  normalizeProvider,
  SUBSCRIPTION_PROVIDER_LABELS,
  type SubscriptionProviderId,
} from "./task-routing";

/**
 * Fork: the order Job Ops tries AI providers in, worked out from the SAVED
 * settings and login status, so the Settings page can show it plainly.
 * Mirrors the server: primary → user's other subscription (subscription
 * primaries only) → API fallback (on a usage/rate limit) → leave unscored.
 */
export type ChainTarget =
  | "subscription-logins"
  | "llmProvider"
  | "llmFallbackEnabled";

export interface ChainStep {
  rank: number;
  role: string;
  title: string;
  details: string[];
  badge: StateBadgeView;
  target: ChainTarget | null;
}

const API_PROVIDER_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  gemini: "Gemini API",
  gemini_cli: "Gemini CLI",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
  openai_compatible: "OpenAI-compatible API",
};

const HOST_LABELS: ReadonlyArray<[string, string]> = [
  ["deepseek.com", "DeepSeek"],
  ["openrouter.ai", "OpenRouter"],
  ["generativelanguage.googleapis.com", "Gemini API"],
  ["api.openai.com", "OpenAI API"],
  ["api.anthropic.com", "Anthropic API"],
  ["groq.com", "Groq"],
  ["cerebras.ai", "Cerebras"],
  ["mistral.ai", "Mistral"],
  ["together.xyz", "Together AI"],
];

const TASK_LABELS: Record<LlmPurpose, string> = {
  scoring: "Scoring",
  tailoring: "Resume tailoring",
  projectSelection: "Project selection",
};

function hostOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl?.trim()) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A name a person recognises: "DeepSeek", not "openai_compatible". */
export function describeProvider(
  provider: string | null | undefined,
  baseUrl?: string | null,
): string {
  const normalized = normalizeProvider(provider);
  if (isSubscriptionProvider(normalized)) {
    return `${SUBSCRIPTION_PROVIDER_LABELS[normalized]} subscription`;
  }
  const host = hostOf(baseUrl);
  const known = host
    ? HOST_LABELS.find(
        ([suffix]) => host === suffix || host.endsWith(`.${suffix}`),
      )
    : undefined;
  if (known) return known[1];
  return API_PROVIDER_LABELS[normalized] ?? (normalized || "Not set");
}

function subscriptionBadge(
  provider: SubscriptionProviderId,
  auth: LlmAuthStatus | undefined,
): StateBadgeView {
  if (!auth) return { label: "Checking…", tone: "idle" };
  if (provider === "claude_cli") {
    const { claude } = auth;
    if (claude.state === "expired")
      return { label: "Login expired", tone: "error" };
    if (!claude.connected) return { label: "Not connected", tone: "error" };
    const until = formatDate(claude.expiresAt);
    if (claude.state === "expiring") {
      return { label: `Expires ${until ?? "soon"}`, tone: "warn" };
    }
    return {
      label: until ? `Connected · until ${until}` : "Connected",
      tone: "ok",
    };
  }
  return auth.codex.connected
    ? { label: "Connected", tone: "ok" }
    : { label: "Not connected", tone: "error" };
}

function taskLines(settings: AppSettings, defaultProvider: string): string[] {
  const overrides = getSavedOverrides(settings);
  const modelFor: Record<LlmPurpose, string> = {
    scoring: settings.modelScorer?.value ?? "",
    tailoring: settings.modelTailoring?.value ?? "",
    projectSelection: settings.modelProjectSelection?.value ?? "",
  };
  return (Object.keys(TASK_LABELS) as LlmPurpose[]).map((purpose) => {
    const override = overrides[purpose];
    const provider = normalizeProvider(override?.provider) || defaultProvider;
    const model =
      override?.model?.trim() || modelFor[purpose] || "default model";
    const via =
      provider === defaultProvider
        ? ""
        : ` — via ${describeProvider(provider, override?.baseUrl)}`;
    return `${TASK_LABELS[purpose]}: ${model}${via}`;
  });
}

function primaryStep(
  settings: AppSettings,
  auth: LlmAuthStatus | undefined,
): ChainStep {
  const provider = normalizeProvider(settings.llmProvider?.value);
  const isSubscription = isSubscriptionProvider(provider);
  const badge: StateBadgeView = isSubscription
    ? subscriptionBadge(provider, auth)
    : settings.llmApiKeyHint
      ? { label: "Key saved", tone: "ok" }
      : { label: "No key saved", tone: "warn" };
  return {
    rank: 1,
    role: "Primary",
    title: describeProvider(provider, settings.llmBaseUrl?.value),
    details: taskLines(settings, provider),
    badge,
    target: isSubscription ? "subscription-logins" : "llmProvider",
  };
}

function backupStep(
  settings: AppSettings,
  auth: LlmAuthStatus | undefined,
): ChainStep | null {
  const provider = normalizeProvider(settings.llmProvider?.value);
  if (!isSubscriptionProvider(provider)) return null;
  const other: SubscriptionProviderId =
    provider === "claude_cli" ? "codex" : "claude_cli";
  const enabled = settings.subscriptionFallback?.value ?? true;
  const connected = subscriptionBadge(other, auth);
  const badge: StateBadgeView = !enabled
    ? { label: "Turned off", tone: "idle" }
    : connected.tone === "ok" || connected.tone === "warn"
      ? { label: "On", tone: "ok" }
      : { label: "Not connected — skipped", tone: "idle" };
  return {
    rank: 0,
    role: "Backup subscription",
    title: describeProvider(other),
    details: [
      "Used when your primary plan is out of usage or its login fails.",
    ],
    badge,
    target: "subscription-logins",
  };
}

function fallbackStep(settings: AppSettings): ChainStep {
  const enabled = settings.llmFallbackEnabled?.value ?? false;
  const provider = settings.llmFallbackProvider?.value ?? "";
  const baseUrl = settings.llmFallbackBaseUrl?.value ?? "";
  const model = settings.llmFallbackModel?.value?.trim();
  const configured = enabled && Boolean(provider);
  const host = hostOf(baseUrl);
  const badge: StateBadgeView = !configured
    ? { label: "Off", tone: "idle" }
    : settings.llmFallbackApiKeyHint
      ? { label: "On · your key", tone: "ok" }
      : { label: "On · no key saved", tone: "warn" };
  return {
    rank: 0,
    role: "Fallback API",
    title: configured ? describeProvider(provider, baseUrl) : "None",
    details: configured
      ? [
          [model || "provider's default model", host]
            .filter(Boolean)
            .join(" · "),
          "Only when the steps above are out of usage. Billed to that API account — if it has no balance, the job just waits (next step).",
        ]
      : [
          "Optional: an API with your own key, used only when the steps above are out of usage.",
        ],
    badge,
    target: "llmFallbackEnabled",
  };
}

function lastResortStep(settings: AppSettings): ChainStep {
  const subscriptionPrimary = isSubscriptionProvider(
    normalizeProvider(settings.llmProvider?.value),
  );
  return {
    rank: 0,
    role: "Last resort",
    title: "Wait and retry",
    details: [
      subscriptionPrimary
        ? "Jobs are kept unscored and re-run automatically shortly after your plan's usage resets (or at the next daily run)."
        : "Jobs are kept unscored and picked up by the next run.",
    ],
    badge: { label: "Automatic", tone: "idle" },
    target: null,
  };
}

/** The full chain, numbered in the order Job Ops tries it. */
export function buildAiChain(
  settings: AppSettings,
  auth: LlmAuthStatus | undefined,
): ChainStep[] {
  const steps = [
    primaryStep(settings, auth),
    backupStep(settings, auth),
    fallbackStep(settings),
    lastResortStep(settings),
  ].filter((step): step is ChainStep => step !== null);
  return steps.map((step, index) => ({ ...step, rank: index + 1 }));
}
