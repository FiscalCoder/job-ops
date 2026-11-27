import * as api from "@client/api";
import * as authApi from "@client/api/llm-auth";
import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import { createAppSettings } from "@shared/testing/factories.js";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiRoutingSummary } from "./AiRoutingSummary";
import {
  connectedClaude,
  localAppStatus,
  makeStatus,
  signedInUser,
} from "./subscription-test-fixtures";

vi.mock("@client/api", () => ({
  getAppStatus: vi.fn(),
  getCurrentAuthUser: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@client/api/llm-auth", () => ({
  getLlmAuthStatus: vi.fn(),
}));

function resolved<T>(value: T) {
  return { value, default: value, override: value };
}

const settings = createAppSettings({
  llmProvider: resolved("claude_cli"),
  modelScorer: { value: "claude-haiku-5-5", override: null },
  llmFallbackEnabled: resolved(true),
  llmFallbackProvider: resolved("openai_compatible"),
  llmFallbackBaseUrl: resolved("https://api.deepseek.com"),
  llmFallbackModel: resolved("deepseek-flash"),
  llmFallbackApiKeyHint: "sk-4",
  llmPurposeOverrides: resolved({}),
});

describe("AiRoutingSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getAppStatus).mockResolvedValue(localAppStatus);
    vi.mocked(api.getCurrentAuthUser).mockResolvedValue(signedInUser);
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({ claude: connectedClaude }),
    );
  });

  it("lists the providers in the order they are tried", async () => {
    renderWithQueryClient(<AiRoutingSummary />);
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^1Primary\s*Claude subscription/),
      expect.stringMatching(/^2Backup subscription\s*ChatGPT subscription/),
      expect.stringMatching(/^3Fallback API\s*DeepSeek/),
      expect.stringMatching(/^4Last resort\s*Wait and retry/),
    ]);
    expect(
      await within(items[0] as HTMLElement).findByText(/Connected · until/),
    ).toBeInTheDocument();
    expect(
      within(items[2] as HTMLElement).getByText("On · your key"),
    ).toBeInTheDocument();
  });

  it("scrolls to the section where a step is changed", async () => {
    const target = document.createElement("button");
    target.id = "llmFallbackEnabled";
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    renderWithQueryClient(<AiRoutingSummary />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Change fallback api" }),
    );
    expect(target.scrollIntoView).toHaveBeenCalled();
    target.remove();
  });
});
