import type { ApplyClient, ClaudeKeyStatus } from "../../src/lib/api";

/**
 * "Your Claude key": Claude answers new questions with your own Anthropic key. Without one,
 * forms are filled from your answers and resume only (the server's key is its admin's).
 */

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function statusText(status: ClaudeKeyStatus): string {
  if (status.source === "yours") return `Claude uses your key (${status.hint}).`;
  if (status.source === "server")
    return "Claude uses this server's key (you run it). Add your own to use yours instead.";
  return "Claude is off for you: forms are filled from your answers and resume. Add your Anthropic API key to have Claude answer new questions.";
}

export function setUpClaudeSettings(client: () => ApplyClient | null): {
  refresh: () => Promise<void>;
} {
  const status = document.getElementById("claude-status") as HTMLElement;
  const form = document.getElementById("claude-form") as HTMLFormElement;
  const input = document.getElementById("claude-key") as HTMLInputElement;
  const remove = document.getElementById("claude-remove") as HTMLButtonElement;

  const show = (current: ClaudeKeyStatus) => {
    status.className = current.source ? "muted" : "error";
    status.textContent = statusText(current);
    remove.hidden = current.source !== "yours";
  };
  const fail = (error: unknown) => {
    status.className = "error";
    status.textContent = message(error);
  };

  async function refresh() {
    const api = client();
    if (!api) return;
    try {
      show(await api.claudeKey());
    } catch (error) {
      fail(error);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const api = client();
    const key = input.value.trim();
    if (!api || !key) return;
    try {
      show(await api.saveClaudeKey(key));
      input.value = "";
    } catch (error) {
      fail(error);
    }
  });

  remove.addEventListener("click", async () => {
    const api = client();
    if (!api || !window.confirm("Remove your Claude key?")) return;
    try {
      show(await api.removeClaudeKey());
    } catch (error) {
      fail(error);
    }
  });

  return { refresh };
}
