import type { RunView } from "../../src/fill/controller";
import {
  MAX_ATTEMPTS,
  type RunEvent,
  type Step,
} from "../../src/fill/supervisor";

/** Renders a supervised run: the current step, your controls, and the timeline. */

type Send = (event: RunEvent) => void;

/** "Tell agent": Claude's proposal for one field from your instruction. */
export type Tell = (
  entry: Step["entry"],
  instruction: string,
) => Promise<{ value: string | readonly string[]; why: string }>;

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

function editor(step: Step, send: Send, tell?: Tell): HTMLElement {
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
  if (!tell) return form;
  return el("div", { class: "editor" }, form, tellAgent(step, input, tell));
}

/** Say how to answer; Claude's proposal lands in the edit box for you to check and use. */
function tellAgent(
  step: Step,
  target: HTMLInputElement,
  tell: Tell,
): HTMLElement {
  const instruction = el("input", {
    "aria-label": `Tell agent how to answer ${step.entry.label}`,
    placeholder: 'e.g. "use my portfolio site", "say 30 days"',
  }) as HTMLInputElement;
  const ask = el(
    "button",
    { type: "submit" },
    "Tell agent",
  ) as HTMLButtonElement;
  const note = el("p", { class: "muted" });
  const form = el("form", { class: "row" }, instruction, ask);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = instruction.value.trim();
    if (text.length < 2) return;
    ask.disabled = true;
    note.className = "muted";
    note.textContent = "Asking Claude…";
    try {
      const answer = await tell(step.entry, text);
      target.value = valueText(answer.value);
      note.textContent = `Claude: ${answer.why}. Check it above, then "Use this".`;
      target.focus();
    } catch (error) {
      note.className = "error";
      note.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      ask.disabled = false;
    }
  });
  return el(
    "details",
    { class: "tell" },
    el("summary", {}, "Tell agent how to answer"),
    form,
    note,
  );
}

function currentCard(
  view: RunView,
  send: Send,
  tell?: Tell,
): HTMLElement | null {
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
  // Claude can work any field on the page like a person would: with your answer, or (none,
  // or it doesn't fit the choices) picking what fits you from your saved answers.
  if (action.kind !== "fill" && step.entry.type !== "file")
    controls.push(
      button(
        "Let Claude do it",
        () => send({ type: "let-claude" }),
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
              ? step.operate
                ? "Claude is working on it… (Pause stops it)"
                : "filling…"
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
    action.kind === "fill" ? null : editor(step, send, tell),
    el("div", { class: "controls" }, ...controls),
  );
}

/**
 * "Fill from…": every field of this page (or form), grouped under the page's own headings
 * ("Professional Experience (2)"); picking one fills again from there.
 */
/**
 * "Fill from… / only…": one picker for filling again, from a field you choose, or only one
 * section (a job, a degree): each section's group starts with "Only this section".
 */
function fillFromPicker(
  steps: readonly Step[],
  fillFrom: (seq: number) => void,
  fillOnly?: (section: string) => void,
): HTMLElement {
  const picker = el("select", {
    "aria-label": "Fill again from a field, or only a section",
    title:
      "Fill again from the field you pick (the ones before stay as they are), or only one section",
  }) as HTMLSelectElement;
  picker.append(el("option", { value: "" }, fillOnly ? "Fill from… / only…" : "Fill from…"));
  let group: HTMLElement = picker;
  let heading: string | undefined;
  for (const step of steps) {
    if (step.entry.group !== heading) {
      heading = step.entry.group;
      group = heading ? el("optgroup", { label: heading }) : picker;
      if (heading) {
        picker.append(group);
        if (fillOnly)
          group.append(
            el("option", { value: `only:${heading}` }, `▸ Only this section`),
          );
      }
    }
    group.append(
      el(
        "option",
        { value: `from:${step.seq}` },
        `${step.seq}. ${step.entry.label.slice(0, 48)}`,
      ),
    );
  }
  picker.addEventListener("change", () => {
    const [kind, ...rest] = picker.value.split(":");
    const what = rest.join(":");
    if (kind === "only" && what) fillOnly?.(what);
    else if (kind === "from" && Number(what)) fillFrom(Number(what));
  });
  return picker;
}

export function renderRun(
  box: HTMLElement,
  view: RunView,
  send: Send,
  onClose: () => void,
  tell?: Tell,
  /** Page by page: read the page on screen again and fill it. */
  refill?: () => void,
  /** Fill again from the field with this step number. */
  fillFrom?: (seq: number) => void,
  /** Fill only the section with this heading. */
  fillOnly?: (section: string) => void,
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
          view.page && refill && !view.busy
            ? button("Fill this page", refill, true)
            : null,
          fillFrom && !view.busy && state.steps.length
            ? fillFromPicker(state.steps, fillFrom, fillOnly)
            : null,
          button("Abort", () => send({ type: "abort" })),
          // You submitted it yourself, at any point: the run ends and the job is marked applied.
          // (On the last review the card below asks the same.)
          action.kind === "review" &&
            !(view.page && (view.busy || !view.page.last))
            ? null
            : button("I applied", () => send({ type: "submitted" })),
        ),
  );

  let body: HTMLElement | null = currentCard(view, send, tell);
  if (action.kind === "paused")
    body = el(
      "p",
      { class: "muted" },
      "Paused. Nothing happens on the page until you resume.",
    );
  // Workday: the next page is still loading, being read and planned.
  if (action.kind === "review" && view.page && view.busy)
    body = el(
      "p",
      { class: "muted" },
      view.page.system === "generic"
        ? "Reading this page and planning it…"
        : `Reading "${view.page.step || "the next page"}" and planning it…`,
    );
  else if (action.kind === "review" && view.page && !view.page.last)
    body = el(
      "div",
      { class: "step-card" },
      el(
        "strong",
        {},
        view.page.system === "generic"
          ? "Check this page, then continue or submit it there yourself."
          : `Check "${view.page.step || "this page"}" on the page, then click Save and Continue there.`,
      ),
      el(
        "p",
        { class: "muted" },
        view.page.system === "generic"
          ? "If another page opens, it's read and filled too. Fields Apply Copilot couldn't fill were tried with this site's saved steps, then Claude."
          : "The next page is read and filled when it opens. On Review, you submit.",
      ),
    );
  else if (action.kind === "review")
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
