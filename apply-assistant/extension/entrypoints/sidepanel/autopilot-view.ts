import type {
  Ask,
  AutopilotStatus,
  Choice,
} from "../../src/autopilot/runner";

/** The autopilot bar: where it is in the queue, your controls, and its questions to you. */

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

function button(label: string, onClick: () => void, primary = false) {
  const b = el("button", { type: "button", class: primary ? "primary" : undefined }, label);
  b.addEventListener("click", onClick);
  return b;
}

const AUTO_EXPIRE_KEY = "autopilotAutoExpire";

/** Your setting: postings that look closed are marked expired without asking. */
export async function autoExpireSetting(): Promise<boolean> {
  const stored = await chrome.storage.local.get(AUTO_EXPIRE_KEY);
  return stored[AUTO_EXPIRE_KEY] === true;
}

function autoExpireToggle(current: boolean): HTMLElement {
  const box = el("input", { type: "checkbox" }) as HTMLInputElement;
  box.checked = current;
  box.addEventListener(
    "change",
    () => void chrome.storage.local.set({ [AUTO_EXPIRE_KEY]: box.checked }),
  );
  return el(
    "label",
    { class: "muted" },
    box,
    " Mark postings that look closed expired without asking",
  );
}

/**
 * Claude's limits per application, in dollars: finding the form ($0.20) plus working fields
 * ($0.60), with answers on top: about $1 in all.
 */
const JOB_CEILING = 1;
const NEAR_CEILING = 0.8;

/** What Claude has cost on this job so far, warning as it nears the ceiling. */
function costLine(cost: number): HTMLElement {
  return el(
    "p",
    { class: cost >= NEAR_CEILING * JOB_CEILING ? "error" : "muted" },
    `Claude on this job: $${cost.toFixed(2)} of about $${JOB_CEILING.toFixed(2)}`,
  );
}

export function renderAutopilotBar(
  box: HTMLElement,
  status: AutopilotStatus,
  controls: { stop: () => void; skip: () => void },
  autoExpire: boolean,
): void {
  const section = box.parentElement ?? box;
  section.hidden = false;
  const finished = status.phase === "finished";
  const parts: (HTMLElement | null)[] = [
    el(
      "div",
      { class: "row" },
      el(
        "strong",
        {},
        finished
          ? `Autopilot finished: ${status.done} job(s)`
          : `Autopilot · job ${status.done} of ${status.total}`,
      ),
      el(
        "div",
        { class: "controls" },
        finished
          ? button("Close", () => {
              section.hidden = true;
            })
          : button("Skip this job", controls.skip),
        finished ? null : button("Stop autopilot", controls.stop),
      ),
    ),
    status.item
      ? el(
          "p",
          {},
          `${status.item.title} · ${status.item.employer}`,
          status.item.score === null ? null : el("span", { class: "muted" }, ` · score ${status.item.score}`),
          el("span", { class: "badge" }, ` ${status.phase}`),
        )
      : null,
    status.note ? el("p", { class: "muted" }, status.note) : null,
    status.cost === undefined || finished ? null : costLine(status.cost),
    autoExpireToggle(autoExpire),
  ];
  box.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
}

const ASK_TITLE: Record<Ask["kind"], string> = {
  closed: "This posting looks closed",
  login: "The site wants you to sign in",
  stuck: "Autopilot couldn't reach the application form",
  aborted: "You stopped this application",
};

const ASK_HINT: Record<Ask["kind"], string> = {
  closed: "Mark it expired in Job Ops (it leaves your queue), or, if it's still open, open its application form and press Continue.",
  login: "Sign in or create the account on the page, then press Continue.",
  stuck: "Open the application form yourself in this window, then press Continue.",
  aborted: "Go on to the next job in the queue, or stop autopilot here.",
};

/** A question to you on the bar; resolves with your choice. */
export function askOnBar(box: HTMLElement, question: Ask): Promise<Choice> {
  return new Promise((resolve) => {
    const card = el("div", { class: "step-card" });
    const choose = (choice: Choice) => {
      card.remove();
      resolve(choice);
    };
    card.append(
      el("strong", {}, ASK_TITLE[question.kind]),
      el(
        "p",
        {},
        `${question.item.title} · ${question.item.employer}${question.reason ? `: ${question.reason}` : ""}`,
      ),
      el("p", { class: "muted" }, ASK_HINT[question.kind]),
      question.kind === "aborted"
        ? el(
            "div",
            { class: "controls" },
            button("Next job", () => choose("continue"), true),
            button("Stop autopilot", () => choose("stop")),
          )
        : el(
        "div",
        { class: "controls" },
        question.kind === "closed"
          ? button("Mark expired", () => choose("expire"), true)
          : null,
        button(
          question.kind === "closed" ? "Not closed: Continue" : "Continue",
          () => choose("continue"),
          question.kind !== "closed",
        ),
        button("Skip this job", () => choose("skip")),
        button("Stop autopilot", () => choose("stop")),
      ),
    );
    if (box.parentElement) box.parentElement.hidden = false;
    box.append(card);
  });
}
