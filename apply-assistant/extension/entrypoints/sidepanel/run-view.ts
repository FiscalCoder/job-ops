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

/** A click arms "I applied"; a second click within this time ends the run as applied. */
const CONFIRM_APPLIED_MS = 4_000;
/** Kept across redraws (the panel is drawn again on every change while it fills). */
let appliedArmedUntil = 0;

/**
 * "I applied" / "I submitted it": two clicks, so a click meant for a button that just moved
 * (the panel redrawn as a field finishes) never marks the job applied.
 */
function appliedButton(
  label: string,
  send: (event: RunEvent) => void,
  primary = false,
): HTMLButtonElement {
  const armedLabel = "Click again: applied";
  const armed = () => Date.now() < appliedArmedUntil;
  const b = button(
    armed() ? armedLabel : label,
    () => {
      if (armed()) {
        appliedArmedUntil = 0;
        send({ type: "submitted" });
        return;
      }
      appliedArmedUntil = Date.now() + CONFIRM_APPLIED_MS;
      b.textContent = armedLabel;
      setTimeout(() => {
        if (!armed()) b.textContent = label;
      }, CONFIRM_APPLIED_MS);
    },
    primary,
  );
  b.title = "Ends the run and marks the job Applied in Job Ops";
  return b;
}

const valueText = (value: Step["value"]) =>
  value === null
    ? ""
    : Array.isArray(value)
      ? value.join(", ")
      : (value as string);

/** How a step goes in, in plain words (as the plan in the queue says it). */
const GATE: Record<string, string> = {
  auto: "fills itself",
  confirm: "waits for your OK",
  protected: "asks you first",
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
  // Less used: under "More" (the card keeps the main action, Claude and Skip in view).
  const more: HTMLElement[] = [];
  if (step.entry.actionClass === "auto" && action.kind !== "fill")
    more.push(
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
  more.push(button("I'll do it", () => send({ type: "i-did-it" }), false, busy));
  controls.push(
    // While it's being filled too: what's under way ends first, then the run goes on.
    button("Skip", () => send({ type: "skip" }), false, busy && action.kind !== "fill"),
    el("details", { class: "more" }, el("summary", {}, "More"), el("div", { class: "controls" }, ...more)),
  );
  // Where you are on this page (the run's step numbers go on across pages).
  const position = view.state.steps.indexOf(step) + 1;
  const done = view.state.steps.filter((s) => STATE_LABEL[s.state]).length;
  return el(
    "div",
    { class: "step-card" },
    el("progress", {
      value: String(done),
      max: String(total),
      "aria-label": `${done} of ${total} fields done on this page`,
    }),
    el(
      "div",
      { class: "row" },
      el("strong", {}, `Field ${position} of ${total} · ${step.entry.label}`),
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

/** Paused: the field the run stopped at, which you may skip or fill yourself before resuming. */
function pausedCard(view: RunView, send: Send): HTMLElement {
  const { state, busy } = view;
  const step = state.phase === "filling" ? state.steps[state.cursor] : undefined;
  const note = el(
    "p",
    { class: "muted" },
    "Paused. Nothing happens on the page until you resume.",
  );
  if (!step) return note;
  const running = step.state === "running";
  return el(
    "div",
    { class: "step-card" },
    el(
      "strong",
      {},
      `Field ${state.steps.indexOf(step) + 1} of ${state.steps.length} · ${step.entry.label}`,
    ),
    note,
    el(
      "div",
      { class: "controls" },
      button("I'll do it", () => send({ type: "i-did-it" }), false, busy),
      button("Skip this field", () => send({ type: "skip" }), false, busy && !running),
    ),
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
  readClosely?: () => void,
): HTMLElement {
  const picker = el("select", {
    "aria-label": "Fill again from a field, or only a section",
    title:
      "Fill again from the field you pick (the ones before stay as they are), or only one section",
  }) as HTMLSelectElement;
  picker.append(el("option", { value: "" }, fillOnly ? "Fill from… / only…" : "Fill from…"));
  // The page misread (wrong job in a field, a field not seen): Claude reads all of it first.
  if (readClosely)
    picker.append(
      el("option", { value: "closely:" }, "✦ Claude reads the page, then fill it"),
    );
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
    if (kind === "closely") readClosely?.();
    else if (kind === "only" && what) fillOnly?.(what);
    else if (kind === "from" && Number(what)) fillFrom(Number(what));
  });
  return picker;
}

/** "Fix a field": the page's field you picked (by place; "focused": the one you clicked), and how. */
export type FixField = (
  field: number | "focused",
  how: { readonly claude: boolean; readonly said?: string },
) => Promise<string | null>;

/**
 * "Fix a field", folded: pick a field (or the one you clicked on the page), say what's wrong if
 * you like, then fill just it again or have Claude fix it on the page. Built once per run, so
 * what you picked and typed stays while the run moves on.
 */
let fixPanel: {
  readonly key: string;
  readonly element: HTMLElement;
  readonly refresh: (fields: readonly string[], busy: boolean) => void;
} | null = null;

function fixFieldPanel(key: string, fix: FixField) {
  if (fixPanel?.key === key) return fixPanel;
  const picker = el("select", { "aria-label": "Field to fix" }) as HTMLSelectElement;
  const said = el("input", {
    "aria-label": "What's wrong with it",
    placeholder: `What's wrong (optional), e.g. "should be India"`,
  }) as HTMLInputElement;
  const note = el("p", { class: "muted" });
  const again = button("Fill it again", () => go(false));
  const claude = button("Claude fixes it", () => go(true), true);
  const go = async (byClaude: boolean) => {
    const value = picker.value;
    if (value === "") return;
    const seq = value === "focused" ? "focused" : Number(value);
    note.className = "muted";
    note.textContent = byClaude ? "Claude is on it…" : "Filling it again…";
    const problem = await fix(seq, { claude: byClaude, said: said.value });
    note.className = problem ? "error" : "muted";
    note.textContent = problem ?? "";
    if (!problem) said.value = "";
  };
  const element = el(
    "details",
    { class: "tell fix-field" },
    el("summary", {}, "Something wrong with a field? Fix it"),
    el("div", { class: "row" }, picker),
    el("div", { class: "row" }, said),
    el("div", { class: "controls" }, again, claude),
    note,
  );
  let shown = "";
  const refresh = (fields: readonly string[], busy: boolean) => {
    const kept = picker.value;
    // Only when the page's fields change: an open list isn't rebuilt under you.
    const now = JSON.stringify(fields);
    if (now !== shown) {
      shown = now;
      picker.replaceChildren(
        el("option", { value: "focused" }, "The field I clicked on the page"),
        ...fields.map((label, i) =>
          el("option", { value: String(i) }, `${i + 1}. ${label.slice(0, 48)}`),
        ),
      );
    }
    if ([...picker.options].some((o) => o.value === kept)) picker.value = kept;
    again.disabled = busy;
    claude.disabled = busy;
  };
  fixPanel = { key, element, refresh };
  return fixPanel;
}

/** "Tell Claude": your words for this page; an error to show, or null. */
export type TellClaude = (note: string) => string | null;

/**
 * "Tell Claude what to do on this page", folded: your words (the resume goes in the Resume
 * box, skip the cover letter), then Claude reads the whole page (its HTML and a screenshot) with
 * them and the page is filled again. Or Claude just reads the page. Built once per run.
 */
let tellPanel: {
  readonly key: string;
  readonly element: HTMLElement;
  readonly refresh: (busy: boolean) => void;
} | null = null;

function tellClaudePanel(
  key: string,
  tellClaude: TellClaude,
  readClosely?: () => void,
) {
  if (tellPanel?.key === key) return tellPanel;
  const words = el("textarea", {
    rows: "2",
    "aria-label": "Tell Claude what to do on this page",
    placeholder:
      'e.g. "the resume goes in the Resume box, not the profile photo", "skip the cover letter"',
  }) as HTMLTextAreaElement;
  const note = el("p", { class: "muted" });
  const send = button(
    "Tell Claude and refill",
    () => {
      const problem = tellClaude(words.value);
      note.className = problem ? "error" : "muted";
      note.textContent =
        problem ?? "Claude is reading the page with what you said, then it's filled again…";
      if (!problem) words.value = "";
    },
    true,
  );
  const read = readClosely
    ? button("✦ Just read this page", () => {
        note.className = "muted";
        note.textContent = "Claude is reading the whole page (its HTML and a screenshot)…";
        readClosely();
      })
    : null;
  const element = el(
    "details",
    { class: "tell tell-claude" },
    el("summary", {}, "✦ Tell Claude what to do on this page"),
    words,
    el("div", { class: "controls" }, send, read),
    note,
  );
  const refresh = (busy: boolean) => {
    send.disabled = busy;
    if (read) (read as HTMLButtonElement).disabled = busy;
  };
  tellPanel = { key, element, refresh };
  return tellPanel;
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
  /** Page by page: Claude reads the whole page closely, then it's planned and filled again. */
  readClosely?: () => void,
  /** "Fix a field": one field again, or by Claude. */
  fix?: FixField,
  /** Page by page: your words for Claude about this page. */
  tellClaude?: TellClaude,
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
          fillFrom &&
            !view.busy &&
            (state.steps.length || (view.page && readClosely))
            ? fillFromPicker(
                state.steps,
                fillFrom,
                fillOnly,
                view.page ? readClosely : undefined,
              )
            : null,
          button("Abort", () => send({ type: "abort" })),
          // You submitted it yourself, at any point: the run ends and the job is marked applied.
          // (On the last review the card below asks the same.)
          action.kind === "review" &&
            !(view.page && (view.busy || !view.page.last))
            ? null
            : appliedButton("I applied", send),
        ),
  );

  let body: HTMLElement | null = currentCard(view, send, tell);
  if (action.kind === "paused") body = pausedCard(view, send);
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
        appliedButton("I submitted it", send, true),
      ),
    );
  if (action.kind === "finished")
    body = el(
      "p",
      { class: state.outcome === "submitted" ? "ok" : "muted" },
      view.notice ?? (state.outcome === "submitted" ? "Applied." : "Stopped."),
    );

  const fixer =
    fix && action.kind !== "finished" && view.fields.length
      ? fixFieldPanel(view.job.jobId, fix)
      : null;
  // A run that ended leaves no fold behind for the next one.
  if (action.kind === "finished") fixPanel = null;
  fixer?.refresh(view.fields, view.busy);
  const teller =
    tellClaude && view.page && action.kind !== "finished"
      ? tellClaudePanel(view.job.jobId, tellClaude, readClosely)
      : null;
  if (action.kind === "finished") tellPanel = null;
  teller?.refresh(view.busy);
  const parts: (HTMLElement | null)[] = [
    header,
    teller?.element ?? null,
    fixer?.element ?? null,
    view.notice && action.kind !== "finished"
      ? el("p", { class: "error" }, view.notice)
      : null,
    ...view.problems.map((p) =>
      el("p", { class: "error" }, `On the page: ${p}`),
    ),
    action.kind === "review" && view.checks.length
      ? el(
          "div",
          { class: "muted" },
          el("strong", {}, "Worth a look before you submit"),
          el("ul", {}, ...view.checks.map((c) => el("li", {}, c))),
        )
      : null,
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
                s.decidedBy === "you" || s.decidedBy === "autopilot"
                  ? el("span", { class: "muted" }, ` · by ${s.decidedBy}`)
                  : null,
              );
            }),
          ),
        )
      : null,
  ];
  box.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
}
