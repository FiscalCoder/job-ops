import type { QueueItem } from "../../src/lib/api";
import type { JobMatch } from "../../src/track/job-match";

/**
 * "You're on …": the banner for the tab you're on when it belongs to a queued job
 * (APPLY_TRACE_AND_KIT_PLAN.md §T3). Fill this page where the form can be filled, the Apply
 * kit everywhere, and "Mark Applied?" when the page looks like a confirmation.
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

function button(label: string, onClick: () => void, primary = false) {
  const b = el(
    "button",
    { type: "button", class: primary ? "primary" : undefined },
    label,
  ) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

export interface HereActions {
  readonly kitButton: (item: QueueItem) => HTMLElement;
  /** Supervised fill in this tab. */
  readonly fill: () => void;
  /** "Mark Applied" from a confirmation page; resolves once Job Ops has it. */
  readonly markApplied: () => Promise<void>;
  /** "Not yet": stop asking on this page. */
  readonly dismiss: () => void;
}

const HEADLINE: Record<JobMatch["how"], (item: QueueItem) => string> = {
  posting: (i) => `You're on the application for ${i.title}`,
  linkedin: (i) => `You're on the LinkedIn page for ${i.title}`,
  listing: (i) => `You're on the listing for ${i.title}`,
  tracked: (i) => `You're applying to ${i.title}`,
};

export function renderHere(
  box: HTMLElement,
  match: JobMatch,
  submitted: boolean,
  actions: HereActions,
): void {
  const { item, how } = match;
  const fillable = how === "posting" && item.plan !== null;
  const confirm = submitted
    ? (() => {
        const mark = button(
          "Mark Applied",
          async () => {
            mark.disabled = true;
            mark.textContent = "Marking…";
            try {
              await actions.markApplied();
            } catch (error) {
              mark.disabled = false;
              mark.textContent = "Mark Applied";
              note.textContent =
                error instanceof Error ? error.message : String(error);
              note.className = "error";
            }
          },
          true,
        );
        const note = el(
          "p",
          { class: "muted" },
          "This looks like a confirmation page. Did you submit?",
        );
        return el(
          "div",
          { class: "confirm" },
          note,
          el(
            "div",
            { class: "controls" },
            mark,
            button("Not yet", actions.dismiss),
          ),
        );
      })()
    : null;
  const parts: (HTMLElement | null)[] = [
    el("strong", {}, HEADLINE[how](item)),
    el("p", { class: "muted" }, item.employer),
    confirm,
    el(
      "div",
      { class: "controls" },
      fillable ? button("Fill this page", actions.fill, !submitted) : null,
      actions.kitButton(item),
    ),
    how === "posting" && !item.plan
      ? el("p", { class: "muted" }, "No fill plan yet (Run now builds one).")
      : null,
  ];
  box.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  box.hidden = false;
}
