import type { RunView } from "../../src/fill/controller";
import {
  MAX_ATTEMPTS,
  type RunEvent,
  type Step,
} from "../../src/fill/supervisor";

/** Renders a supervised run: the current step, your controls, and the timeline. */

type Send = (event: RunEvent) => void;

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

function button(
  label: string,
  onClick: () => void,
  primary = false,
  disabled = false,
) {
  const b = el(
    "button",
    { type: "button", class: primary ? "primary" : undefined },
    label,
  ) as HTMLButtonElement;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

const valueText = (value: Step["value"]) =>
  value === null
    ? ""
    : Array.isArray(value)
      ? value.join(", ")
      : (value as string);

const GATE: Record<string, string> = {
  auto: "auto",
  confirm: "your click",
  protected: "protected",
};

const STATE_LABEL: Record<string, [string, string]> = {
  done: ["ok", "filled"],
  skipped: ["", "skipped"],
  "you-did-it": ["ok", "you"],
};

let countdownTimer: ReturnType<typeof setInterval> | null = null;

function countdown(seconds: number): HTMLElement {
  const node = el("span", { class: "badge warn" }, `${seconds}s`);
  if (countdownTimer) clearInterval(countdownTimer);
  let left = seconds;
  countdownTimer = setInterval(() => {
    left -= 1;
    node.textContent = left > 0 ? `${left}s` : "…";
    if (left <= 0 && countdownTimer) clearInterval(countdownTimer);
  }, 1000);
  return node;
}

function editor(step: Step, send: Send): HTMLElement {
  const input = el("input", {
    "aria-label": `Value for ${step.entry.label}`,
  }) as HTMLInputElement;
  input.value = valueText(step.value);
  // A submit button, so both clicking "Use this" and pressing Enter send the value.
  const use = el(
    "button",
    { type: "submit", class: "primary" },
    "Use this",
  ) as HTMLButtonElement;
  const form = el("form", { class: "row" }, input, use);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send({
      type: "edit",
      value:
        step.entry.type === "multiselect"
          ? text.split(/\s*,\s*/).filter(Boolean)
          : text,
    });
  });
  return form;
}

function currentCard(view: RunView, send: Send): HTMLElement | null {
  const { action, busy } = view;
  if (
    action.kind !== "countdown" &&
    action.kind !== "wait-for-you" &&
    action.kind !== "fill"
  )
    return null;
  const { step } = action;
  const needsValue = step.entry.status === "needs-you" || step.value === null;
  const total = view.state.steps.length;
  const controls: (HTMLElement | null)[] = [];
  // After two failed tries, retrying the same value is pointless: Edit it, do it, or skip.
  const exhausted = (step.attempts ?? 0) >= MAX_ATTEMPTS;
  if (action.kind === "wait-for-you" && !needsValue)
    controls.push(
      button(
        "Approve",
        () => send({ type: "approve" }),
        true,
        busy || exhausted,
      ),
    );
  if (action.kind === "countdown")
    controls.push(
      button(
        "Approve now",
        () => send({ type: "countdown-finished" }),
        true,
        busy,
      ),
    );
  if (step.entry.actionClass === "auto" && action.kind !== "fill")
    controls.push(
      button(
        "Approve remaining auto",
        () => send({ type: "approve-remaining-auto" }),
        false,
        busy,
      ),
    );
  controls.push(
    button("I'll do it", () => send({ type: "i-did-it" }), false, busy),
    button("Skip", () => send({ type: "skip" }), false, busy),
  );
  return el(
    "div",
    { class: "step-card" },
    el(
      "div",
      { class: "row" },
      el("strong", {}, `${step.seq}/${total} · ${step.entry.label}`),
      action.kind === "countdown"
        ? countdown(action.seconds)
        : el(
            "span",
            {
              class: `badge ${step.entry.actionClass === "protected" ? "warn" : ""}`,
            },
            action.kind === "fill"
              ? "filling…"
              : (GATE[step.entry.actionClass] ?? ""),
          ),
    ),
    needsValue
      ? el("p", { class: "muted" }, step.note ?? "No answer yet")
      : el(
          "div",
          {},
          el("div", { class: "value" }, valueText(step.value)),
          el("div", { class: "muted" }, step.entry.source),
        ),
    step.note && !needsValue ? el("p", { class: "error" }, step.note) : null,
    action.kind === "fill" ? null : editor(step, send),
    el("div", { class: "controls" }, ...controls),
  );
}

export function renderRun(
  box: HTMLElement,
  view: RunView,
  send: Send,
  onClose: () => void,
): void {
  const { state, action } = view;
  const finished = state.steps.filter((s) => STATE_LABEL[s.state]);
  const header = el(
    "div",
    { class: "row" },
    el("strong", {}, `${view.job.title} · ${view.job.employer}`),
    action.kind === "finished"
      ? button("Close", onClose)
      : el(
          "div",
          { class: "controls" },
          state.paused
            ? button("Resume", () => send({ type: "resume" }))
            : button("Pause", () => send({ type: "pause" })),
          button("Abort", () => send({ type: "abort" })),
        ),
  );

  let body: HTMLElement | null = currentCard(view, send);
  if (action.kind === "paused")
    body = el(
      "p",
      { class: "muted" },
      "Paused. Nothing happens on the page until you resume.",
    );
  if (action.kind === "review")
    body = el(
      "div",
      { class: "step-card" },
      el(
        "strong",
        {},
        "Review the form on the page, then click Submit yourself.",
      ),
      el(
        "p",
        { class: "muted" },
        "Apply Copilot never submits. It notices the confirmation page and marks the job applied.",
      ),
      el(
        "div",
        { class: "controls" },
        button("I submitted it", () => send({ type: "submitted" }), true),
      ),
    );
  if (action.kind === "finished")
    body = el(
      "p",
      { class: state.outcome === "submitted" ? "ok" : "muted" },
      view.notice ?? (state.outcome === "submitted" ? "Applied." : "Stopped."),
    );

  const parts: (HTMLElement | null)[] = [
    header,
    view.notice && action.kind !== "finished"
      ? el("p", { class: "error" }, view.notice)
      : null,
    ...view.problems.map((p) =>
      el("p", { class: "error" }, `On the page: ${p}`),
    ),
    body,
    finished.length
      ? el(
          "details",
          { open: "" },
          el("summary", {}, `Timeline (${finished.length})`),
          el(
            "ul",
            { class: "timeline" },
            ...finished.map((s) => {
              const [tone, label] = STATE_LABEL[s.state] ?? ["", s.state];
              return el(
                "li",
                {},
                el("span", { class: `badge ${tone}` }, label),
                ` ${s.entry.label}`,
                s.decidedBy === "you"
                  ? el("span", { class: "muted" }, " · by you")
                  : null,
              );
            }),
          ),
        )
      : null,
  ];
  box.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
}
