import type {
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { equivalentTerms } from "./equivalents";
import { bestFound, bestOptionAmong, searchWords } from "./options";
import { deepFind, ensureLocator, entrySaves } from "./locate";
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
import type { Chooser, EntriesToAdd, SearchTerms } from "./workday-driver";
import {
  type DomKind,
  domKind,
  focusSearchBox,
  type GenericField,
  type GenericPage,
  genericStep,
  PLACEHOLDER,
  readGenericPage,
  shownValue,
} from "./generic-page";

/** How many other wordings of an answer a search list is tried with before asking Claude. */
const MAX_EQUIVALENT_SEARCHES = 4;

export {
  focusSearchBox,
  type GenericField,
  type GenericKind,
  type GenericPage,
  genericStep,
  PLACEHOLDER,
  readGenericPage,
  shownValue,
} from "./generic-page";

/** How long a block added with the site's Add More may take to appear (or the page to reload). */
const ADD_WAIT_MS = 10_000;

/**
 * Any company's own application page (no known system). Fields are read generically (labels,
 * kinds, choices), planned like every other form, and filled with trusted input. A field it
 * can't fill by itself goes to this site's saved steps, then Claude (site-help.ts), like on
 * every other system.
 */

/** A search box is cleared key by key; longer text than this isn't a dropdown's. */
const MAX_CLEAR_CHARS = 120;
/** A tag box that only takes its suggestions: how long each item waits for its list. */
const TAG_LIST_WAIT_MS = 2_500;
/** Typed a key at a time there, as its search listens for keys. */
const TAG_KEY_DELAY_MS = 30;
/** Items its list suggests nothing for, with none added yet, before it's given up on. */
const MAX_UNLISTED_TAGS = 3;
/** How long one search of a list (searching everything) waits for its choices. */
const SEARCH_LIST_MS = 1_500;
/** What a search list shows when it finds nothing: never a choice. */
const NO_RESULTS = /^no (results?|matches|options|items)( found)?\.?$/i;

const FIELD_COUNT_MS = 3_000;
/** After a button that shows hidden fields: their time to appear. */
const REVEAL_WAIT_MS = 700;

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

/** A field inside a web component (marked "acs…"): found through the page's shadow roots. */
/** Refs found only inside web components after the page was read (a selector Claude gave). */
const piercedRefs = new Set<string>();
export const deep = (ref: string): string =>
  ref.includes('data-ac-ref="acs') || piercedRefs.has(ref) ? `pierce/${ref}` : ref;

export class GenericDriver extends TrustedDriver {
  readonly system = "generic" as const;
  protected readonly errorSelector =
    "[role='alert'], .error-message, .field-error, .invalid-feedback, [class*='errorMessage' i]";
  /** Set by the run: a search that finds nothing worded like your answer. */
  chooser: Chooser | null = null;
  /** Set by the run: broader words to search a list for when your answer's own find nothing. */
  searchTerms: SearchTerms | null = null;

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
              const els = (() => { const light = [...document.querySelectorAll<HTMLInputElement>(ref)]; return light.length ? light : (((window as unknown as { __acDeepAll?: (s: string) => Element[] }).__acDeepAll?.(ref) ?? []) as HTMLInputElement[]); })();
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
                const el = (document.querySelector(ref) ?? (window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(ref) ?? null);
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
            const el = (document.querySelector(ref) ?? (window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(ref) ?? null);
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
            // "+ Add Experience Details": the leading "+" (or an icon's text) isn't the word.
            const labelOf = (el: HTMLElement) =>
              (el.textContent || (el as HTMLInputElement).value || "")
                .replace(/\s+/g, " ")
                .trim()
                .replace(/^[^a-z]+/i, "")
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
            const field = lastRef ? (document.querySelector(lastRef) ?? (window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(lastRef) ?? null) : null;
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
        this.frame.$eval(deep(entry.ref), domKind).catch(() => null);
      let kind = await kindOf();
      if (!kind && (await this.refind(entry))) kind = await kindOf();
      // Not on the page itself: inside a web component, where Puppeteer's deep lookup finds it.
      if (!kind && !deep(entry.ref).startsWith("pierce/")) {
        const inside = await this.frame.$(`pierce/${entry.ref}`).catch(() => null);
        if (inside) {
          piercedRefs.add(entry.ref);
          kind = await kindOf();
        }
      }
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
      case "select": {
        const picked = await this.select(entry.ref, first, entry.alternatives, entry.label);
        if (picked.ok) return picked;
        // Hidden, it stands in for the page's own dropdown, whose list fills only as you use it
        // (iCIMS's State, listed once the country is picked there): that dropdown, as you would.
        const shown = await this.visibleStandIn(entry.ref);
        if (!shown) return picked;
        const used = await this.custom({ ...entry, ref: shown }, wanted);
        return used.ok
          ? used
          : { ok: false, reason: `${picked.reason}; its dropdown: ${used.reason}` };
      }
      case "radio":
      case "checkbox":
        return this.choose(entry.ref, wanted, entry.label);
      case "date":
        return this.datePicker(entry.ref, first);
      case "combobox":
        return this.combobox(entry, wanted);
      case "custom":
        // A formatted text editor (a contenteditable box): typed into, not a list.
        if (entry.widget === "rich-text" || (await this.isEditable(entry.ref)))
          return this.richText(entry.ref, wanted.join(", "));
        return this.custom(entry, wanted);
      default: {
        const input = await this.frame.$(deep(entry.ref));
        if (!input) return { ok: false, reason: "Field not found on the page" };
        // Claude's map says it suggests choices as you type (a city, a school): one is picked.
        if (entry.widget === "autocomplete" || entry.widget === "search") {
          const picked = await this.combobox(entry, wanted);
          if (picked.ok) return picked;
        }
        // Several answers into a box that collects tags (Keka's "Add new skill", or one
        // Claude's page map calls tags): one by one.
        if (
          wanted.join(", ").includes(",") &&
          (entry.widget === "tags" || (await this.isTagInput(entry.ref)))
        )
          return this.addTags(entry.ref, wanted.join(", "));
        // Claude's page map says it's a date picker: tried as one first.
        if (entry.widget === "date") {
          const picked = await this.datePicker(entry.ref, first);
          if (picked.ok) return picked;
        }
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

  /**
   * The visible dropdown a hidden select stands in for: iCIMS names it "<id>_icimsDropdown";
   * otherwise a combobox beside it. Null when the select is shown itself, or there's none.
   */
  private visibleStandIn(ref: string): Promise<string | null> {
    return within(
      () =>
        this.frame.$eval(deep(ref), (el) => {
          const shown = (e: Element) =>
            (e as HTMLElement).checkVisibility({ visibilityProperty: true });
          if (shown(el)) return null;
          const named = el.id
            ? document.getElementById(`${el.id}_icimsDropdown`)
            : null;
          const beside = el.parentElement?.querySelector(
            "[role='combobox'], [aria-haspopup='listbox']",
          );
          const widget = [named, beside].find(
            (w): w is HTMLElement => w instanceof HTMLElement && shown(w),
          );
          if (!widget) return null;
          if (widget.id) return `#${CSS.escape(widget.id)}`;
          widget.setAttribute("data-ac-standin", "1");
          return "[data-ac-standin='1']";
        }),
      READ_MS,
    ).catch(() => null);
  }

  /**
   * A date field: the browser's own date input set directly, or a jQuery UI date picker set
   * through the picker (its box is read-only). Anything else, or no date: a date picker for
   * saved steps or Claude.
   */
  private async datePicker(ref: string, wanted: string): Promise<FillOutcome> {
    // "2025-09-01", or a job's month as planned ("09/2025": its first day).
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(wanted.trim());
    const month = /^(\d{1,2})\/(\d{4})$/.exec(wanted.trim());
    const date = iso ?? (month ? [wanted, month[2], month[1], "1"] : null);
    if (!date) return { ok: false, reason: "A date picker" };
    const shown = await within(
      () =>
        this.frame.evaluate(
          (ref, y, m, d) => {
            const el =
              document.querySelector<HTMLInputElement>(ref) ??
              (((window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(ref) as HTMLInputElement | null | undefined) ?? null);
            if (!el) return "";
            if (el.type === "date") {
              const set = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
              )?.set;
              set?.call(el, `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return el.value;
            }
            const jq = (window as unknown as { jQuery?: (e: Element) => {
              datepicker?: (...args: unknown[]) => unknown;
              trigger: (event: string) => unknown;
            } }).jQuery;
            const picker = jq?.(el);
            if (!picker?.datepicker || !el.classList.contains("hasDatepicker")) return "";
            picker.datepicker("setDate", new Date(y, m - 1, d));
            picker.trigger("change");
            return el.value;
          },
          ref,
          Number(date[1]),
          Number(date[2]),
          Number(date[3]),
        ),
      READ_MS,
    ).catch(() => "");
    return shown
      ? { ok: true, result: `set to "${shown}" through its date picker` }
      : { ok: false, reason: "A date picker" };
  }

  /** A box that turns what you type into tags: "Add …" with tags (or their hidden inputs) beside it. */
  private isTagInput(ref: string): Promise<boolean> {
    return within(
      () =>
        this.frame.$eval(deep(ref), (el) => {
          const input = el as HTMLInputElement;
          const box =
            el.closest(".form-group, [class*='field' i], [class*='tag' i]") ??
            el.parentElement?.parentElement ??
            null;
          const tags =
            box?.querySelector(
              "input[type=hidden][name*='['], [class*='chip' i], [class*='token' i], [class*='tag-item' i]",
            ) !== null && box !== null;
          return (
            input.type !== "email" &&
            (tags ||
              // "Add skills"; Zoho's "Search and add skills".
              /^(search (and|&) )?(add|enter|type)\b.*\b(skill|tag|keyword)/i.test(
                input.placeholder,
              ))
          );
        }),
      READ_MS,
    ).catch(() => false);
  }

  /**
   * Each item typed and confirmed with Enter; ones already there are left alone. A box whose
   * tags don't take Enter (Mastercard's "Type to add Skills": a tag is only made by clicking one
   * of its suggestions) gets the rest picked from its list; ones it doesn't suggest are left out.
   */
  private async addTags(ref: string, value: string): Promise<FillOutcome> {
    const items = value.split(/\s*,\s*/).filter(Boolean);
    const box = await this.frame.$(deep(ref));
    if (!box) return { ok: false, reason: "Field not found on the page" };
    let added = 0;
    let byList = false;
    const notListed: string[] = [];
    for (const item of items) {
      const there = await within(
        () =>
          this.frame.$eval(
            deep(ref),
            (el, item) => {
              const around =
                el.closest(".form-group, [class*='field' i], [class*='tag' i]") ??
                el.parentElement?.parentElement;
              return (around?.textContent ?? "").toLowerCase().includes(item.toLowerCase());
            },
            item,
          ),
        READ_MS,
      ).catch(() => false);
      if (there) continue;
      // Its list suggests nothing for any of the first few: it isn't that kind of box either.
      if (byList && !added && notListed.length >= MAX_UNLISTED_TAGS) break;
      await box.click().catch(() => undefined);
      await this.clearSearch(ref);
      if (byList) {
        if (await this.tagFromList(ref, item)) added++;
        else notListed.push(item);
        continue;
      }
      await this.page.keyboard.sendCharacter(item.slice(0, 80));
      await this.page.keyboard.press("Enter");
      await sleep(250);
      if (!(await this.boxText(ref))) {
        added++;
        continue;
      }
      // Enter didn't make a tag: this one and the rest from the box's own suggestions.
      byList = true;
      if (await this.tagFromList(ref, item)) added++;
      else notListed.push(item);
    }
    // The box's own text: its read-back is the tags beside it once it's empty (Zoho's chips).
    const left = await this.boxText(ref);
    if (byList)
      return added && !left
        ? {
            ok: true,
            result: `added ${added} tag(s) from the site's suggestions${notListed.length ? `; not on its list: ${notListed.join(", ").slice(0, 160)}` : ""}`,
          }
        : {
            ok: false,
            reason: `its tags didn't take Enter, and its list suggested none of ${notListed.slice(0, 5).join(", ")}${left ? ` ("${left}" stayed in the box)` : ""}`,
          };
    return left
      ? { ok: false, reason: `"${left}" stayed in the box: its tags didn't take Enter` }
      : { ok: true, result: `added ${added} tag(s), one at a time` };
  }

  /** What's typed in the box itself (not its tags). */
  private async boxText(ref: string): Promise<string> {
    return (
      await within(
        () => this.frame.$eval(deep(ref), (el) => (el as HTMLInputElement).value ?? ""),
        READ_MS,
      ).catch(() => "")
    ).trim();
  }

  /**
   * One tag made by clicking the box's suggestion for it (typed key by key, as its search
   * listens for keys); the box is emptied when it suggests nothing like it.
   */
  private async tagFromList(ref: string, item: string): Promise<boolean> {
    // Typed again after an Enter that didn't take (it may have closed the list).
    await this.clearSearch(ref);
    await this.page.keyboard.type(item.slice(0, 80), { delay: TAG_KEY_DELAY_MS });
    const picked = await pickOpenChoice(this.frame, item, TAG_LIST_WAIT_MS);
    // A click can leave the box focused with the text still in it: a tag only when it's gone.
    if (picked && !(await this.boxText(ref))) return true;
    await this.clearSearch(ref);
    await this.page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  /** A native select: the best-matching option, by its own value. */
  private async select(
    ref: string,
    wanted: string,
    alternatives: readonly string[] = [],
    label = "",
  ): Promise<FillOutcome> {
    const handle = await this.frame.$(deep(ref));
    if (!handle) return { ok: false, reason: "Dropdown not found" };
    const options = await handle.evaluate((el) =>
      [...(el as HTMLSelectElement).options].map((o) => ({
        text: o.text.trim(),
        value: o.value,
      })),
    );
    const labels = options.map((o) => (o.value === "" ? "" : o.text));
    const index = bestOptionAmong(labels, [wanted, ...alternatives]);
    let option = index === null ? undefined : options[index];
    let byClaude = false;
    // Nothing in the list is your answer worded any way we know: Claude picks from the list's
    // own choices (with your resume), or none when nothing there is your answer.
    if (!option && this.chooser) {
      const choices = labels.filter((l) => l && !PLACEHOLDER.test(l));
      const choice = choices.length
        ? await this.chooser(label, wanted, choices.slice(0, 300)).catch(() => null)
        : null;
      const picked = choice === null ? null : bestOption(labels, choice);
      option = picked === null ? undefined : options[picked];
      byClaude = option !== undefined;
    }
    if (!option) return { ok: false, reason: `No choice matching "${wanted}"` };
    await handle.select(option.value);
    const outcome = await this.verify(ref, option.text);
    return outcome.ok && byClaude
      ? { ok: true, result: `Claude picked "${option.text}" from the list (your answer: "${wanted.slice(0, 60)}")` }
      : outcome;
  }

  /** Radios and checkboxes: clicks the matching ones (a lone checkbox: ticks it). */
  private async choose(
    ref: string,
    wanted: readonly string[],
    label = "",
  ): Promise<FillOutcome> {
    const inputs = await this.frame.$$(deep(ref));
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
    let targets =
      inputs.length === 1
        ? [0]
        : wanted.flatMap((w) => {
            const i = bestOption(labels, w);
            return i === null ? [] : [i];
          });
    // One answer, worded nothing like the buttons ("Immediate joiner" vs "0-15 days"): Claude
    // picks one of the buttons (with your resume and saved answers), or none.
    if (!targets.length && wanted.length === 1 && labels.length > 1 && this.chooser) {
      const choice = await this.chooser(label, wanted[0] ?? "", labels.filter(Boolean)).catch(
        () => null,
      );
      const picked = choice === null ? null : bestOption(labels, choice);
      if (picked !== null) targets = [picked];
    }
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
    if (picked.every((p) => selectionMatches(shown, p)))
      return { ok: true, result: `picked ${picked.map((p) => `"${p}"`).join(", ")}` };
    // A lone checkbox whose words don't read back (no label, or none at all): ticked is set.
    if (
      inputs.length === 1 &&
      (await inputs[0]
        ?.evaluate((el) => (el as HTMLInputElement).checked)
        .catch(() => false))
    )
      return { ok: true, result: "ticked" };
    return { ok: false, reason: `"${picked.join(", ")}" didn't stay selected` };
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
    const input = await this.frame.$(deep(ref));
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
    const gathered = await this.searchEverything(entry, wanted);
    if (gathered) return gathered;
    await this.clearSearch(ref);
    await this.page.keyboard.sendCharacter(wanted.slice(0, 80));
    await this.page.keyboard.press("Enter");
    await sleep(200);
    return this.verify(ref, wanted);
  }

  /**
   * A search list that shows nothing until you type, and nothing for your whole answer: your
   * answer's main words are searched, then broader words Claude suggests and "Other"; every
   * choice seen is kept, and the best of all of them is picked at the end (your answer as the
   * list words it, or the same words in another order; else Claude's pick). Null when nothing
   * was found or nothing fits.
   */
  private async searchEverything(
    entry: PlanEntry,
    wanted: string,
  ): Promise<FillOutcome | null> {
    const { ref } = entry;
    if (!wanted.trim()) return null;
    const found = new Set<string>();
    const searched = new Set<string>([wanted.toLowerCase()]);
    const collect = async (terms: readonly string[]) => {
      for (const term of terms) {
        if (searched.has(term.toLowerCase())) continue;
        searched.add(term.toLowerCase());
        await this.clearSearch(ref);
        await this.page.keyboard.sendCharacter(term.slice(0, 80));
        for (const choice of await visibleChoices(this.frame, SEARCH_LIST_MS))
          if (!PLACEHOLDER.test(choice) && !NO_RESULTS.test(choice))
            found.add(choice);
      }
    };
    await collect(searchWords(wanted));
    let choice = bestFound([...found], wanted);
    // The list may word it another way ("B.Tech" for "Bachelor's Degree"): search those first.
    if (!choice) {
      await collect(equivalentTerms(wanted).slice(0, MAX_EQUIVALENT_SEARCHES));
      choice = bestFound([...found], wanted);
    }
    let byClaude = false;
    if (!choice) {
      const broader = this.searchTerms
        ? await this.searchTerms(entry.label, wanted).catch(() => [])
        : [];
      await collect([...broader, "Other"]);
      choice = bestFound([...found], wanted);
      if (!choice && found.size && this.chooser) {
        choice = await this.chooser(
          entry.label,
          wanted,
          [...found].slice(0, 300),
        ).catch(() => null);
        byClaude = true;
      }
    }
    await this.clearSearch(ref);
    if (!choice) return null;
    await this.page.keyboard.sendCharacter(choice.slice(0, 80));
    const picked =
      (await pickOpenChoice(this.frame, choice)) ??
      (await this.pickAfterEnter(choice));
    if (!picked) return null;
    await sleep(200);
    const outcome = await this.verify(ref, picked);
    return outcome.ok
      ? {
          ok: true,
          result: `${byClaude ? "Claude picked" : "picked"} "${picked}" of ${found.size} choices seen across searches (your answer: "${wanted.slice(0, 60)}")`,
        }
      : outcome;
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
    const handle = await this.frame.$(deep(ref));
    if (!handle) return { ok: false, reason: "Field not found on the page" };
    if (selectionMatches(await this.readBackRef(ref), wanted))
      return { ok: true, result: "already set" };
    await handle.click();
    await sleep(250);
    if (await this.frame.evaluate(focusSearchBox, ref).catch(() => false)) {
      for (const candidate of [
        wanted,
        ...(entry.alternatives ?? []),
        ...equivalentTerms(wanted).slice(0, MAX_EQUIVALENT_SEARCHES),
      ]) {
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
      .$eval(deep(ref), (el) => {
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
    const handle = await this.frame.$(deep(ref));
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

  /** Buttons clicked to show hidden fields, per page ("step|mark"): each once. */
  private readonly revealed = new Set<string>();

  /**
   * Clicks the buttons that show hidden fields (an entry's Edit, a collapsed section), each
   * once per page, on the page or inside a web component. How many it clicked.
   */
  async reveal(refs: readonly string[]): Promise<number> {
    const step = await this.step();
    let clicked = 0;
    for (const ref of refs) {
      const key = `${step}|${ref}`;
      if (this.revealed.has(key)) continue;
      this.revealed.add(key);
      const button = await deepFind(this.frame, ref);
      if (!button) continue;
      await button.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
      await button
        .click()
        .catch(() => button.evaluate((el) => (el as HTMLElement).click()))
        .catch(() => undefined);
      clicked++;
      await sleep(REVEAL_WAIT_MS);
    }
    return clicked;
  }

  /**
   * Saves the entries open for editing with their own Save (a job or degree opened with Edit
   * or Add, filled): never the page's main Save or Submit. Their names; none when there's none.
   */
  async saveEntries(): Promise<string[]> {
    await ensureLocator(this.frame);
    const saves = await this.frame.evaluate(entrySaves).catch(() => [] as [string, string][]);
    const saved: string[] = [];
    for (const [mark, name] of saves) {
      const button = await deepFind(this.frame, mark);
      if (!button) continue;
      await button
        .click()
        .catch(() => button.evaluate((el) => (el as HTMLElement).click()))
        .catch(() => undefined);
      saved.push(name);
      await sleep(REVEAL_WAIT_MS);
    }
    return saved;
  }

  /** A contenteditable box (a formatted text editor), not a list. */
  private isEditable(ref: string): Promise<boolean> {
    return this.frame
      .$eval(deep(ref), (el) => (el as HTMLElement).isContentEditable)
      .catch(() => false);
  }

  /** Types into a formatted text editor: what was there replaced, then its text checked. */
  private async richText(ref: string, value: string): Promise<FillOutcome> {
    const box = await this.frame.$(deep(ref));
    if (!box) return { ok: false, reason: "Field not found on the page" };
    await box.click();
    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("a");
    await this.page.keyboard.up("Control");
    await this.page.keyboard.press("Backspace");
    await this.page.keyboard.sendCharacter(value);
    await sleep(150);
    const shown = await box.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
    const want = value.replace(/\s+/g, " ").trim();
    return shown.includes(want.slice(0, 200))
      ? { ok: true, result: "typed into the editor" }
      : { ok: false, reason: `The editor shows "${shown.slice(0, 40)}"` };
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
