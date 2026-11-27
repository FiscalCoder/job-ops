import { createAppSettings } from "@shared/testing/factories.js";
import { describe, expect, it } from "vitest";
import {
  buildDefaultProviderPatch,
  buildTaskPatch,
  getTaskChoice,
  usesClaudeSubscription,
} from "./task-routing";

describe("task routing patches", () => {
  it("routes scoring to Claude with the Haiku default and no URL or key", () => {
    expect(buildTaskPatch("scoring", "claude_cli", {})).toEqual({
      llmPurposeOverrides: {
        scoring: { provider: "claude_cli", model: "claude-haiku-5-5" },
      },
      modelScorer: null,
    });
  });

  it("routes tailoring to ChatGPT without a model so its default applies", () => {
    expect(
      buildTaskPatch("tailoring", "codex", {
        scoring: { provider: "claude_cli", model: "claude-haiku-5-5" },
      }),
    ).toEqual({
      llmPurposeOverrides: {
        scoring: { provider: "claude_cli", model: "claude-haiku-5-5" },
        tailoring: { provider: "codex" },
      },
      modelTailoring: null,
    });
  });

  it("clears a task override and drops provider-less leftovers", () => {
    const patch = buildTaskPatch("scoring", "inherit", {
      scoring: { provider: "codex" },
      projectSelection: { model: "old-model" },
    });
    expect(patch).toEqual({ llmPurposeOverrides: {}, modelScorer: null });
  });

  it("switches the default provider and resets models", () => {
    expect(
      buildDefaultProviderPatch("codex", {
        tailoring: { provider: "claude_cli" },
      }),
    ).toEqual({
      llmProvider: "codex",
      model: null,
      modelScorer: null,
      modelTailoring: null,
      modelProjectSelection: null,
    });
    expect(
      buildDefaultProviderPatch("claude_cli", { scoring: { model: "x" } }),
    ).toMatchObject({ llmPurposeOverrides: {} });
  });

  it("reads the current choice and Claude usage from settings", () => {
    const settings = createAppSettings({
      llmPurposeOverrides: {
        value: { tailoring: { provider: "claude_cli" } },
        default: {},
        override: { tailoring: { provider: "claude_cli" } },
      },
    });
    expect(
      getTaskChoice({ tailoring: { provider: "codex" } }, "tailoring"),
    ).toBe("codex");
    expect(getTaskChoice({}, "scoring")).toBe("inherit");
    expect(usesClaudeSubscription(settings)).toBe(true);
    expect(usesClaudeSubscription(createAppSettings())).toBe(false);
  });
});
