import {
  ALL_SITES,
  attachResumeToPage,
  fillFocusedField,
  type PageFillOutcome,
} from "../../src/kit/page-fill";
import { saveResume } from "../../src/kit/resume-file";
import type { ApplyClient, Kit, KitItem } from "../../src/lib/api";
import { errorText, TraceRecorder } from "../../src/trace/recorder";

/**
 * The apply kit (APPLY_TRACE_AND_KIT_PLAN.md §T2): every answer for a job, one click each.
 * A click fills the field you selected on the page when the site allows it, else copies.
 * Every fill and copy goes to the job's trace, so manual applications teach later automation.
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

/** What to say after a copy, given why the kit didn't fill the page. */
const COPY_HINT: Record<string, string> = {
  "No field is selected on the page":
    "Click a field on the page first to fill it directly.",
  "LinkedIn: copy only": "On LinkedIn, paste it yourself.",
  "Company sites aren't allowed yet":
    "Allow company sites (above) to fill by click.",
};

export interface KitViewOptions {
  readonly client: ApplyClient;
  readonly job: { jobId: string; title: string; employer: string };
  readonly onBack: () => void;
}

/** Shows the kit in `box`; returns a function that ends the kit session. */
export async function showKit(
  box: HTMLElement,
  { client, job, onBack }: KitViewOptions,
): Promise<() => Promise<void>> {
  const trace = new TraceRecorder(client, job.jobId);
  const close = async () => {
    await trace.close();
  };
  const status = el("p", { class: "kit-status muted", "aria-live": "polite" });
  const say = (text: string, tone: "muted" | "ok" | "error" = "muted") => {
    status.className = `kit-status ${tone}`;
    status.textContent = text;
  };
  const back = button("Back", () => {
    void close();
    onBack();
  });
  box.replaceChildren(
    el("div", { class: "row" }, el("strong", {}, "Apply kit"), back),
    el("p", { class: "muted" }, "Loading…"),
  );

  let kit: Kit;
  try {
    kit = await client.kit(job.jobId);
  } catch (error) {
    box.replaceChildren(
      el("div", { class: "row" }, el("strong", {}, "Apply kit"), back),
      el("p", { class: "error" }, errorText(error)),
    );
    return close;
  }
  trace.event("kit-opened", `Apply kit opened for ${job.title}`);

  let resume: { base64: string; name: string } | null = null;
  const loadResume = async () => {
    resume ??= await client.resumePdf(job.jobId);
    return resume;
  };

  const copy = async (item: KitItem, reason: string) => {
    try {
      await navigator.clipboard.writeText(item.value);
    } catch (error) {
      say(`Couldn't copy: ${errorText(error)}`, "error");
      return;
    }
    say(
      `Copied ${item.label}. ${COPY_HINT[reason] ?? `(Couldn't fill it: ${reason})`}`,
      "ok",
    );
    trace.event("kit-copy", `Copied ${item.label}`, {
      data: { key: item.key, reason },
    });
  };

  const use = async (item: KitItem) => {
    const filled: PageFillOutcome = await fillFocusedField(item.value).catch(
      (error: unknown) => ({ ok: false, reason: errorText(error) }),
    );
    if (!filled.ok) return copy(item, filled.reason);
    const where = filled.field.label || filled.field.name || "the field";
    say(`Filled ${item.label} into "${where}" on ${filled.host}.`, "ok");
    trace.event(
      "kit-fill",
      `Filled ${item.label} into "${where}" on ${filled.host}`,
      {
        data: {
          key: item.key,
          host: filled.host,
          path: filled.path,
          field: filled.field,
        },
      },
    );
  };

  const itemRow = (item: KitItem) => {
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
    row.addEventListener("click", () => void use(item));
    return row;
  };

  const groups = kit.groups.map((group) => {
    const rows = group.items.map(itemRow);
    if (group.items.some((i) => i.sensitive))
      return el(
        "details",
        { class: "kit-group" },
        el("summary", {}, `${group.name} (click to show)`),
        ...rows,
      );
    return el("div", { class: "kit-group" }, el("h2", {}, group.name), ...rows);
  });

  const allowed = await chrome.permissions.contains({ origins: [ALL_SITES] });
  const allow = allowed
    ? null
    : el(
        "p",
        { class: "muted" },
        "To fill fields by click on company sites, ",
        button("allow company sites", async () => {
          if (await chrome.permissions.request({ origins: [ALL_SITES] })) {
            allow?.remove();
            say(
              "Company sites allowed: select a field, then click an answer.",
              "ok",
            );
          }
        }),
        ". On LinkedIn the kit only copies.",
      );

  const openButton = button("Open application ↗", () => {
    void chrome.tabs.create({ url: kit.job.applyUrl, active: true });
    trace.event("kit-open-application", `Opened ${kit.job.applyUrl}`);
  });

  const saveButton = button("Save resume, copy path", async () => {
    saveButton.disabled = true;
    try {
      const path = await saveResume(kit.job, await loadResume());
      await navigator.clipboard.writeText(path);
      say(
        "Resume saved and its path copied: in the upload dialog, press Ctrl+V then Enter.",
        "ok",
      );
      trace.event("resume-saved", "Resume saved to Downloads/JobOps", {
        data: { file: path.split(/[\\/]/).slice(-2).join("/") },
      });
    } catch (error) {
      say(`Couldn't save the resume: ${errorText(error)}`, "error");
      trace.event("error", `Couldn't save the resume: ${errorText(error)}`);
    } finally {
      saveButton.disabled = false;
    }
  });

  const attachButton = button("Attach resume to page", async () => {
    attachButton.disabled = true;
    try {
      const done = await attachResumeToPage(await loadResume());
      if (done.ok) {
        say(`Resume attached on ${done.host}: check the page shows it.`, "ok");
        trace.event("resume-attached", `Resume attached on ${done.host}`, {
          data: { host: done.host, path: done.path, field: done.field },
        });
      } else
        say(`${done.reason}. Use "Save resume, copy path" instead.`, "error");
    } catch (error) {
      say(`Couldn't attach: ${errorText(error)}`, "error");
    } finally {
      attachButton.disabled = false;
    }
  });

  const outcomes = outcomeButtons(client, job.jobId, say);

  box.replaceChildren(
    el("div", { class: "row" }, el("strong", {}, "Apply kit"), back),
    el("p", { class: "muted" }, `${kit.job.title} · ${kit.job.employer}`),
    el("div", { class: "controls" }, openButton, saveButton, attachButton),
    outcomes,
    ...(allow ? [allow] : []),
    el(
      "p",
      { class: "muted" },
      "Select a field on the page, then click an answer to fill it. Otherwise it's copied.",
    ),
    status,
    ...groups,
    askClaude(client, job.jobId, itemRow),
  );
  return close;
}

/** A click arms the button; a second click within this time does it. */
const CONFIRM_MS = 4_000;

/**
 * "I applied" and "Skip job": update Job Ops after applying (or deciding not to) by hand.
 * Each needs a second click to confirm, so a stray click changes nothing.
 */
function outcomeButtons(
  client: ApplyClient,
  jobId: string,
  say: (text: string, tone?: "muted" | "ok" | "error") => void,
): HTMLElement {
  const labels = {
    applied: ["I applied ✓", "Click again: mark Applied"],
    skipped: ["Skip job", "Click again: skip it"],
  } as const;
  const done = {
    applied: "Marked Applied in Job Ops.",
    skipped: "Skipped in Job Ops.",
  } as const;
  const buttons: HTMLButtonElement[] = [];
  const make = (outcome: "applied" | "skipped") => {
    let armed: ReturnType<typeof setTimeout> | null = null;
    const b = button(
      labels[outcome][0],
      async () => {
        if (!armed) {
          b.textContent = labels[outcome][1];
          armed = setTimeout(() => {
            armed = null;
            b.textContent = labels[outcome][0];
          }, CONFIRM_MS);
          return;
        }
        clearTimeout(armed);
        armed = null;
        for (const each of buttons) each.disabled = true;
        try {
          await client.kitOutcome(jobId, outcome);
          say(done[outcome], "ok");
          b.textContent = labels[outcome][0];
        } catch (error) {
          say(errorText(error), "error");
          b.textContent = labels[outcome][0];
          for (const each of buttons) each.disabled = false;
        }
      },
      outcome === "applied",
    );
    buttons.push(b);
    return b;
  };
  return el(
    "div",
    { class: "row outcome" },
    el("span", { class: "muted" }, "Done with this job?"),
    el("div", { class: "controls" }, make("applied"), make("skipped")),
  );
}

/** Paste a question the kit doesn't cover; Claude answers from your resume and answers. */
function askClaude(
  client: ApplyClient,
  jobId: string,
  itemRow: (item: KitItem) => HTMLElement,
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
  const ask = button(
    "Ask Claude",
    async () => {
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
    },
    true,
  );
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
