import type {
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { pickOpenChoice, showsValue, visibleChoices } from "./site-help";
import type { PlanEntry } from "./supervisor";
import {
  bestOption,
  type FillOutcome,
  FORM_WAIT_MS,
  failed,
  READ_MS,
  type ResumeFile,
  selectionMatches,
  sleep,
  TrustedDriver,
  within,
} from "./trusted";
import type { Chooser, EntriesToAdd } from "./workday-driver";

/** How long a block added with the site's Add More may take to appear (or the page to reload). */
const ADD_WAIT_MS = 10_000;

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
  /** The repeated group it sits in (iCIMS: one fieldset per job, "Professional Experience (2)"). */
  readonly block?: { readonly id: string; readonly heading: string };
  /** What it shows now (a block the site filled from your uploaded resume). */
  readonly value?: string;
}

/** A dropdown's prompt, not a choice ("— Make a Selection —", "Select…"). */
export const PLACEHOLDER =
  /^[\s—–\-.…]*(make a selection|select( one| an option)?|choose( one| an option)?|please (select|choose)( one)?|none selected|type to search|no \w+ available)[\s—–\-.…]*$/i;

/** A search box is cleared key by key; longer text than this isn't a dropdown's. */
const MAX_CLEAR_CHARS = 120;

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
  // At most 200 characters, as the server takes it: the address cut, the heading kept.
  return `${location.pathname.slice(0, 76)}${heading ? ` · ${heading.slice(0, 120)}` : ""}`;
}

/** The page's fields; runs inside the page, so it stays self-contained. */
export function readGenericPage(): GenericPage {
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const SKIP = /^(hidden|submit|button|reset|image|password|search)$/i;
  const CAPTCHA = /recaptcha|hcaptcha|turnstile/i;
  // Words a widget calls itself, not the question ("textbox", "Drop or select (.pdf)").
  const GENERIC =
    /^(textbox|text|input|search|select|combobox|listbox|choose file|upload|drop or select\b.*)$/i;
  const meaningful = (t: string | null | undefined) =>
    t && !GENERIC.test(t.trim()) ? t.trim() : "";
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };
  /** The elements it names as its label; screen-reader-only ones ("0 files selected") only if nothing else. */
  const labelledBy = (el: Element | null | undefined) => {
    const named = (el?.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id) : null))
      .filter((e): e is HTMLElement => e !== null);
    const visible = named.filter(shown);
    return (visible.length ? visible : named).map(text).join(" ").trim();
  };
  /**
   * No label at all (Rippling's custom questions): the text just above the field, from the
   * nearest earlier block that isn't another field.
   */
  const questionAbove = (el: HTMLElement): string => {
    let node: Element | null = el;
    for (let depth = 0; node && depth < 5; depth++) {
      let prev = node.previousElementSibling;
      for (let hops = 0; prev && hops < 2; hops++) {
        if (prev.querySelector("input, select, textarea, [role='combobox']"))
          return "";
        const said = text(prev).replace(/\s*\*$/, "");
        if (said && !/^\d+\s*\/\s*\d+$/.test(said)) return said;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  };
  const labelOf = (el: HTMLElement): string => {
    const input = el as HTMLInputElement;
    const own = input.labels?.[0] ?? el.closest("label");
    const box = el.closest(
      "fieldset, [role='group'], [role='radiogroup'], .field, [class*='field' i], [class*='question' i]",
    );
    const group =
      input.type === "radio" || (input.type === "checkbox" && input.name)
        ? text(box?.querySelector("legend, [class*='label' i], label"))
        : "";
    return (
      group ||
      labelledBy(el) ||
      labelledBy(own) ||
      meaningful(text(own)) ||
      meaningful(el.getAttribute("aria-label")) ||
      text(box?.querySelector("label, legend")) ||
      questionAbove(el) ||
      meaningful(el.getAttribute("placeholder")) ||
      el.getAttribute("name") ||
      ""
    ).slice(0, 300);
  };
  // New marks after those already on the page: a redrawn field mustn't take a kept one's.
  let counter =
    Math.max(
      -1,
      ...[...document.querySelectorAll("[data-ac-ref]")].map(
        (e) => Number(e.getAttribute("data-ac-ref")?.slice(2)) || 0,
      ),
    ) + 1;
  const refOf = (el: HTMLElement, group: string | null): string => {
    if (group) return `input[name="${group.replace(/["\\]/g, "\\$&")}"]`;
    if (
      el.id &&
      document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1
    )
      return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (
      name &&
      document.querySelectorAll(`[name="${CSS.escape(name)}"]`).length === 1
    )
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
  // Kept in step with PLACEHOLDER (this runs inside the page, on its own).
  const PROMPT =
    /^[\s—–\-.…]*(make a selection|select( one| an option)?|choose( one| an option)?|please (select|choose)( one)?|none selected|type to search|no \w+ available)[\s—–\-.…]*$/i;
  const fieldsets = [...document.querySelectorAll("fieldset")];
  /** The fieldset with a heading it sits in: a job or degree on iCIMS. */
  const fieldsetBlockOf = (el: HTMLElement) => {
    const box = el.closest("fieldset");
    const legend = box?.querySelector(":scope > legend");
    // "Professional Experience (2)* required." → "Professional Experience (2)"
    const heading = text(legend).replace(/\s*\*.*$/, "").trim();
    if (!box || !heading) return undefined;
    return {
      id: box.id || legend?.id || `fieldset-${fieldsets.indexOf(box)}`,
      heading: heading.slice(0, 200),
    };
  };
  // Numbered entries without a fieldset (Greenhouse: "company-name-0", "current-role-0_1" in a
  // form headed "Employment"): the entry is the number, the heading the section's above it.
  const SECTION = /experience|employment|work history|education|academic/i;
  const ENTRY = /[-_](\d{1,2})(?:_\d+)?$/;
  const entryOf = (el: Element) =>
    [el.id, el.getAttribute("name") ?? ""]
      .map((s) => ENTRY.exec(s)?.[1])
      .find((n) => n !== undefined);
  const numberedBlockOf = (el: HTMLElement) => {
    const entry = entryOf(el);
    if (entry === undefined) return undefined;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++) {
      // Up to the section only: a named field without a number means the whole form.
      const unnumbered = [
        ...node.querySelectorAll("input, select, textarea"),
      ].some(
        (f) =>
          (f.id || f.getAttribute("name")) &&
          f.getAttribute("type") !== "hidden" &&
          entryOf(f) === undefined,
      );
      if (unnumbered) return undefined;
      const head = [
        ...node.querySelectorAll("h2, h3, h4, h5, h6, legend, p"),
      ].find(
        (h) =>
          h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
          text(h).length < 40 &&
          SECTION.test(text(h)),
      );
      if (head) return { id: `${text(head)}-${entry}`, heading: text(head) };
      node = node.parentElement;
    }
    return undefined;
  };
  /** The job or degree a field belongs to: a fieldset with a heading, or a numbered entry. */
  const blockOf = (el: HTMLElement) => fieldsetBlockOf(el) ?? numberedBlockOf(el);
  /** What a field shows now: typed text, the picked option, a dropdown's shown pick. */
  const valueOf = (el: HTMLElement, tag: string): string => {
    const input = el as HTMLInputElement;
    if (input.type === "radio" || input.type === "checkbox") return "";
    if (input.type === "file") return "";
    const raw =
      tag === "select"
        ? [...(el as unknown as HTMLSelectElement).selectedOptions]
            .filter((o) => o.value !== "")
            .map((o) => o.text)
            .join(", ")
        : tag === "input" || tag === "textarea"
          ? input.value
          : text(el);
    const value = raw.replace(/\s+/g, " ").trim();
    return PROMPT.test(value) ? "" : value.slice(0, 300);
  };

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
    // A help chat's own inputs (Oracle's chatbot takes files): not the application.
    if (el.closest("[class*='chat' i], [id*='chat' i]")) continue;
    if (/one-time-code/i.test(el.getAttribute("autocomplete") ?? "")) continue;
    if (input.disabled || input.readOnly) continue;
    // A dropdown's stand-in for the browser's "required" check (react-select), and captcha tokens.
    if (el.getAttribute("aria-hidden") === "true" && input.type !== "file")
      continue;
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
        .map((o) => o.text.trim())
        .filter((o) => o !== "" && !PROMPT.test(o));
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
    const block = blockOf(el);
    const value = valueOf(el, tag);
    fields.push({
      ref,
      key: el.getAttribute("name") || el.id || ref,
      label: label.replace(/\s*\*\s*$/, "").trim(),
      kind,
      required,
      options: options.map((o) => o.slice(0, 300)).slice(0, 500),
      ...(block ? { block } : {}),
      ...(value ? { value } : {}),
    });
  }
  const heading = [...document.querySelectorAll("h1, h2")]
    .find((h) => (h as HTMLElement).offsetParent !== null)
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return {
    system: "generic",
    // As genericStep: at most 200 characters.
    step: `${location.pathname.slice(0, 76)}${heading ? ` · ${heading.slice(0, 120)}` : ""}`,
    fields,
    sections: [],
  };
}

/**
 * After a dropdown opened: the search box it opened, focused (true), or none. Its own box, the
 * one it points to (aria-owns / aria-controls), or one just beside it. Runs inside the page.
 */
export function focusSearchBox(ref: string): boolean {
  const field = document.querySelector<HTMLElement>(ref);
  if (!field) return false;
  // Only a box that says it's a search ("— Type to Search —"), never a neighbouring field.
  const isSearch = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement &&
    el !== field &&
    /^(text|search)$/.test(el.type) &&
    el.getClientRects().length > 0 &&
    (el.getAttribute("role") === "combobox" ||
      /search|filter/i.test(
        `${el.type} ${el.className} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""}`,
      ));
  if (isSearch(document.activeElement)) return true;
  const owned = ["aria-owns", "aria-controls"]
    .map((name) => field.getAttribute(name))
    .flatMap((ids) => (ids ?? "").split(/\s+/))
    .map((id) => (id ? document.getElementById(id) : null));
  const near = [field.nextElementSibling, field.parentElement, ...owned];
  for (const box of near) {
    const found = [box, ...(box?.querySelectorAll("input") ?? [])].find(isSearch);
    if (found) {
      found.focus();
      return true;
    }
  }
  return false;
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
  // A dropdown showing its prompt ("— Make a Selection —") shows nothing picked (as PLACEHOLDER).
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
    const said = text(el);
    return /^[\s—–\-.…]*(make a selection|select( one| an option)?|choose( one| an option)?|please (select|choose)( one)?|none selected|type to search|no \w+ available)[\s—–\-.…]*$/i.test(
      said,
    )
      ? ""
      : said;
  }
  if (input.value) return input.value;
  // A searchable dropdown shows its picks beside the (emptied) input, often a level or two up
  // (react-select: a sibling of the input's own container; a typeahead's tokens). Every pick
  // of a multi-select, without its remove button. Stops at the next field.
  let box = el.parentElement;
  for (let depth = 0; box && depth < 5; depth++, box = box.parentElement) {
    if (
      box.querySelectorAll("input:not([aria-hidden='true']), select, textarea")
        .length > 1
    )
      break;
    const found = [
      ...box.querySelectorAll(
        "[class*='singleValue' i], [class*='single-value' i], [class*='selected' i], [class*='chip' i], [class*='tag' i], [class*='token' i]",
      ),
    ].filter((p) => !p.closest("button"));
    const picks = found.filter(
      (p) => !found.some((o) => o !== p && o.contains(p)),
    );
    if (picks.length)
      return picks
        .map((p) => {
          const copy = p.cloneNode(true) as Element;
          for (const extra of copy.querySelectorAll(
            "button, .sr-only, .visually-hidden, [aria-hidden='true']",
          ))
            extra.remove();
          return text(copy);
        })
        .filter(Boolean)
        .join(", ");
  }
  return "";
}

const FIELD_COUNT_MS = 3_000;

function fieldCount(frame: Frame): Promise<number> {
  if (frame.detached) return Promise.resolve(0);
  return within(
    () => frame.$$eval("input:not([type=hidden]), select, textarea", (l) => l.length),
    FIELD_COUNT_MS,
  ).catch(() => 0);
}

/** The frame with the most form fields now, if any has one. */
async function formFrame(
  page: Page,
): Promise<{ frame: Frame; count: number } | null> {
  let best: { frame: Frame; count: number } | null = null;
  for (const frame of page.frames()) {
    const count = await fieldCount(frame);
    if (count > 0 && (!best || count > best.count)) best = { frame, count };
  }
  return best;
}

export class GenericDriver extends TrustedDriver {
  readonly system = "generic" as const;
  protected readonly errorSelector =
    "[role='alert'], .error-message, .field-error, .invalid-feedback, [class*='errorMessage' i]";
  /** Set by the run: a search that finds nothing worded like your answer. */
  chooser: Chooser | null = null;

  /** The form another driver (Greenhouse, Ashby…) is on: fields its plan doesn't cover. */
  static on(where: { readonly page: Page; readonly frame: Frame }): GenericDriver {
    return new GenericDriver(where.page, where.frame);
  }

  /**
   * Reading only what's left: fields outside the boxes another driver's plan covers (marked
   * data-ac-site) that are still empty (a box ticked, a choice picked or text typed is kept).
   */
  onlyOpen = false;

  /** Attaches to the frame with the most form fields (forms are often in an iframe). */
  static async attach(page: Page): Promise<GenericDriver | null> {
    const deadline = Date.now() + FORM_WAIT_MS;
    while (Date.now() < deadline) {
      const best = await formFrame(page);
      if (best) return new GenericDriver(page, best.frame);
      await sleep(400);
    }
    return null;
  }

  /**
   * The form moved to another frame: signing in (iCIMS through LinkedIn) reloads the page and
   * its iframe, and the frame read before is gone or blank. True when the run now reads another.
   */
  async findFormFrame(): Promise<boolean> {
    if (!this.frame.detached && (await fieldCount(this.frame)) > 0) return false;
    const best = await formFrame(this.page);
    if (!best || best.frame === this.frame) return false;
    this.frame = best.frame;
    this.lastRefs = [];
    return true;
  }

  protected boxFor(ref: string): string {
    return ref;
  }

  step(): Promise<string> {
    return within(() => this.frame.evaluate(genericStep), READ_MS).catch(() => "");
  }

  /** The fields of the page last read, to notice when the site swaps them for the next part. */
  private lastRefs: readonly string[] = [];

  async readPage(): Promise<GenericPage> {
    const read = await within(() => this.frame.evaluate(readGenericPage), READ_MS);
    const page = this.onlyOpen ? { ...read, fields: await this.open(read.fields) } : read;
    this.lastRefs = page.fields.map((f) => f.ref);
    return page;
  }

  private async open(
    fields: readonly GenericField[],
  ): Promise<GenericField[]> {
    const taken = await within(
      () =>
        this.frame.evaluate(
          (refs) =>
            refs.filter((ref) => {
              const els = [...document.querySelectorAll<HTMLInputElement>(ref)];
              const el = els[0];
              if (!el || el.closest("[data-ac-site]")) return true;
              if (el.type === "radio" || el.type === "checkbox")
                return els.some((e) => e.checked);
              if (el.type === "file") return (el.files?.length ?? 0) > 0;
              return (el.value ?? "").trim() !== "";
            }),
          fields.map((f) => f.ref),
        ),
      READ_MS,
    ).catch(() => fields.map((f) => f.ref));
    const skip = new Set(taken);
    return fields.filter((f) => !skip.has(f.ref) && !f.value);
  }

  /** The field (by this reader's ref) whose input is inside that box: another driver's field. */
  async refInside(box: string): Promise<string | null> {
    const page = await within(() => this.frame.evaluate(readGenericPage), READ_MS).catch(
      () => null,
    );
    if (!page) return null;
    return within(
      () =>
        this.frame.evaluate(
          (box, refs) => {
            let outer: Element | null;
            try {
              outer = document.querySelector(box);
            } catch {
              return null;
            }
            if (!outer) return null;
            return (
              refs.find((ref) => {
                const el = document.querySelector(ref);
                return el !== null && (el === outer || outer.contains(el));
              }) ?? null
            );
          },
          box,
          page.fields.map((f) => f.ref),
        ),
      READ_MS,
    ).catch(() => null);
  }

  /**
   * Most of the fields last read are gone or hidden: the form moved on in place (Next on a
   * one-address form, the address and heading unchanged). A field or two appearing doesn't count.
   */
  async swapped(): Promise<boolean> {
    if (!this.lastRefs.length) return false;
    const gone = await within(
      () => this.frame.evaluate(
        (refs) =>
          refs.filter((ref) => {
            const el = document.querySelector(ref);
            // Styled inputs are often hidden themselves: their wrapper shows.
            return (
              !el ||
              !(el.parentElement ?? el).checkVisibility({
                visibilityProperty: true,
              })
            );
          }).length,
        this.lastRefs,
      ),
      READ_MS,
    ).catch(() => 0);
    return gone * 2 > this.lastRefs.length;
  }

  /**
   * Fewer job blocks than jobs on your resume: clicks the site's "Add More (Professional
   * Experience)" until the section has that many more. iCIMS may reload the page for it: the
   * form is found again in its new frame.
   */
  async addEntries(add: readonly EntriesToAdd[]): Promise<void> {
    for (const { section, count } of add)
      for (let i = 0; i < count; i++) {
        const before = await this.blockCount(section);
        const button = await this.addButton(section);
        if (!button) break;
        await button.click();
        const deadline = Date.now() + ADD_WAIT_MS;
        let added = false;
        while (!added && Date.now() < deadline) {
          await sleep(400);
          await this.findFormFrame();
          added = (await this.blockCount(section)) > before;
        }
        if (!added) break;
      }
  }

  /** The section's blocks as the page reads them, each block's fields in page order. */
  private async sectionBlocks(section: string): Promise<string[][]> {
    const page = await within(
      () => this.frame.evaluate(readGenericPage),
      READ_MS,
    ).catch(() => null);
    const blocks = new Map<string, string[]>();
    for (const field of page?.fields ?? [])
      if (field.block?.heading.toLowerCase().startsWith(section.toLowerCase()))
        blocks.set(field.block.id, [
          ...(blocks.get(field.block.id) ?? []),
          field.ref,
        ]);
    return [...blocks.values()];
  }

  /** Blocks headed with the section's name ("Professional Experience (2)", "Employment"). */
  private async blockCount(section: string): Promise<number> {
    return (await this.sectionBlocks(section)).length;
  }

  /**
   * The visible "Add …" control for the section: one that names it ("Add More (Professional
   * Experience)", the last one below its blocks), or a plain "Add another" just after the
   * section's last block (Greenhouse).
   */
  private async addButton(section: string) {
    const last = (await this.sectionBlocks(section)).at(-1)?.at(-1) ?? null;
    const found = await within(
      () =>
        this.frame.evaluate(
          (name, lastRef) => {
            for (const el of document.querySelectorAll("[data-ac-add]"))
              el.removeAttribute("data-ac-add");
            const labelOf = (el: HTMLElement) =>
              (el.textContent || (el as HTMLInputElement).value || "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
            const adds = (root: ParentNode) =>
              [
                ...root.querySelectorAll<HTMLElement>(
                  "a, button, [role=button], input[type=button]",
                ),
              ].filter(
                (el) =>
                  /^add\b/.test(labelOf(el)) &&
                  el.checkVisibility({ visibilityProperty: true }),
              );
            let button = adds(document)
              .filter((el) => labelOf(el).includes(name.toLowerCase()))
              .at(-1);
            // Not named: the nearest one after the section's last field, close around it.
            const field = lastRef ? document.querySelector(lastRef) : null;
            let node = field?.parentElement ?? null;
            for (let depth = 0; !button && field && node && depth < 6; depth++) {
              button = adds(node).find(
                (el) =>
                  field.compareDocumentPosition(el) &
                    Node.DOCUMENT_POSITION_FOLLOWING &&
                  /^add (another|more|new)?\b/.test(labelOf(el)),
              );
              node = node.parentElement;
            }
            button?.setAttribute("data-ac-add", "1");
            return button !== undefined;
          },
          section,
          last,
        ),
      READ_MS,
    ).catch(() => false);
    return found ? this.frame.$("[data-ac-add='1']").catch(() => null) : null;
  }

  async fill(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    resume?: ResumeFile,
  ): Promise<FillOutcome> {
    if (value === null) return { ok: false, reason: "Nothing to fill" };
    const wanted = Array.isArray(value) ? value : [value as string];
    try {
      const kindOf = () =>
        this.frame.$eval(entry.ref, domKind).catch(() => null);
      let kind = await kindOf();
      if (!kind && (await this.refind(entry))) kind = await kindOf();
      if (!kind)
        return {
          ok: false,
          reason: "Field not found on the page; fill it yourself",
        };
      if (kind === "file") {
        if (!resume) return { ok: false, reason: "Tailored PDF not loaded" };
        // The page asked again (its heading changed): attaching twice adds a second copy.
        if (await this.hasFile(entry.ref, resume.name))
          return { ok: true, result: "already attached" };
        return await this.attachFile(entry.ref, resume);
      }
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
        return this.select(entry.ref, first, entry.alternatives);
      case "radio":
      case "checkbox":
        return this.choose(entry.ref, wanted);
      case "date":
        return { ok: false, reason: "A date picker" };
      case "combobox":
        return this.combobox(entry, wanted);
      case "custom":
        return this.custom(entry, wanted);
      default: {
        const input = await this.frame.$(entry.ref);
        if (!input) return { ok: false, reason: "Field not found on the page" };
        const phone = await input.evaluate(
          (el) => (el as HTMLInputElement).type === "tel",
        );
        const typed = await this.typeText(input, wanted.join(", "), phone);
        // A picker that looks like a text box: its list opens when you click it.
        return typed.ok
          ? typed
          : ((await this.chooseFromList(entry, wanted)) ?? typed);
      }
    }
  }

  /** A native select: the best-matching option, by its own value. */
  private async select(
    ref: string,
    wanted: string,
    alternatives: readonly string[] = [],
  ): Promise<FillOutcome> {
    const handle = await this.frame.$(ref);
    if (!handle) return { ok: false, reason: "Dropdown not found" };
    const options = await handle.evaluate((el) =>
      [...(el as HTMLSelectElement).options].map((o) => ({
        text: o.text.trim(),
        value: o.value,
      })),
    );
    const labels = options.map((o) => (o.value === "" ? "" : o.text));
    const index = [wanted, ...alternatives]
      .map((w) => bestOption(labels, w))
      .find((i): i is number => i !== null);
    const option = index === undefined ? undefined : options[index];
    if (!option) return { ok: false, reason: `No choice matching "${wanted}"` };
    await handle.select(option.value);
    return this.verify(ref, option.text);
  }

  /** Radios and checkboxes: clicks the matching ones (a lone checkbox: ticks it). */
  private async choose(
    ref: string,
    wanted: readonly string[],
  ): Promise<FillOutcome> {
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
      if (
        !input ||
        (await input.evaluate((el) => (el as HTMLInputElement).checked))
      )
        continue;
      await input
        .click()
        .catch(() => input.evaluate((el) => (el as HTMLElement).click()));
      await sleep(150);
    }
    const shown = await this.readBackRef(ref);
    const picked = targets.map((i) => labels[i] ?? "");
    return picked.every((p) => selectionMatches(shown, p))
      ? { ok: true, result: `picked ${picked.map((p) => `"${p}"`).join(", ")}` }
      : { ok: false, reason: `"${picked.join(", ")}" didn't stay selected` };
  }

  /**
   * A searchable dropdown: type, then pick the best choice that shows. None worded like your
   * answer: the list's own choices (Claude picks what fits you); no list at all: Enter.
   */
  private async combobox(
    entry: PlanEntry,
    all: readonly string[],
  ): Promise<FillOutcome> {
    const { ref } = entry;
    const wanted = all[0] ?? "";
    const input = await this.frame.$(ref);
    if (!input) return { ok: false, reason: "Field not found on the page" };
    if (selectionMatches(await this.readBackRef(ref), wanted))
      return { ok: true, result: "already set" };
    await input.click().catch(() => undefined);
    // Your answer, then the plan's fallbacks ("Other" when your school isn't listed).
    for (const candidate of [wanted, ...(entry.alternatives ?? [])]) {
      await this.clearSearch(ref);
      await this.page.keyboard.sendCharacter(candidate.slice(0, 80));
      const picked =
        (await pickOpenChoice(this.frame, candidate)) ??
        (await this.pickAfterEnter(candidate));
      if (picked) {
        await sleep(200);
        return this.verify(ref, picked);
      }
    }
    const chosen = await this.chooseFromList(entry, all);
    if (chosen) return chosen;
    await this.clearSearch(ref);
    await this.page.keyboard.sendCharacter(wanted.slice(0, 80));
    await this.page.keyboard.press("Enter");
    await sleep(200);
    return this.verify(ref, wanted);
  }

  /**
   * A dropdown that isn't a select (a div or link with role=combobox): open it and pick. Some
   * open a search box of their own and list choices only once you type (iCIMS: a state list
   * that loads for the country picked): type your answer there, then the plan's fallbacks.
   */
  private async custom(
    entry: PlanEntry,
    all: readonly string[],
  ): Promise<FillOutcome> {
    const { ref } = entry;
    const wanted = all[0] ?? "";
    const handle = await this.frame.$(ref);
    if (!handle) return { ok: false, reason: "Field not found on the page" };
    if (selectionMatches(await this.readBackRef(ref), wanted))
      return { ok: true, result: "already set" };
    await handle.click();
    await sleep(250);
    if (await this.frame.evaluate(focusSearchBox, ref).catch(() => false)) {
      for (const candidate of [wanted, ...(entry.alternatives ?? [])]) {
        await this.retype(candidate);
        const found =
          (await pickOpenChoice(this.frame, candidate)) ??
          (await this.pickAfterEnter(candidate));
        if (found) return this.verify(ref, found);
      }
      await this.retype("");
    } else {
      const picked = await pickOpenChoice(this.frame, wanted);
      if (picked) return this.verify(ref, picked);
    }
    const chosen = await this.chooseFromList(entry, all);
    if (chosen) return chosen;
    await this.page.keyboard.press("Escape");
    return { ok: false, reason: `No choice matching "${wanted}"` };
  }

  /**
   * Typed, and nothing is listed: some lists search only on Enter (iCIMS's state list, a school
   * search). Enter once, then pick. Never while choices show: Enter would pick one of them.
   */
  private async pickAfterEnter(candidate: string): Promise<string | null> {
    if ((await visibleChoices(this.frame, 300)).length) return null;
    await this.page.keyboard.press("Enter");
    return pickOpenChoice(this.frame, candidate);
  }

  /** Replaces what the focused search box holds with this text. */
  private async retype(text: string): Promise<void> {
    const length = await this.frame
      .evaluate(
        () => (document.activeElement as HTMLInputElement | null)?.value?.length ?? 0,
      )
      .catch(() => 0);
    await this.page.keyboard.press("End");
    for (let i = 0; i < Math.min(length, MAX_CLEAR_CHARS); i++)
      await this.page.keyboard.press("Backspace");
    if (text) await this.page.keyboard.sendCharacter(text.slice(0, 80));
  }

  /**
   * Clears what a search box shows, key by key from its end: a dropdown that moves the caret
   * as it opens (Oracle's) ignores a select-all, and typing then lands after the old value
   * ("DR.Mr."). Never Backspace in an empty one: it removes a tag.
   */
  private async clearSearch(ref: string): Promise<void> {
    const length = await this.frame
      .$eval(ref, (el) => {
        const input = el as HTMLInputElement;
        input.focus();
        return input.value?.length ?? 0;
      })
      .catch(() => 0);
    if (!length) return;
    await this.page.keyboard.press("End");
    for (let i = 0; i < Math.min(length, MAX_CLEAR_CHARS); i++)
      await this.page.keyboard.press("Backspace");
  }

  /**
   * A field the page drew again (Oracle redraws its form after a resume import) loses the mark
   * it was found by: finds it again by its label, alone on the page, and marks it the same.
   */
  private async refind(entry: PlanEntry): Promise<boolean> {
    const mark = /^\[data-ac-ref="(ac\d+)"\]$/.exec(entry.ref)?.[1];
    if (!mark) return false;
    const page = await this.frame.evaluate(readGenericPage).catch(() => null);
    const same = page?.fields.filter((f) => f.label === entry.label) ?? [];
    const found = same.length === 1 ? same[0] : undefined;
    if (!found || found.ref === entry.ref) return false;
    return this.frame
      .evaluate(
        (ref, mark) => {
          const el = document.querySelector(ref);
          el?.setAttribute("data-ac-ref", mark);
          return el !== null;
        },
        found.ref,
        mark,
      )
      .catch(() => false);
  }

  /** The file is already listed beside this upload (attached earlier in the run). */
  private hasFile(ref: string, name: string): Promise<boolean> {
    return this.frame
      .$eval(
        ref,
        (el, name) => {
          let box = el.parentElement;
          for (
            let depth = 0;
            box && depth < 4;
            depth++, box = box.parentElement
          )
            if ((box.textContent ?? "").includes(name)) return true;
          return false;
        },
        name,
      )
      .catch(() => false);
  }

  /**
   * None of the field's choices is worded like your answer (or it's a picker that looked like
   * a text box): reads the choices its list shows, and picks by our ranking or else asks Claude,
   * who picks what fits you from your answer, saved answers and resume. What's already picked
   * counts as a choice. Null when no list opens.
   */
  private async chooseFromList(
    entry: PlanEntry,
    wanted: readonly string[],
  ): Promise<FillOutcome | null> {
    const { ref } = entry;
    const handle = await this.frame.$(ref);
    if (!handle) return null;
    await this.clearSearch(ref);
    let choices = await visibleChoices(this.frame, 600);
    if (!choices.length) {
      await handle.click().catch(() => undefined);
      choices = await visibleChoices(this.frame, 1_500);
    }
    if (!choices.length) {
      await this.page.keyboard.press("ArrowDown");
      choices = await visibleChoices(this.frame, 1_000);
    }
    // A list's prompt row ("— Make a Selection —") is never a choice.
    choices = choices.filter((c) => !PLACEHOLDER.test(c));
    if (!choices.length) {
      await this.page.keyboard.press("Escape");
      return null;
    }
    const shown = await this.readBackRef(ref);
    const ours = wanted
      .map((w) => bestOption(choices, w))
      .find((i): i is number => i !== null);
    let choice = ours === undefined ? null : (choices[ours] ?? null);
    const byClaude = !choice;
    if (!choice && this.chooser) {
      const picked = shown ? shown.split(/,\s*/) : [];
      choice = await this.chooser(
        entry.label,
        wanted.join(", "),
        [...new Set([...picked, ...choices])].slice(0, 300),
      ).catch(() => null);
    }
    if (!choice) {
      await this.page.keyboard.press("Escape");
      return null;
    }
    const how = byClaude
      ? `Claude picked "${choice}" from the field's choices (your answer: "${wanted.join(", ").slice(0, 60)}")`
      : `picked "${choice}"`;
    if (selectionMatches(shown, choice)) {
      await this.page.keyboard.press("Escape");
      return { ok: true, result: `${how}; already selected` };
    }
    if (!(await pickOpenChoice(this.frame, choice))) {
      await this.page.keyboard.press("Escape");
      return {
        ok: false,
        reason: `"${choice}" couldn't be picked from the list`,
      };
    }
    await sleep(200);
    return selectionMatches(await this.readBackRef(ref), choice)
      ? { ok: true, result: how }
      : { ok: false, reason: `"${choice}" wasn't selected` };
  }

  private async verify(ref: string, expected: string): Promise<FillOutcome> {
    const shown = await this.readBackRef(ref);
    return showsValue(shown, expected)
      ? { ok: true, result: `set to "${shown.slice(0, 60)}"` }
      : {
          ok: false,
          reason: `Shows "${shown.slice(0, 40) || "nothing"}" instead`,
        };
  }

  private readBackRef(ref: string): Promise<string> {
    return this.frame.evaluate(shownValue, ref).catch(() => "");
  }

  async readBack(entry: PlanEntry): Promise<string> {
    return this.readBackRef(entry.ref);
  }
}
