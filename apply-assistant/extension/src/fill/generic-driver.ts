import type {
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { pickOpenChoice, showsValue } from "./site-help";
import type { PlanEntry } from "./supervisor";
import {
  bestOption,
  type FillOutcome,
  FORM_WAIT_MS,
  failed,
  type ResumeFile,
  selectionMatches,
  sleep,
  TrustedDriver,
} from "./trusted";
import type { Chooser } from "./workday-driver";

/**
 * Any company's own application page (no known system). Fields are read generically (labels,
 * kinds, choices), planned like every other form, and filled with trusted input. A field it
 * can't fill by itself goes to this site's saved steps, then Claude (site-help.ts), like on
 * every other system.
 */

export type GenericKind =
  | "text"
  | "textarea"
  | "dropdown"
  | "search"
  | "radio"
  | "checkbox"
  | "date"
  | "file";

export interface GenericField {
  readonly ref: string;
  readonly key: string;
  readonly label: string;
  readonly kind: GenericKind;
  readonly required: boolean;
  readonly options: readonly string[];
}

export interface GenericPage {
  readonly system: "generic";
  readonly step: string;
  readonly fields: readonly GenericField[];
  readonly sections: readonly never[];
}

/** The page's step: where you are and its heading; runs inside the page. */
export function genericStep(): string {
  const heading = [...document.querySelectorAll("h1, h2")]
    .find((h) => (h as HTMLElement).offsetParent !== null)
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return `${location.pathname}${heading ? ` · ${heading.slice(0, 120)}` : ""}`;
}

/** The page's fields; runs inside the page, so it stays self-contained. */
export function readGenericPage(): GenericPage {
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const SKIP = /^(hidden|submit|button|reset|image|password|search)$/i;
  const CAPTCHA = /recaptcha|hcaptcha|turnstile/i;
  const labelOf = (el: HTMLElement): string => {
    const input = el as HTMLInputElement;
    const byIds = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .join(" ")
      .trim();
    const box = el.closest(
      "fieldset, [role='group'], [role='radiogroup'], .field, [class*='field' i], [class*='question' i]",
    );
    const group =
      input.type === "radio" || (input.type === "checkbox" && input.name)
        ? text(box?.querySelector("legend, [class*='label' i], label"))
        : "";
    return (
      group ||
      text(input.labels?.[0]) ||
      el.getAttribute("aria-label") ||
      byIds ||
      text(el.closest("label")) ||
      text(box?.querySelector("label, legend")) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      ""
    ).slice(0, 300);
  };
  let counter = 0;
  const refOf = (el: HTMLElement, group: string | null): string => {
    if (group) return `input[name="${group.replace(/["\\]/g, "\\$&")}"]`;
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1)
      return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (name && document.querySelectorAll(`[name="${CSS.escape(name)}"]`).length === 1)
      return `[name="${name.replace(/["\\]/g, "\\$&")}"]`;
    const mark = el.getAttribute("data-ac-ref") ?? `ac${counter++}`;
    el.setAttribute("data-ac-ref", mark);
    return `[data-ac-ref="${mark}"]`;
  };
  const optionLabel = (input: HTMLInputElement) =>
    text(input.labels?.[0]) ||
    text(input.closest("label")) ||
    input.getAttribute("aria-label") ||
    input.value;

  const fields: GenericField[] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>(
    "input, select, textarea, [role='combobox']:not(input)",
  )) {
    if (fields.length >= 200) break;
    const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && SKIP.test(input.type)) continue;
    if (el.closest("header, nav, footer, #ac-badge")) continue;
    if (/one-time-code/i.test(el.getAttribute("autocomplete") ?? "")) continue;
    if (input.disabled || input.readOnly) continue;
    // A dropdown's stand-in for the browser's "required" check (react-select), and captcha tokens.
    if (el.getAttribute("aria-hidden") === "true" && input.type !== "file") continue;
    if (CAPTCHA.test(`${el.id} ${el.getAttribute("name") ?? ""}`)) continue;
    // Hidden fields aren't for you, except uploads (their input hides behind a button).
    const visible = el.offsetParent !== null || el.getClientRects().length > 0;
    if (!visible && input.type !== "file") continue;
    const group =
      (input.type === "radio" || input.type === "checkbox") && input.name
        ? input.name
        : null;
    const ref = refOf(el, group);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const members = group
      ? [...document.querySelectorAll<HTMLInputElement>(ref)]
      : [input];
    let kind: GenericKind;
    let options: string[] = [];
    if (input.type === "file") kind = "file";
    else if (tag === "select") {
      kind = "dropdown";
      options = [...(el as unknown as HTMLSelectElement).options]
        .filter((o) => o.value !== "" && !o.disabled)
        .map((o) => o.text.trim());
    } else if (tag === "textarea") kind = "textarea";
    else if (input.type === "radio") {
      kind = "radio";
      options = members.map(optionLabel);
    } else if (input.type === "checkbox") {
      kind = "checkbox";
      options = members.length > 1 ? members.map(optionLabel) : [];
    } else if (input.type === "date" || input.type === "month") kind = "date";
    else if (tag !== "input") kind = "dropdown";
    else if (
      el.getAttribute("role") === "combobox" ||
      /^(list|both)$/.test(el.getAttribute("aria-autocomplete") ?? "") ||
      input.list
    )
      kind = "search";
    else kind = "text";
    const label = labelOf(el);
    const required =
      members.some((m) => m.required) ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$/.test(label);
    fields.push({
      ref,
      key: el.getAttribute("name") || el.id || ref,
      label: label.replace(/\s*\*\s*$/, "").trim(),
      kind,
      required,
      options: options.map((o) => o.slice(0, 300)).slice(0, 500),
    });
  }
  const heading = [...document.querySelectorAll("h1, h2")]
    .find((h) => (h as HTMLElement).offsetParent !== null)
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return {
    system: "generic",
    step: `${location.pathname}${heading ? ` · ${heading.slice(0, 120)}` : ""}`,
    fields,
    sections: [],
  };
}

type DomKind =
  | "file"
  | "select"
  | "radio"
  | "checkbox"
  | "date"
  | "combobox"
  | "custom"
  | "text";

/** What kind of control a ref finds; runs inside the page. */
function domKind(el: Element): DomKind {
  const input = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return "select";
  if (tag === "textarea") return "text";
  if (tag !== "input") return "custom";
  if (input.type === "file") return "file";
  if (input.type === "radio") return "radio";
  if (input.type === "checkbox") return "checkbox";
  if (input.type === "date" || input.type === "month") return "date";
  if (
    el.getAttribute("role") === "combobox" ||
    /^(list|both)$/.test(el.getAttribute("aria-autocomplete") ?? "") ||
    input.list
  )
    return "combobox";
  return "text";
}

/** What a field shows now ("" when empty); runs inside the page. */
export function shownValue(selector: string): string {
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const all = [...document.querySelectorAll<HTMLElement>(selector)];
  const el = all[0];
  if (!el) return "";
  const input = el as HTMLInputElement;
  if (el.tagName === "SELECT") {
    const select = el as unknown as HTMLSelectElement;
    return [...select.selectedOptions]
      .filter((o) => o.value !== "")
      .map((o) => o.text.trim())
      .join(", ");
  }
  if (input.type === "radio" || input.type === "checkbox") {
    const label = (i: HTMLInputElement) =>
      text(i.labels?.[0]) || text(i.closest("label")) || i.value;
    return all
      .map((i) => i as HTMLInputElement)
      .filter((i) => i.checked)
      .map(label)
      .join(", ");
  }
  if (input.type === "file")
    return [...(input.files ?? [])].map((f) => f.name).join(", ");
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return text(el);
  if (input.value) return input.value;
  // A searchable dropdown shows its pick beside the (emptied) input, often a level or two up
  // (react-select: a sibling of the input's own container). Stops at the next field.
  let box = el.parentElement;
  for (let depth = 0; box && depth < 5; depth++, box = box.parentElement) {
    if (box.querySelectorAll("input:not([aria-hidden='true']), select, textarea").length > 1)
      break;
    const picked = box.querySelector(
      "[class*='singleValue' i], [class*='single-value' i], [class*='selected' i], [class*='chip' i], [class*='tag' i]",
    );
    if (picked) return text(picked);
  }
  return "";
}

export class GenericDriver extends TrustedDriver {
  readonly system = "generic" as const;
  protected readonly errorSelector =
    "[role='alert'], .error-message, .field-error, .invalid-feedback, [class*='errorMessage' i]";
  /** Set by the run: a search that finds nothing worded like your answer. */
  chooser: Chooser | null = null;

  /** Attaches to the frame with the most form fields (forms are often in an iframe). */
  static async attach(page: Page): Promise<GenericDriver | null> {
    const deadline = Date.now() + FORM_WAIT_MS;
    while (Date.now() < deadline) {
      let best: { frame: Frame; count: number } | null = null;
      for (const frame of page.frames()) {
        const count = await frame
          .$$eval("input:not([type=hidden]), select, textarea", (l) => l.length)
          .catch(() => 0);
        if (count > 0 && (!best || count > best.count)) best = { frame, count };
      }
      if (best) return new GenericDriver(page, best.frame);
      await sleep(400);
    }
    return null;
  }

  protected boxFor(ref: string): string {
    return ref;
  }

  step(): Promise<string> {
    return this.frame.evaluate(genericStep).catch(() => "");
  }

  readPage(): Promise<GenericPage> {
    return this.frame.evaluate(readGenericPage);
  }

  /** Workday's Add buttons; nothing to add on a company's own page. */
  async addEntries(): Promise<void> {}

  async fill(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    resume?: ResumeFile,
  ): Promise<FillOutcome> {
    if (value === null) return { ok: false, reason: "Nothing to fill" };
    const wanted = Array.isArray(value) ? value : [value as string];
    try {
      const kind = await this.frame.$eval(entry.ref, domKind).catch(() => null);
      if (!kind)
        return { ok: false, reason: "Field not found on the page; fill it yourself" };
      if (kind === "file")
        return resume
          ? await this.attachFile(entry.ref, resume)
          : { ok: false, reason: "Tailored PDF not loaded" };
      return await this.fillKind(entry, kind, wanted);
    } catch (error) {
      return failed(error);
    }
  }

  private async fillKind(
    entry: PlanEntry,
    kind: DomKind,
    wanted: readonly string[],
  ): Promise<FillOutcome> {
    const first = wanted[0] ?? "";
    switch (kind) {
      case "select":
        return this.select(entry.ref, first);
      case "radio":
      case "checkbox":
        return this.choose(entry.ref, wanted);
      case "date":
        return { ok: false, reason: "A date picker" };
      case "combobox":
        return this.combobox(entry.ref, first);
      case "custom":
        return this.custom(entry.ref, first);
      default: {
        const input = await this.frame.$(entry.ref);
        if (!input) return { ok: false, reason: "Field not found on the page" };
        const phone = await input.evaluate((el) => (el as HTMLInputElement).type === "tel");
        return this.typeText(input, wanted.join(", "), phone);
      }
    }
  }

  /** A native select: the best-matching option, by its own value. */
  private async select(ref: string, wanted: string): Promise<FillOutcome> {
    const handle = await this.frame.$(ref);
    if (!handle) return { ok: false, reason: "Dropdown not found" };
    const options = await handle.evaluate((el) =>
      [...(el as HTMLSelectElement).options].map((o) => ({ text: o.text.trim(), value: o.value })),
    );
    const index = bestOption(
      options.map((o) => (o.value === "" ? "" : o.text)),
      wanted,
    );
    const option = index === null ? undefined : options[index];
    if (!option) return { ok: false, reason: `No choice matching "${wanted}"` };
    await handle.select(option.value);
    return this.verify(ref, option.text);
  }

  /** Radios and checkboxes: clicks the matching ones (a lone checkbox: ticks it). */
  private async choose(ref: string, wanted: readonly string[]): Promise<FillOutcome> {
    const inputs = await this.frame.$$(ref);
    const labels = await Promise.all(
      inputs.map((i) =>
        i.evaluate((el) => {
          const input = el as HTMLInputElement;
          return (
            input.labels?.[0]?.textContent ??
            input.closest("label")?.textContent ??
            input.getAttribute("aria-label") ??
            input.value
          )
            .replace(/\s+/g, " ")
            .trim();
        }),
      ),
    );
    const targets =
      inputs.length === 1
        ? [0]
        : wanted.flatMap((w) => {
            const i = bestOption(labels, w);
            return i === null ? [] : [i];
          });
    if (!targets.length)
      return { ok: false, reason: `No choice matching "${wanted.join(", ")}"` };
    for (const index of targets) {
      const input = inputs[index];
      if (!input || (await input.evaluate((el) => (el as HTMLInputElement).checked)))
        continue;
      await input.click().catch(() => input.evaluate((el) => (el as HTMLElement).click()));
      await sleep(150);
    }
    const shown = await this.readBackRef(ref);
    const picked = targets.map((i) => labels[i] ?? "");
    return picked.every((p) => selectionMatches(shown, p))
      ? { ok: true, result: `picked ${picked.map((p) => `"${p}"`).join(", ")}` }
      : { ok: false, reason: `"${picked.join(", ")}" didn't stay selected` };
  }

  /** A searchable dropdown: type, then pick the best choice that shows (Enter if none). */
  private async combobox(ref: string, wanted: string): Promise<FillOutcome> {
    const input = await this.frame.$(ref);
    if (!input) return { ok: false, reason: "Field not found on the page" };
    if (selectionMatches(await this.readBackRef(ref), wanted))
      return { ok: true, result: "already set" };
    await input.click().catch(() => undefined);
    await input.evaluate((el) => {
      const box = el as HTMLInputElement;
      box.focus();
      box.select();
    });
    await this.page.keyboard.press("Backspace");
    await this.page.keyboard.sendCharacter(wanted.slice(0, 80));
    const picked = await pickOpenChoice(this.frame, wanted);
    if (!picked) await this.page.keyboard.press("Enter");
    await sleep(200);
    return this.verify(ref, picked ?? wanted);
  }

  /** A dropdown that isn't a select (a div with role=combobox): open it and pick. */
  private async custom(ref: string, wanted: string): Promise<FillOutcome> {
    const handle = await this.frame.$(ref);
    if (!handle) return { ok: false, reason: "Field not found on the page" };
    if (selectionMatches(await this.readBackRef(ref), wanted))
      return { ok: true, result: "already set" };
    await handle.click();
    const picked = await pickOpenChoice(this.frame, wanted);
    if (!picked) {
      await this.page.keyboard.press("Escape");
      return { ok: false, reason: `No choice matching "${wanted}"` };
    }
    return this.verify(ref, picked);
  }

  private async verify(ref: string, expected: string): Promise<FillOutcome> {
    const shown = await this.readBackRef(ref);
    return showsValue(shown, expected)
      ? { ok: true, result: `set to "${shown.slice(0, 60)}"` }
      : { ok: false, reason: `Shows "${shown.slice(0, 40) || "nothing"}" instead` };
  }

  private readBackRef(ref: string): Promise<string> {
    return this.frame.evaluate(shownValue, ref).catch(() => "");
  }

  async readBack(entry: PlanEntry): Promise<string> {
    return this.readBackRef(entry.ref);
  }
}
