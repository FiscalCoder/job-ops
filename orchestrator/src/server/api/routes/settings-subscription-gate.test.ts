import type { UpdateSettingsInput } from "@shared/settings-schema";
import { describe, expect, it } from "vitest";
import {
  checkNonAdminSubscriptionUpdate,
  isNonAdminSubscriptionSettingsUpdate,
  type NonAdminLlmGateState,
} from "./settings-subscription-gate";

const SEARCH_KEYS = new Set<keyof UpdateSettingsInput>(["searchTerms"]);

function check(input: Record<string, unknown>): boolean {
  return isNonAdminSubscriptionSettingsUpdate(
    input as UpdateSettingsInput,
    SEARCH_KEYS,
  );
}

describe("isNonAdminSubscriptionSettingsUpdate", () => {
  it.each([
    [{ llmProvider: "claude_cli" }],
    [{ llmProvider: "codex", model: "gpt-5.4-mini" }],
    [{ llmProvider: "claude_cli", modelScorer: "claude-haiku-5-5" }],
    [{ modelTailoring: "claude-sonnet-5-5", modelProjectSelection: "x" }],
    [
      {
        llmPurposeOverrides: { scoring: { provider: "codex", model: "gpt-5" } },
      },
    ],
    [
      {
        llmPurposeOverrides: {
          scoring: { provider: "claude_cli" },
          tailoring: { provider: "codex", baseUrl: "" },
        },
      },
    ],
    [{ claudeCliEffort: "low" }],
    [{ subscriptionFallback: false }],
    [{ searchTerms: ["x"], llmProvider: "claude_cli" }],
  ])("allows subscription-only changes %#", (input) => {
    expect(check(input)).toBe(true);
  });

  it.each([
    [{ llmProvider: "openai" }],
    [{ llmProvider: null }],
    [{ llmProvider: "claude_cli", llmBaseUrl: "https://evil.test" }],
    [{ llmProvider: "codex", llmApiKey: "sk-x" }],
    [{ llmPurposeOverrides: { scoring: { provider: "openrouter" } } }],
    [{ llmPurposeOverrides: { scoring: { model: "x" } } }],
    [
      {
        llmPurposeOverrides: {
          scoring: { provider: "codex", baseUrl: "https://evil.test" },
        },
      },
    ],
    [{ llmPurposeOverrides: null }],
    [{ llmPurposeApiKeys: { scoring: "sk" } }],
    [{ rxresumeApiKey: "x" }],
    [{}],
  ])("rejects anything else %#", (input) => {
    expect(check(input)).toBe(false);
  });
});

describe("checkNonAdminSubscriptionUpdate", () => {
  const SOLE_ON_CLI: NonAdminLlmGateState = {
    memberCount: 1,
    currentProvider: "claude_cli",
    storedOverrides: null,
  };
  const SOLE_ON_API: NonAdminLlmGateState = {
    ...SOLE_ON_CLI,
    currentProvider: "openrouter",
  };

  function verdict(
    input: Record<string, unknown>,
    state: NonAdminLlmGateState,
  ): string | null {
    return checkNonAdminSubscriptionUpdate(input as UpdateSettingsInput, state);
  }

  it("lets the sole member of a workspace switch to a subscription", () => {
    expect(verdict({ llmProvider: "codex" }, SOLE_ON_API)).toBeNull();
    expect(verdict({ subscriptionFallback: false }, SOLE_ON_API)).toBeNull();
  });

  it.each([
    [{ llmProvider: "claude_cli" }],
    [{ subscriptionFallback: true }],
    [{ modelScorer: "claude-haiku-5-5" }],
  ])("refuses any LLM change in a shared workspace %#", (input) => {
    expect(verdict(input, { ...SOLE_ON_CLI, memberCount: 2 })).toBe(
      "Only an admin can change the AI provider for a shared workspace",
    );
  });

  it.each([
    [{ model: "gpt-5" }],
    [{ modelScorer: "x" }],
    [{ modelTailoring: "x" }],
    [{ modelProjectSelection: "x" }],
  ])("refuses model changes that would apply to an API provider %#", (input) => {
    expect(verdict(input, SOLE_ON_API)).toMatch(/subscription/i);
  });

  it.each([
    // Route one task to the user's own subscription while the default stays an API.
    [{ llmPurposeOverrides: { scoring: { provider: "codex" } } }],
    [
      {
        llmPurposeOverrides: {
          scoring: { provider: "claude_cli", model: "claude-haiku-5-5" },
        },
        modelScorer: null,
      },
    ],
    // Resetting a model to its default never names a new model.
    [{ model: null, modelScorer: null, modelTailoring: null }],
    // Effort only affects the Claude subscription.
    [{ claudeCliEffort: "high" }],
  ])("allows subscription routing and resets while the default is an API %#", (input) => {
    expect(verdict(input, SOLE_ON_API)).toBeNull();
  });

  it.each([
    [{ model: "gpt-5", llmProvider: "codex" }],
    [{ modelScorer: "claude-haiku-5-5" }],
    [{ claudeCliEffort: "high" }],
  ])("allows model changes that land on a subscription provider %#", (input) => {
    const state = (input as { llmProvider?: string }).llmProvider
      ? SOLE_ON_API
      : SOLE_ON_CLI;
    expect(verdict(input, state)).toBeNull();
  });

  it("refuses model changes while admin-set API overrides are stored", () => {
    const state: NonAdminLlmGateState = {
      ...SOLE_ON_CLI,
      storedOverrides: { scoring: { provider: "openrouter", model: "x" } },
    };
    expect(verdict({ modelScorer: "y" }, state)).toMatch(/admin/i);
  });

  it("allows clearing the user's own subscription overrides", () => {
    const state: NonAdminLlmGateState = {
      ...SOLE_ON_API,
      storedOverrides: { scoring: { provider: "claude_cli" } },
    };
    expect(verdict({ llmPurposeOverrides: {} }, state)).toBeNull();
  });

  it("refuses clearing overrides when an admin set API overrides", () => {
    const state: NonAdminLlmGateState = {
      ...SOLE_ON_CLI,
      storedOverrides: { tailoring: { provider: "openai", model: "gpt-5" } },
    };
    expect(verdict({ llmPurposeOverrides: {} }, state)).toMatch(/admin/i);
  });

  it("refuses overrides that would wipe admin-set API overrides", () => {
    const state: NonAdminLlmGateState = {
      ...SOLE_ON_CLI,
      storedOverrides: {
        tailoring: { provider: "openai", model: "gpt-5" },
      },
    };
    expect(
      verdict(
        { llmPurposeOverrides: { scoring: { provider: "codex" } } },
        state,
      ),
    ).toMatch(/admin/i);
  });

  it("allows replacing overrides that are all subscription-based", () => {
    const state: NonAdminLlmGateState = {
      ...SOLE_ON_CLI,
      storedOverrides: { tailoring: { provider: "codex" } },
    };
    expect(
      verdict(
        { llmPurposeOverrides: { scoring: { provider: "claude_cli" } } },
        state,
      ),
    ).toBeNull();
  });
});
