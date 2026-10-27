import { fillFocusedField } from "../../src/kit/page-fill";
import type { ApplyClient, KitItem } from "../../src/lib/api";
import { errorText } from "../../src/trace/recorder";

/**
 * "Ask Claude": paste a question the kit or the fill didn't cover; Claude answers from your
 * tailored resume and answers. Shown in the apply kit and below a running fill.
 */

function el(
  tag: string,
  attrs: Record<string, string | undefined> = {},
  ...children: (Node | string | null)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs))
    if (value !== undefined) node.setAttribute(key, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

/** The answer as a row: a click fills the field selected on the page, else copies it. */
export function answerRow(item: KitItem): HTMLElement {
  const said = el("p", { class: "muted" });
  const row = el(
    "button",
    {
      type: "button",
      class: "kit-item",
      title: "Fill the selected field, or copy",
    },
    el("span", { class: "muted" }, item.label),
    el("span", { class: "value" }, item.value),
  );
  row.addEventListener("click", async () => {
    const filled = await fillFocusedField(item.value).catch(
      (error: unknown) => ({ ok: false as const, reason: errorText(error) }),
    );
    if (filled.ok) {
      said.textContent = `Filled into "${filled.field.label || filled.field.name || "the field"}".`;
      return;
    }
    try {
      await navigator.clipboard.writeText(item.value);
      said.textContent = `Copied: paste it into the field (${filled.reason}).`;
    } catch (error) {
      said.textContent = `Couldn't copy: ${errorText(error)}`;
    }
  });
  return el("div", {}, row, said);
}

export function askClaude(
  client: ApplyClient,
  jobId: string,
  itemRow: (item: KitItem) => HTMLElement = answerRow,
): HTMLElement {
  const question = el("textarea", {
    rows: "2",
    placeholder: "Paste the question from the form",
    "aria-label": "Question",
  }) as HTMLTextAreaElement;
  const choices = el("textarea", {
    rows: "3",
    placeholder: "One choice per line (only for dropdowns)",
    "aria-label": "Choices",
  }) as HTMLTextAreaElement;
  const long = el("input", { type: "checkbox" }) as HTMLInputElement;
  const answer = el("div");
  const ask = el(
    "button",
    { type: "button", class: "primary" },
    "Ask Claude",
  ) as HTMLButtonElement;
  ask.addEventListener("click", async () => {
    ask.disabled = true;
    answer.replaceChildren(el("p", { class: "muted" }, "Asking…"));
    try {
      const options = choices.value
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean);
      const reply = await client.kitAnswer(jobId, {
        question: question.value,
        ...(options.length ? { options } : {}),
        long: long.checked,
      });
      answer.replaceChildren(
        el("p", { class: "muted" }, reply.how),
        itemRow({
          key: "claude",
          label: question.value.slice(0, 80),
          value: reply.value,
        }),
      );
    } catch (error) {
      answer.replaceChildren(el("p", { class: "error" }, errorText(error)));
    } finally {
      ask.disabled = false;
    }
  });
  return el(
    "div",
    { class: "kit-group" },
    el("h2", {}, "Ask Claude"),
    question,
    el("details", {}, el("summary", {}, "It's a dropdown"), choices),
    el("label", { class: "inline" }, long, "Long answer (a paragraph)"),
    el("div", { class: "controls" }, ask),
    answer,
  );
}
