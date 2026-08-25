import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LlmModelConfiguration } from "./LlmModelConfiguration";

vi.mock("@client/api", () => ({
  disconnectCodexAuth: vi.fn(),
  getCodexAuthStatus: vi.fn().mockResolvedValue({
    authenticated: false,
    username: null,
    validationMessage:
      "Codex is not authenticated in this container. Run `codex login` and try again.",
    flowStatus: "idle",
    loginInProgress: false,
    verificationUrl: null,
    userCode: null,
    startedAt: null,
    expiresAt: null,
    flowMessage: null,
  }),
  getLlmModels: vi.fn().mockResolvedValue([]),
  startCodexAuth: vi.fn(),
}));

const textField = {
  value: "",
  onChange: vi.fn(),
};

describe("LlmModelConfiguration", () => {
  it("does not render an LLM API key affordance for Codex in compact mode", async () => {
    render(
      <LlmModelConfiguration
        mode="compact"
        disabled={false}
        selectedProvider="codex"
        provider={textField}
        baseUrl={textField}
        apiKey={textField}
        model={textField}
      />,
    );

    expect(screen.getByText("Codex Sign-In")).toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText("No API key is required for this provider."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "find out what model name to use" }),
    ).toHaveAttribute("href", "https://developers.openai.com/codex/models");
  });

  it("asks Ollama users to choose an installed model instead of using a default", async () => {
    render(
      <LlmModelConfiguration
        mode="compact"
        disabled={false}
        selectedProvider="ollama"
        provider={textField}
        baseUrl={textField}
        apiKey={textField}
        model={textField}
      />,
    );

    expect(screen.getByLabelText("API key (optional)")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText(
          "No Ollama models were returned. Pull a model in Ollama, then choose it here before continuing.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Current:")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  describe("fallback provider", () => {
    const fallbackBase = {
      enabled: false,
      provider: "",
      baseUrl: "",
      model: "",
      apiKeyValue: "",
      apiKeyHint: null,
      onEnabledChange: vi.fn(),
      onProviderChange: vi.fn(),
      onBaseUrlChange: vi.fn(),
      onModelChange: vi.fn(),
      onApiKeyChange: vi.fn(),
    };

    it("does not render anything when no fallback binding is passed", () => {
      render(
        <LlmModelConfiguration
          mode="compact"
          disabled={false}
          selectedProvider="openrouter"
          provider={textField}
          baseUrl={textField}
          apiKey={textField}
          model={textField}
        />,
      );

      expect(screen.queryByText(/fallback provider/i)).not.toBeInTheDocument();
    });

    it("shows the enable checkbox but hides provider fields until enabled, in both compact and settings mode", () => {
      for (const mode of ["compact", "settings"] as const) {
        const { unmount } = render(
          <LlmModelConfiguration
            mode={mode}
            disabled={false}
            selectedProvider="openrouter"
            provider={textField}
            baseUrl={textField}
            apiKey={textField}
            model={textField}
            fallback={fallbackBase}
          />,
        );

        expect(
          screen.getByText(
            "Use a fallback provider when the primary is rate-limited",
          ),
        ).toBeInTheDocument();
        expect(screen.queryByText("Fallback provider")).not.toBeInTheDocument();

        unmount();
      }
    });

    it("calls onEnabledChange when the checkbox is toggled", () => {
      const onEnabledChange = vi.fn();
      render(
        <LlmModelConfiguration
          mode="compact"
          disabled={false}
          selectedProvider="openrouter"
          provider={textField}
          baseUrl={textField}
          apiKey={textField}
          model={textField}
          fallback={{ ...fallbackBase, onEnabledChange }}
        />,
      );

      fireEvent.click(screen.getByRole("checkbox"));

      expect(onEnabledChange).toHaveBeenCalledWith(true);
    });

    it("reveals the provider select once enabled", () => {
      render(
        <LlmModelConfiguration
          mode="compact"
          disabled={false}
          selectedProvider="openrouter"
          provider={textField}
          baseUrl={textField}
          apiKey={textField}
          model={textField}
          fallback={{ ...fallbackBase, enabled: true }}
        />,
      );

      expect(screen.getByText("Fallback provider")).toBeInTheDocument();
    });
  });
});
