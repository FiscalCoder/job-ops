import { createAppSettings } from "@shared/testing/factories";
import type { AppSettings } from "@shared/types";
import { describe, expect, it } from "vitest";
import { buildAiChain, describeProvider } from "./ai-routing";
import {
  connectedClaude,
  connectedCodex,
  makeStatus,
} from "./subscription-test-fixtures";

function resolved<T>(value: T) {
  return { value, default: value, override: value };
}

/** The setup on the live server: Claude primary, DeepSeek fallback. */
function claudeWithDeepSeek(overrides: Partial<AppSettings> = {}): AppSettings {
  return createAppSettings({
    llmProvider: resolved("claude_cli"),
    model: resolved("claude-sonnet-5"),
    modelScorer: { value: "claude-haiku-5-5", override: null },
    modelTailoring: { value: "claude-sonnet-5", override: null },
    modelProjectSelection: { value: "claude-sonnet-5", override: null },
    subscriptionFallback: resolved(true),
    llmFallbackEnabled: resolved(true),
    llmFallbackProvider: resolved("openai_compatible"),
    llmFallbackBaseUrl: resolved("https://api.deepseek.com"),
    llmFallbackModel: resolved("deepseek-flash"),
    llmFallbackApiKeyHint: "sk-4",
    llmPurposeOverrides: resolved({}),
    ...overrides,
  });
}

describe("describeProvider", () => {
  it.each([
    ["claude_cli", null, "Claude subscription"],
    ["codex", null, "ChatGPT subscription"],
    ["openai_compatible", "https://api.deepseek.com", "DeepSeek"],
    ["openai_compatible", "https://api.groq.com/openai/v1", "Groq"],
    [
      "openai_compatible",
      "https://llm.example.test/v1",
      "OpenAI-compatible API",
    ],
    ["openrouter", null, "OpenRouter"],
    ["", null, "Not set"],
  ])("names %s (%s) as %s", (provider, baseUrl, label) => {
    expect(describeProvider(provider, baseUrl)).toBe(label);
  });
});

describe("buildAiChain", () => {
  it("lists primary, backup, fallback and last resort in order", () => {
    const steps = buildAiChain(
      claudeWithDeepSeek(),
      makeStatus({ claude: connectedClaude }),
    );
    expect(steps.map((step) => [step.rank, step.role, step.title])).toEqual([
      [1, "Primary", "Claude subscription"],
      [2, "Backup subscription", "ChatGPT subscription"],
      [3, "Fallback API", "DeepSeek"],
      [4, "Last resort", "Wait and retry"],
    ]);
  });

  it("shows models per task and the login state of the primary", () => {
    const [primary] = buildAiChain(
      claudeWithDeepSeek(),
      makeStatus({ claude: connectedClaude }),
    );
    expect(primary?.details).toEqual([
      "Scoring: claude-haiku-5-5",
      "Resume tailoring: claude-sonnet-5",
      "Project selection: claude-sonnet-5",
    ]);
    expect(primary?.badge.tone).toBe("ok");
    expect(primary?.badge.label).toMatch(/^Connected · until /);
  });

  it("flags a missing primary login and an unconnected backup", () => {
    const [primary, backup] = buildAiChain(claudeWithDeepSeek(), makeStatus());
    expect(primary?.badge).toEqual({ label: "Not connected", tone: "error" });
    expect(backup?.badge.label).toBe("Not connected — skipped");
  });

  it("marks the backup on when the other plan is connected", () => {
    const [, backup] = buildAiChain(
      claudeWithDeepSeek(),
      makeStatus({ claude: connectedClaude, codex: connectedCodex }),
    );
    expect(backup?.badge).toEqual({ label: "On", tone: "ok" });
  });

  it("names a task routed to a different provider", () => {
    const [primary] = buildAiChain(
      claudeWithDeepSeek({
        llmPurposeOverrides: resolved({ tailoring: { provider: "codex" } }),
      }),
      makeStatus({ claude: connectedClaude }),
    );
    expect(primary?.details[1]).toBe(
      "Resume tailoring: claude-sonnet-5 — via ChatGPT subscription",
    );
  });

  it("shows the fallback model, host and key state", () => {
    const fallback = buildAiChain(
      claudeWithDeepSeek(),
      makeStatus({ claude: connectedClaude }),
    )[2];
    expect(fallback?.details[0]).toBe("deepseek-flash · api.deepseek.com");
    expect(fallback?.badge).toEqual({ label: "On · your key", tone: "ok" });
  });

  it("shows an unconfigured fallback as off", () => {
    const fallback = buildAiChain(
      claudeWithDeepSeek({ llmFallbackEnabled: resolved(false) }),
      makeStatus({ claude: connectedClaude }),
    )[2];
    expect(fallback?.title).toBe("None");
    expect(fallback?.badge.label).toBe("Off");
  });

  it("skips the backup subscription step for an API primary", () => {
    const steps = buildAiChain(
      createAppSettings({
        llmProvider: resolved("openai_compatible"),
        llmBaseUrl: resolved("https://api.deepseek.com"),
        llmApiKeyHint: "sk-4",
      }),
      makeStatus(),
    );
    expect(steps.map((step) => step.role)).toEqual([
      "Primary",
      "Fallback API",
      "Last resort",
    ]);
    expect(steps[0]?.title).toBe("DeepSeek");
    expect(steps[0]?.badge.label).toBe("Key saved");
  });
});
