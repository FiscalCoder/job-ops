import * as api from "@client/api";
import * as authApi from "@client/api/llm-auth";
import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import { createAppSettings } from "@shared/testing/factories.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionLoginsPanel } from "./SubscriptionLoginsPanel";
import {
  connectedClaude,
  connectedCodex,
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
  startClaudeLogin: vi.fn(),
  submitClaudeLoginCode: vi.fn(),
  saveClaudeToken: vi.fn(),
  testClaudeConnection: vi.fn(),
  disconnectClaude: vi.fn(),
  startCodexLogin: vi.fn(),
  disconnectCodex: vi.fn(),
}));

const settings = createAppSettings();

function renderPanel() {
  return renderWithQueryClient(<SubscriptionLoginsPanel />);
}

async function claudeCard() {
  return within(await screen.findByTestId("claude-subscription-card"));
}

describe("SubscriptionLoginsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getAppStatus).mockResolvedValue(localAppStatus);
    vi.mocked(api.getCurrentAuthUser).mockResolvedValue(signedInUser);
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    vi.mocked(api.updateSettings).mockResolvedValue(settings);
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(makeStatus());
  });

  it("walks a Claude sign-in from missing to connected", async () => {
    const signInUrl = "https://claude.ai/oauth/authorize?x=1";
    const awaiting = makeStatus({
      claude: {
        login: {
          status: "awaiting_code",
          signInUrl,
          startedAt: "2026-11-27T10:00:00.000Z",
          expiresAt: "2026-11-27T10:10:00.000Z",
          message: null,
        },
      },
    });
    vi.mocked(authApi.startClaudeLogin).mockResolvedValue(awaiting);
    vi.mocked(authApi.submitClaudeLoginCode).mockResolvedValue({
      ...makeStatus({ claude: connectedClaude }),
      verification: { ok: true, message: "Claude subscription works." },
    });

    renderPanel();
    const card = await claudeCard();
    expect(card.getByText("Not connected")).toBeInTheDocument();

    fireEvent.click(card.getByRole("button", { name: "Connect" }));
    const link = await card.findByRole("link", {
      name: /open claude sign-in/i,
    });
    expect(link).toHaveAttribute("href", signInUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.change(card.getByLabelText(/code from anthropic/i), {
      target: { value: "  abc#123  " },
    });
    fireEvent.click(card.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(authApi.submitClaudeLoginCode).toHaveBeenCalledWith("abc#123"),
    );
    expect(await card.findByText("Connected and tested.")).toBeInTheDocument();
    expect(card.getByText(/^Connected · expires/)).toBeInTheDocument();
    expect(card.getByRole("button", { name: "Re-login" })).toBeInTheDocument();
  });

  it("keeps the login but warns when the first test call fails", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({
        claude: {
          login: {
            status: "awaiting_code",
            signInUrl: "https://claude.ai/x",
            startedAt: "2026-11-27T10:00:00.000Z",
            expiresAt: "2026-11-27T10:10:00.000Z",
            message: null,
          },
        },
      }),
    );
    vi.mocked(authApi.submitClaudeLoginCode).mockResolvedValue({
      ...makeStatus({ claude: connectedClaude }),
      verification: { ok: false, message: "Usage limit reached." },
    });

    renderPanel();
    const card = await claudeCard();
    fireEvent.change(await card.findByLabelText(/code from anthropic/i), {
      target: { value: "code" },
    });
    fireEvent.click(card.getByRole("button", { name: "Submit" }));

    expect(await card.findByText("Usage limit reached.")).toBeInTheDocument();
    expect(card.getByText(/^Connected · expires/)).toBeInTheDocument();
  });

  it("shows the server's error when a code is rejected", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({
        claude: {
          login: {
            status: "awaiting_code",
            signInUrl: "https://claude.ai/x",
            startedAt: "2026-11-27T10:00:00.000Z",
            expiresAt: "2026-11-27T10:10:00.000Z",
            message: null,
          },
        },
      }),
    );
    vi.mocked(authApi.submitClaudeLoginCode).mockRejectedValue(
      new Error("Code rejected or expired — start again."),
    );

    renderPanel();
    const card = await claudeCard();
    fireEvent.change(await card.findByLabelText(/code from anthropic/i), {
      target: { value: "bad" },
    });
    fireEvent.click(card.getByRole("button", { name: "Submit" }));

    expect(
      await card.findByText("Code rejected or expired — start again."),
    ).toBeInTheDocument();
  });

  it("offers Re-login for an expired Claude login and Start again for a dead session", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({
        claude: { ...connectedClaude, connected: false, state: "expired" },
      }),
    );
    vi.mocked(authApi.startClaudeLogin).mockRejectedValue(
      new Error("Too many sign-ins in progress, try again shortly"),
    );

    renderPanel();
    const card = await claudeCard();
    expect(card.getByText("Expired")).toBeInTheDocument();
    fireEvent.click(card.getByRole("button", { name: "Re-login" }));
    expect(
      await card.findByText("Too many sign-ins in progress, try again shortly"),
    ).toBeInTheDocument();
  });

  it("saves a pasted setup token without keeping it in the input", async () => {
    vi.mocked(authApi.saveClaudeToken).mockResolvedValue(
      makeStatus({ claude: { ...connectedClaude, source: "pasted" } }),
    );

    renderPanel();
    const card = await claudeCard();
    fireEvent.click(card.getByRole("button", { name: /use a token instead/i }));
    const input = card.getByLabelText(/claude token/i);
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "sk-ant-oat01-secret" } });
    fireEvent.click(card.getByRole("button", { name: "Save token" }));

    await waitFor(() =>
      expect(authApi.saveClaudeToken).toHaveBeenCalledWith(
        "sk-ant-oat01-secret",
      ),
    );
    expect(await card.findByText(/^Pasted token · added /));
    expect(screen.queryByDisplayValue("sk-ant-oat01-secret")).toBeNull();
  });

  it("shows a test cooldown message from the server", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({ claude: connectedClaude }),
    );
    vi.mocked(authApi.testClaudeConnection).mockRejectedValue(
      new Error("Please wait 30 seconds before testing again."),
    );

    renderPanel();
    const card = await claudeCard();
    fireEvent.click(card.getByRole("button", { name: "Test connection" }));
    expect(card.getByRole("button", { name: "Testing..." })).toBeDisabled();
    expect(
      await card.findByText("Please wait 30 seconds before testing again."),
    ).toBeInTheDocument();
  });

  it("asks before disconnecting Claude", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({ claude: connectedClaude }),
    );
    vi.mocked(authApi.disconnectClaude).mockResolvedValue(makeStatus());

    renderPanel();
    const card = await claudeCard();
    fireEvent.click(card.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(authApi.disconnectClaude).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(authApi.disconnectClaude).toHaveBeenCalled());
    expect(await card.findByText("Not connected")).toBeInTheDocument();
  });

  it("shows the ChatGPT device code and the device-code setting hint", async () => {
    vi.mocked(authApi.startCodexLogin).mockResolvedValue(
      makeStatus({
        codex: {
          login: {
            status: "running",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "WXYZ-1234",
            expiresAt: null,
            message: "Enable device code authorization in ChatGPT first.",
          },
        },
      }),
    );

    renderPanel();
    const card = within(await screen.findByTestId("codex-subscription-card"));
    fireEvent.click(card.getByRole("button", { name: "Connect" }));

    expect(await card.findByText("WXYZ-1234")).toBeInTheDocument();
    expect(
      card.getByRole("link", { name: /open chatgpt sign-in/i }),
    ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(card.getByText(/device-code login must be turned on/i));
    expect(authApi.startCodexLogin).toHaveBeenCalledWith({
      forceRestart: false,
    });
  });

  it("shows the fallback toggle only when both subscriptions are connected", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({ claude: connectedClaude }),
    );
    const { unmount } = renderPanel();
    await claudeCard();
    await screen.findByTestId("subscription-task-routing");
    expect(screen.queryByLabelText(/fall back to the other/i)).toBeNull();
    expect(screen.getByLabelText(/claude effort/i)).toBeInTheDocument();
    unmount();

    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({
        claude: connectedClaude,
        codex: connectedCodex,
        fallbackEnabled: true,
      }),
    );
    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: /fall back to the other/i,
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        subscriptionFallback: false,
      }),
    );
  });

  it("shows the server's message when a settings change is refused", async () => {
    vi.mocked(authApi.getLlmAuthStatus).mockResolvedValue(
      makeStatus({ claude: connectedClaude, codex: connectedCodex }),
    );
    vi.mocked(api.updateSettings).mockRejectedValue(
      new Error(
        "Only an admin can change the AI provider for a shared workspace",
      ),
    );

    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: /fall back to the other/i,
    });
    fireEvent.click(toggle);
    expect(
      await screen.findByText(
        "Only an admin can change the AI provider for a shared workspace",
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing in hosted mode", async () => {
    vi.mocked(api.getAppStatus).mockResolvedValue({
      ...localAppStatus,
      appMode: "hosted",
    });
    const { container } = renderPanel();
    await waitFor(() => expect(api.getAppStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(authApi.getLlmAuthStatus).not.toHaveBeenCalled();
  });
});
