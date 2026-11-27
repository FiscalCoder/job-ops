import {
  getAppStatus,
  getCodexAuthStatus,
  getCurrentAuthUser,
  getLlmModels,
} from "@client/api";
import { getLlmAuthStatus } from "@client/api/llm-auth";
import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectedClaude,
  localAppStatus,
  makeStatus,
  signedInUser,
} from "../subscription-logins/subscription-test-fixtures";
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
  getAppStatus: vi.fn(),
  getCurrentAuthUser: vi.fn(),
}));

vi.mock("@client/api/llm-auth", () => ({
  getLlmAuthStatus: vi.fn(),
}));

// jsdom has no measured list viewport; keep real dropdown behavior and render its small option set.
vi.mock("@/components/ui/virtualized-listbox", () => ({
  useVirtualizedListbox: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 40,
        size: 40,
        end: (index + 1) * 40,
        lane: 0,
      })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

const textField = {
  value: "",
  onChange: vi.fn(),
};

describe("LlmModelConfiguration", () => {
  beforeEach(() => {
    vi.mocked(getLlmModels).mockReset().mockResolvedValue([]);
    vi.mocked(getAppStatus).mockResolvedValue(localAppStatus);
    vi.mocked(getCurrentAuthUser).mockResolvedValue(signedInUser);
    vi.mocked(getLlmAuthStatus).mockResolvedValue(
      makeStatus({ claude: connectedClaude }),
    );
    textField.onChange.mockClear();
  });

  describe("subscription providers", () => {
    const renderWith = (
      mode: "compact" | "settings",
      selectedProvider: "claude_cli" | "codex",
    ) =>
      renderWithQueryClient(
        <LlmModelConfiguration
          mode={mode}
          disabled={false}
          selectedProvider={selectedProvider}
          provider={textField}
          baseUrl={textField}
          apiKey={textField}
          model={textField}
        />,
      );

    it("shows a Claude status line linking to Subscription logins in settings", async () => {
      renderWith("settings", "claude_cli");
      const hint = await screen.findByTestId("subscription-hint-claude");
      expect(
        await within(hint).findByText(/^Connected · expires/),
      ).toBeInTheDocument();
      expect(
        within(hint).getByRole("link", {
          name: /manage in subscription logins/i,
        }),
      ).toHaveAttribute("href", "/settings#model");
      expect(
        screen.queryByText("Claude CLI on this machine"),
      ).not.toBeInTheDocument();
    });

    it("renders the Claude login card inline during onboarding", async () => {
      renderWith("compact", "claude_cli");
      expect(
        await screen.findByTestId("claude-subscription-card"),
      ).toBeInTheDocument();
    });

    it("does not mount a second Codex login UI in settings", async () => {
      renderWith("settings", "codex");
      expect(
        await screen.findByTestId("subscription-hint-codex"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Codex Sign-In")).not.toBeInTheDocument();
      expect(getCodexAuthStatus).not.toHaveBeenCalled();
    });
  });

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
    expect(
      screen.queryByRole("button", { name: "Refresh models" }),
    ).not.toBeInTheDocument();
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
  it("refreshes discovered models without changing the selected model or connection", async () => {
    vi.mocked(getLlmModels)
      .mockResolvedValueOnce(["old-model"])
      .mockResolvedValueOnce(["new-model"]);
    const onChange = vi.fn();
    render(
      <LlmModelConfiguration
        mode="settings"
        disabled={false}
        selectedProvider="ollama"
        provider={textField}
        baseUrl={{ ...textField, value: "http://localhost:11434" }}
        apiKey={textField}
        model={{ value: "old-model", onChange }}
      />,
    );
    const refresh = await screen.findByRole("button", {
      name: "Refresh models",
    });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await waitFor(() => expect(getLlmModels).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getLlmModels).mock.calls[1]).toEqual(
      vi.mocked(getLlmModels).mock.calls[0],
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "old-model" })).toHaveTextContent(
      "old-model",
    );
    fireEvent.click(screen.getByRole("button", { name: "old-model" }));
    expect(
      await screen.findByRole("option", { name: "new-model" }),
    ).toBeInTheDocument();
  });

  it("retries a failed discovery and prevents repeated clicks while loading", async () => {
    let complete!: (models: string[]) => void;
    vi.mocked(getLlmModels)
      .mockRejectedValueOnce(new Error("Ollama is offline"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
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
    expect(await screen.findByText("Ollama is offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(
      screen.getByRole("button", { name: "Refreshing models..." }),
    ).toBeDisabled();
    await act(async () => complete(["recovered-model"]));
    expect(screen.queryByText("Ollama is offline")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toBeEnabled();
    expect(getLlmModels).toHaveBeenCalledTimes(2);
  });

  it("requires credentials before allowing a model refresh", async () => {
    const props = {
      mode: "compact" as const,
      disabled: false,
      selectedProvider: "openai" as const,
      provider: textField,
      baseUrl: textField,
      apiKey: textField,
      model: textField,
    };
    render(<LlmModelConfiguration {...props} />);
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toBeDisabled();
    expect(getLlmModels).not.toHaveBeenCalled();
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
