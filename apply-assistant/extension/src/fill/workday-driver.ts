import type {
  ElementHandle,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { PlanEntry } from "./supervisor";
import {
  bestOption,
  type FillOutcome,
  FORM_WAIT_MS,
  failed,
  OPTION_WAIT_MS,
  POLL_MS,
  type ResumeFile,
  selectionMatches,
  sleep,
  TrustedDriver,
} from "./trusted";

/**
 * Fills a Workday application (PHASE1_GREENHOUSE_PLAN.md §12G). The form only exists after you
 * sign in, one wizard page at a time (My Information, My Experience, Application Questions,
 * ...), so the run reads the page you're on, has the server plan it, fills it, and waits for
 * you to click Save and Continue. Built from the LPL Financial pages recorded on 2026-10-21:
 *
 * - each field sits in `data-automation-id="formField-<key>"`, whose `data-fkit-id` is the
 *   control's own id (the plan's ref); a required field's label carries an `<abbr>*</abbr>`;
 * - dropdowns are buttons that open a listbox (their choices only exist while open);
 * - "search" fields (How did you hear, Country Phone Code, Skills) take typed text + Enter and
 *   keep what you pick as tags;
 * - the resume upload on "Autofill with Resume" sits outside the field containers.
 */

export type WorkdayFieldKind =
  | "text"
  | "textarea"
  | "dropdown"
  | "search"
  | "radio"
  | "checkbox"
  | "date"
  | "file";

export interface WorkdayField {
  readonly ref: string;
  readonly key: string;
  readonly label: string;
  readonly kind: WorkdayFieldKind;
  readonly required: boolean;
  readonly options: readonly string[];
}

/** A section with an Add button (Work Experience, Education, ...) and its entries so far. */
export interface WorkdaySection {
  readonly id: string;
  readonly label: string;
  readonly entries: number;
}

export interface WorkdayPage {
  readonly step: string;
  readonly fields: readonly WorkdayField[];
  readonly sections: readonly WorkdaySection[];
}

/** Entries to add before filling: Add clicks per section (the server's answer). */
export interface EntriesToAdd {
  readonly section: string;
  readonly count: number;
}

export const RESUME_REF = "file-upload-input-ref";
const UPLOAD = `input[type=file][data-automation-id="${RESUME_REF}"]`;
const UPLOAD_WAIT_MS = 15_000;
/** As many choices as a dropdown can have (Country lists ~250); the server takes up to this. */
const MAX_OPTIONS = 500;
/** How long a new page gets to replace the last one's fields (Workday swaps them in place). */
const NEW_PAGE_WAIT_MS = 10_000;
/** Workday's placeholder choice in every dropdown. */
const PLACEHOLDER = /^select one$/i;

const clean = (ref: string) => ref.replace(/["\\]/g, "");
const boxOf = (ref: string) =>
  ref === RESUME_REF
    ? UPLOAD
    : `[data-fkit-id="${clean(ref)}"], [data-automation-id="${clean(ref)}"]`;

/** The wizard step's name ("My Information"); runs inside the page. */
export function workdayStep(): string {
  return (
    document.querySelector("[data-automation-id='progressBarActiveStep']")
      ?.textContent ?? ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^current step \d+ of \d+\s*/i, "");
}

/** The page's fields; runs inside the page, so it stays self-contained (no outside helpers). */
export function readWorkdayPage(): WorkdayPage {
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const step = text(
    document.querySelector("[data-automation-id='progressBarActiveStep']"),
  ).replace(/^current step \d+ of \d+\s*/i, "");
  const fields: WorkdayField[] = [];
  const seen = new Set<string>();
  for (const box of document.querySelectorAll<HTMLElement>(
    "[data-automation-id^='formField-']",
  )) {
    if (box.closest("header, nav, [data-automation-id='header']")) continue;
    if (typeof box.checkVisibility === "function" && !box.checkVisibility())
      continue;
    const marker = box.getAttribute("data-automation-id") ?? "";
    const ref = box.getAttribute("data-fkit-id") || marker;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const labelEl = box.querySelector("legend, label");
    const radios = [
      ...box.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ];
    const checks = [
      ...box.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    ];
    const optionLabel = (input: HTMLInputElement) =>
      text(
        input.id ? box.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null,
      ) ||
      text(input.closest("label")) ||
      input.getAttribute("aria-label") ||
      input.value;
    let kind: WorkdayFieldKind;
    let options: string[] = [];
    if (box.querySelector("button[aria-haspopup='listbox']")) kind = "dropdown";
    else if (box.querySelector("[data-automation-id='multiSelectContainer']"))
      kind = "search";
    else if (radios.length) {
      kind = "radio";
      options = radios.map(optionLabel);
    } else if (checks.length) {
      kind = "checkbox";
      options = [...new Set(checks.map(optionLabel))];
    } else if (box.querySelector("[data-automation-id^='dateSection']"))
      kind = "date";
    else if (box.querySelector("input[type=file]")) {
      // Already attached (Autofill with Resume uploads it): nothing to do.
      if (box.querySelector("[data-automation-id='file-upload-successful']"))
        continue;
      kind = "file";
    }
    else if (box.querySelector("textarea")) kind = "textarea";
    else if (box.querySelector("input")) kind = "text";
    else continue;
    fields.push({
      ref,
      key: marker.slice("formField-".length),
      label: text(labelEl).replace(/\*$/, "").trim().slice(0, 500),
      kind,
      required:
        Boolean(labelEl?.querySelector("abbr")) ||
        Boolean(box.querySelector("[aria-required='true']")),
      options: options
        .map((o) => o.replace(/\*$/, "").trim().slice(0, 300))
        .slice(0, 500),
    });
  }
  // "Autofill with Resume": the upload sits outside the field containers, and once a file is
  // attached Workday shows it as uploaded (later pages then need nothing).
  const upload = document.querySelector(
    "input[type=file][data-automation-id='file-upload-input-ref']",
  );
  if (
    upload &&
    !upload.closest("[data-automation-id^='formField-']") &&
    !document.querySelector("[data-automation-id='file-upload-successful']")
  )
    fields.push({
      ref: "file-upload-input-ref",
      key: "resume",
      label: "Resume",
      kind: "file",
      required: false,
      options: [],
    });
  // Sections you add entries to (Work Experience, Education, ...): how many each has now.
  const sections = [
    ...document.querySelectorAll<HTMLElement>(
      "[role='group'][aria-labelledby$='-section']",
    ),
  ]
    .filter((group) => group.querySelector("[data-automation-id='add-button']"))
    .map((group) => {
      const id = group.getAttribute("aria-labelledby") ?? "";
      return {
        id,
        label: text(document.getElementById(id)),
        entries: group.querySelectorAll(
          "[role='group'][aria-labelledby$='-panel']",
        ).length,
      };
    });
  return { step, fields, sections };
}

/** What kind of control a field container holds; runs inside the page. */
function controlKind(box: Element | null): WorkdayFieldKind | null {
  if (!box) return null;
  if (box.matches("input[type=file]") || box.querySelector("input[type=file]"))
    return "file";
  if (box.querySelector("button[aria-haspopup='listbox']")) return "dropdown";
  if (box.querySelector("[data-automation-id='multiSelectContainer']"))
    return "search";
  if (box.querySelector("input[type=radio]")) return "radio";
  if (box.querySelector("input[type=checkbox]")) return "checkbox";
  if (box.querySelector("[data-automation-id^='dateSection']")) return "date";
  if (box.querySelector("textarea")) return "textarea";
  if (box.querySelector("input")) return "text";
  return null;
}

/** What a field shows now ("" when empty); runs inside the page. */
function shownValue(box: Element | null): string {
  if (!box) return "";
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const button = box.querySelector("button[aria-haspopup='listbox']");
  if (button) {
    const shown = text(button);
    return /^select one$/i.test(shown) ? "" : shown;
  }
  // A date shows "09" / "2025" (or "MM" / "YYYY" while empty) in its spin buttons.
  const parts = [
    ...box.querySelectorAll(
      "[data-automation-id='dateSectionMonth-display'], [data-automation-id='dateSectionYear-display']",
    ),
  ].map(text);
  if (parts.length)
    return parts.some((p) => !/^\d+$/.test(p)) ? "" : parts.join("/");
  const multi = box.querySelector("[data-automation-id='multiSelectContainer']");
  if (multi)
    return [...multi.querySelectorAll("[data-automation-id='selectedItem']")]
      .map(text)
      .join(", ");
  const choices = [
    ...box.querySelectorAll<HTMLInputElement>(
      "input[type=radio], input[type=checkbox]",
    ),
  ];
  if (choices.length)
    return choices
      .filter((input) => input.checked)
      .map(
        (input) =>
          text(
            input.id
              ? box.querySelector(`label[for="${CSS.escape(input.id)}"]`)
              : null,
          ) || input.value,
      )
      .join(", ");
  const input = box.querySelector<HTMLInputElement>("textarea, input");
  return input?.value ?? "";
}

export class WorkdayDriver extends TrustedDriver {
  protected readonly errorSelector =
    "[data-automation-id='errorMessage'], [data-automation-id='errorBanner'] li, [data-automation-id='inputAlert']";

  static async attach(page: Page): Promise<WorkdayDriver | null> {
    const deadline = Date.now() + FORM_WAIT_MS;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const found = await frame
          .$("[data-automation-id='applyFlowPage']")
          .catch(() => null);
        if (found) return new WorkdayDriver(page, frame);
      }
      await sleep(400);
    }
    return null;
  }

  protected boxFor(ref: string): string {
    return boxOf(ref);
  }

  /** The wizard step you're on ("" while Workday swaps pages). */
  step(): Promise<string> {
    return this.frame.evaluate(workdayStep).catch(() => "");
  }

  /** The fields of the page read last, so a new page isn't mistaken for it while it loads. */
  private lastRefs: string | null = null;

  /**
   * The page's fields once they've settled: the same on two reads in a row, and not the last
   * page's (Workday shows the new step's name before it swaps the fields in).
   */
  private async settledPage(): Promise<WorkdayPage> {
    const deadline = Date.now() + NEW_PAGE_WAIT_MS;
    let previous: string | null = null;
    for (;;) {
      const page = await this.frame.evaluate(readWorkdayPage);
      const refs = page.fields.map((f) => f.ref).join("|");
      const settled =
        refs === previous && refs !== this.lastRefs && page.fields.length > 0;
      if (settled || Date.now() > deadline) {
        this.lastRefs = refs;
        return page;
      }
      previous = refs;
      await sleep(POLL_MS * 4);
    }
  }

  /** The page's fields, with each dropdown's choices (read by opening it and closing it again). */
  async readPage(): Promise<WorkdayPage> {
    const page = await this.settledPage();
    const fields: WorkdayField[] = [];
    for (const field of page.fields) {
      if (field.kind !== "dropdown") {
        fields.push(field);
        continue;
      }
      const button = await this.frame.$(
        `[data-fkit-id="${clean(field.ref)}"] button[aria-haspopup='listbox']`,
      );
      const options = button ? await this.listChoices(button) : [];
      await this.page.keyboard.press("Escape");
      await sleep(POLL_MS);
      fields.push({
        ...field,
        options: options
          .filter((o) => !PLACEHOLDER.test(o))
          .map((o) => o.slice(0, 300))
          .slice(0, MAX_OPTIONS),
      });
    }
    return { step: page.step, fields, sections: page.sections };
  }

  /** The open listbox's choices (labels and handles), once they stop changing. */
  private async openChoices(): Promise<
    { labels: string[]; handles: ElementHandle[] } | null
  > {
    const deadline = Date.now() + OPTION_WAIT_MS;
    let previous = "";
    while (Date.now() < deadline) {
      await sleep(POLL_MS * 2);
      const handles: ElementHandle[] = [];
      const labels: string[] = [];
      for (const option of await this.frame.$$(
        "[role='listbox'] [role='option']",
      )) {
        const label = await option.evaluate((el) =>
          (el as HTMLElement).offsetParent === null
            ? null
            : (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        );
        if (label === null) continue;
        handles.push(option);
        labels.push(label);
      }
      const snapshot = labels.join("|");
      if (!labels.length || snapshot !== previous) {
        previous = snapshot;
        continue;
      }
      return { labels, handles };
    }
    return null;
  }

  private async listChoices(button: ElementHandle): Promise<string[]> {
    await button.click();
    return (await this.openChoices())?.labels ?? [];
  }

  /** Clicks the choice that best matches, among the open listbox's. */
  private async pickOpen(wanted: string): Promise<string | null> {
    const open = await this.openChoices();
    if (!open) return null;
    const usable = open.labels.map((l) => (PLACEHOLDER.test(l) ? "" : l));
    const index = bestOption(usable, wanted);
    if (index === null) return null;
    await open.handles[index]?.click();
    await sleep(300);
    return open.labels[index] ?? null;
  }

  async fill(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    resume?: ResumeFile,
  ): Promise<FillOutcome> {
    if (value === null) return { ok: false, reason: "Nothing to fill" };
    try {
      const box = boxOf(entry.ref);
      const kind = await this.frame
        .$eval(box, controlKind)
        .catch(() => null);
      if (!kind)
        return {
          ok: false,
          reason: "Field not found on the page; fill it yourself",
        };
      const wanted = Array.isArray(value) ? value : [value as string];
      const first = wanted[0] ?? "";
      switch (kind) {
        case "file":
          return resume
            ? await this.upload(entry.ref, resume)
            : { ok: false, reason: "Tailored PDF not loaded" };
        case "dropdown":
          return await this.dropdown(entry.ref, first);
        case "search":
          return await this.search(entry.ref, wanted);
        case "radio":
        case "checkbox":
          return await this.choose(entry.ref, wanted);
        case "date":
          return await this.date(entry.ref, first);
        default: {
          const input = await this.frame.$(
            `:is(${box}) :is(textarea, input:not([type=hidden]))`,
          );
          if (!input)
            return { ok: false, reason: "Field not found on the page" };
          return await this.typeText(
            input,
            wanted.join(", "),
            /phoneNumber$/.test(entry.ref),
          );
        }
      }
    } catch (error) {
      return failed(error);
    }
  }

  private async dropdown(ref: string, wanted: string): Promise<FillOutcome> {
    const button = await this.frame.$(
      `:is(${boxOf(ref)}) button[aria-haspopup='listbox']`,
    );
    if (!button) return { ok: false, reason: "Dropdown not found" };
    const before = await this.readBackRef(ref);
    if (before && selectionMatches(before, wanted))
      return { ok: true, result: `already "${before}"` };
    await button.click();
    const picked = await this.pickOpen(wanted);
    if (!picked) {
      await this.page.keyboard.press("Escape");
      return { ok: false, reason: `No choice matching "${wanted}"` };
    }
    const shown = await this.readBackRef(ref);
    return selectionMatches(shown, picked)
      ? { ok: true, result: `picked "${picked}"` }
      : { ok: false, reason: `"${picked}" wasn't selected` };
  }

  /** Type, Enter, pick the best result; a category opens its own list, so pick again there. */
  private async search(
    ref: string,
    wanted: readonly string[],
  ): Promise<FillOutcome> {
    const picked: string[] = [];
    for (const item of wanted) {
      if (selectionMatches(await this.readBackRef(ref), item)) {
        picked.push(item);
        continue;
      }
      const input = await this.frame.$(
        `:is(${boxOf(ref)}) [data-automation-id='multiSelectContainer'] input`,
      );
      if (!input) return { ok: false, reason: "Search box not found" };
      await input.click();
      await this.page.keyboard.sendCharacter(item.slice(0, 60));
      await this.page.keyboard.press("Enter");
      let chosen = await this.pickOpen(item);
      if (chosen && !selectionMatches(await this.readBackRef(ref), chosen))
        chosen = (await this.pickOpen(item)) ?? chosen;
      await this.page.keyboard.press("Escape");
      if (chosen) picked.push(chosen);
    }
    const shown = await this.readBackRef(ref);
    const kept = picked.filter((p) => selectionMatches(shown, p));
    if (kept.length === 0 || (wanted.length === 1 && kept.length < picked.length))
      return {
        ok: false,
        reason: `No result matching "${wanted.join(", ")}" was kept`,
      };
    // Several (skills): Workday's list may not have every one; what it has is enough.
    const notFound = wanted.length - kept.length;
    return {
      ok: true,
      result: `picked "${shown}"${notFound ? ` (${notFound} not in Workday's list)` : ""}`,
    };
  }

  /** Types a date into its spin buttons: "09/2025" (month and year) or "2019" (year only). */
  private async date(ref: string, wanted: string): Promise<FillOutcome> {
    const [month, year] = wanted.includes("/")
      ? wanted.split("/")
      : [null, wanted];
    const box = `:is(${boxOf(ref)})`;
    const parts: [string, string | null | undefined][] = [
      ["dateSectionMonth", month],
      ["dateSectionYear", year],
    ];
    for (const [part, digits] of parts) {
      if (!digits) continue;
      // The spin button's input has no size: you click the "MM" / "YYYY" it shows instead.
      const input = await this.frame.$(
        `${box} [data-automation-id='${part}-input']`,
      );
      const display = await this.frame.$(
        `${box} [data-automation-id='${part}-display']`,
      );
      if (!input) return { ok: false, reason: "Date box not found" };
      await display?.click().catch(() => undefined);
      await input.evaluate((el) => {
        if (document.activeElement !== el) (el as HTMLElement).focus();
      });
      await this.page.keyboard.type(digits);
      await sleep(150);
    }
    await this.page.keyboard.press("Tab");
    const shown = await this.readBackRef(ref);
    const same = (a: string) => a.replace(/^0/, "").replace(/\/0/, "/");
    return same(shown) === same(wanted)
      ? { ok: true, result: `set to ${shown}` }
      : { ok: false, reason: `Date shows "${shown || "empty"}"` };
  }

  /** Clicks Add in each section until it has as many entries as asked for. */
  async addEntries(add: readonly EntriesToAdd[]): Promise<void> {
    for (const { section, count } of add) {
      const group = `[role='group'][aria-labelledby="${clean(section)}"]`;
      const entries = () =>
        this.frame
          .$$eval(`${group} [role='group'][aria-labelledby$='-panel']`, (l) => l.length)
          .catch(() => 0);
      for (let i = 0; i < count; i++) {
        const buttons = await this.frame.$$(
          `${group} [data-automation-id='add-button']`,
        );
        const button = buttons.at(-1);
        if (!button) break;
        const before = await entries();
        await button.click();
        const deadline = Date.now() + OPTION_WAIT_MS;
        while ((await entries()) <= before && Date.now() < deadline)
          await sleep(POLL_MS * 2);
      }
    }
  }

  private async choose(
    ref: string,
    wanted: readonly string[],
  ): Promise<FillOutcome> {
    const choices = await this.frame.$$eval(
      `:is(${boxOf(ref)}) :is(input[type=radio], input[type=checkbox])`,
      (inputs) =>
        inputs.map((input) => {
          const el = input as HTMLInputElement;
          const label = el.id
            ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
            : el.closest("label");
          return {
            id: el.id,
            label: (label?.textContent ?? el.value)
              .replace(/\s+/g, " ")
              .trim()
              .replace(/\*$/, "")
              .trim(),
            checked: el.checked,
          };
        }),
    );
    const labels = choices.map((c) => c.label);
    const picked: string[] = [];
    for (const item of wanted) {
      const index = bestOption(labels, item);
      const choice = index === null ? undefined : choices[index];
      if (!choice) continue;
      if (!choice.checked) {
        const target =
          (choice.id
            ? await this.frame.$(`label[for="${clean(choice.id)}"]`)
            : null) ??
          (await this.frame.$(
            `:is(${boxOf(ref)}) :is(input[type=radio], input[type=checkbox])`,
          ));
        await target?.click();
        await sleep(200);
      }
      picked.push(choice.label);
    }
    if (picked.length === 0)
      return { ok: false, reason: `No choice matching "${wanted.join(", ")}"` };
    const shown = await this.readBackRef(ref);
    const missing = picked.filter((p) => !selectionMatches(shown, p));
    return missing.length
      ? { ok: false, reason: `"${missing.join(", ")}" didn't stay selected` }
      : {
          ok: true,
          result: `picked ${picked.map((p) => `"${p}"`).join(", ")}`,
        };
  }

  /**
   * Attaches the tailored resume to the upload (the one on Autofill with Resume, or a field's
   * own, e.g. My Experience's Resume/CV) and waits for Workday to show it as uploaded.
   */
  private async upload(ref: string, resume: ResumeFile): Promise<FillOutcome> {
    const box = ref === RESUME_REF ? "body" : `:is(${boxOf(ref)})`;
    const attached = await this.attachFile(`${box} ${UPLOAD}`, resume);
    if (!attached.ok) return attached;
    const deadline = Date.now() + UPLOAD_WAIT_MS;
    while (Date.now() < deadline) {
      const done = await this.frame
        .$(`${box} [data-automation-id='file-upload-successful']`)
        .catch(() => null);
      if (done) return attached;
      await sleep(POLL_MS * 4);
    }
    return {
      ok: false,
      reason: "Workday didn't confirm the upload; check it on the page",
    };
  }

  private readBackRef(ref: string): Promise<string> {
    return this.frame.$eval(boxOf(ref), shownValue).catch(() => "");
  }

  async readBack(entry: PlanEntry): Promise<string> {
    if (entry.type === "file") return "";
    return this.readBackRef(entry.ref);
  }
}
