import type { ApplyClient, ClaudeKeyStatus } from "../../src/lib/api";
import { isLowCredit, parseCredit, spentText, todayIso } from "./claude-spend-line";

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

  const spent = document.getElementById("claude-spent") as HTMLElement;
  const creditForm = document.getElementById("claude-credit-form") as HTMLFormElement;
  const creditInput = document.getElementById("claude-credit") as HTMLInputElement;
  const creditDate = document.getElementById("claude-credit-date") as HTMLInputElement;
  const creditClear = document.getElementById("claude-credit-clear") as HTMLButtonElement;

  /** Your spend and the credit you entered (best effort: the key status above is what matters). */
  async function refreshSpend(api: ApplyClient, note = "") {
    try {
      const [summary, credit] = await Promise.all([api.claudeSummary(), api.claudeCredit()]);
      spent.className = isLowCredit(summary) ? "muted low" : "muted";
      spent.textContent = `${spentText(summary)}${note}`;
      creditInput.value = credit.amountUsd === null ? "" : String(credit.amountUsd);
      // A new credit is usually loaded today: start the date there rather than empty.
      creditDate.value = credit.asOf ?? todayIso();
      creditClear.hidden = credit.amountUsd === null;
    } catch (error) {
      spent.className = "error";
      spent.textContent = message(error);
    }
  }

  async function refresh() {
    const api = client();
    if (!api) return;
    try {
      show(await api.claudeKey());
    } catch (error) {
      fail(error);
    }
    await refreshSpend(api);
  }

  creditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const api = client();
    const amount = parseCredit(creditInput.value);
    if (!api) return;
    if (amount === null || !creditDate.value) {
      spent.className = "error";
      spent.textContent = "Enter the credit you loaded ($0 to $100,000) and the date.";
      return;
    }
    try {
      await api.saveClaudeCredit(amount, creditDate.value);
      await refreshSpend(api, " · saved");
    } catch (error) {
      spent.className = "error";
      spent.textContent = message(error);
    }
  });

  creditClear.addEventListener("click", async () => {
    const api = client();
    if (!api) return;
    try {
      await api.clearClaudeCredit();
      await refreshSpend(api, " · credit cleared");
    } catch (error) {
      spent.className = "error";
      spent.textContent = message(error);
    }
  });

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
