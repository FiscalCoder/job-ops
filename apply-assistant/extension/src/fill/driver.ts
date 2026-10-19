import type {
  ElementHandle,
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { PlanEntry } from "./supervisor";

/**
 * Fills a Greenhouse application form with trusted input (CDP via chrome.debugger), the only
 * input Greenhouse's React form keeps (M0). Every action reads the field back. There is no
 * way to submit here: the driver never clicks anything except a field and its own dropdown
 * options (plus the "Apply" tab that reveals an embedded form).
 */

export type FillOutcome =
  | { readonly ok: true; readonly result: string }
  | { readonly ok: false; readonly reason: string };

export interface ResumeFile {
  readonly base64: string;
  readonly name: string;
}

const OPTION_WAIT_MS = 5_000;
const POLL_MS = 120;
const FORM_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** DOM id for a plan field; Greenhouse renders most fields with id = field name. */
export function selectorFor(ref: string): string {
  if (ref === "location") return "#candidate-location";
  return `[id="${ref.replace(/["\\]/g, "")}"]`;
}

/** M0 ranking for dropdown options: exact > starts-with > whole word > contains. */
export function rankOption(label: string, wanted: string): number {
  const s = label.toLowerCase().replace(/\s+/g, " ").trim();
  const w = wanted.toLowerCase().replace(/\s+/g, " ").trim();
  if (!w) return 9;
  if (s === w) return 0;
  if (s.startsWith(w)) return 1;
  const words = (t: string) => ` ${t.replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (words(s).includes(words(w))) return 2;
  if (s.includes(w)) return 3;
  return 9;
}

export function bestOption(
  labels: readonly string[],
  wanted: string,
): number | null {
  const ranked = labels
    .map((label, index) => ({ index, rank: rankOption(label, wanted) }))
    .filter((r) => r.rank < 9)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (labels[a.index]?.length ?? 0) - (labels[b.index]?.length ?? 0),
    );
  return ranked[0]?.index ?? null;
}

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Read-back for a dropdown: some widgets show only part of the chosen option (the phone
 * country picker shows "+91" for "India +91"), so either containing the other counts.
 */
export function selectionMatches(shown: string, picked: string): boolean {
  const a = shown.trim().toLowerCase();
  const b = picked.trim().toLowerCase();
  // Nothing shown means nothing was chosen (e.g. text typed but the menu never closed).
  if (!a) return false;
  return a === b || b.includes(a) || a.includes(b);
}

const isDropdown = (element: ElementHandle) =>
  element.evaluate(
    (el) =>
      el.getAttribute("role") === "combobox" ||
      el.closest(".select__control") !== null,
  );

export class GreenhouseDriver {
  private constructor(
    private readonly page: Page,
    private readonly frame: Frame,
  ) {}

  /** Finds the form (on the page or in Greenhouse's embed iframe), clicking "Apply" if it's hidden. */
  static async attach(page: Page): Promise<GreenhouseDriver | null> {
    const deadline = Date.now() + FORM_WAIT_MS;
    let revealed = false;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const found = await frame.$("#first_name").catch(() => null);
        if (found) return new GreenhouseDriver(page, frame);
      }
      if (!revealed) {
        revealed = await GreenhouseDriver.reveal(page);
      }
      await sleep(400);
    }
    return null;
  }

  private static async reveal(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      const handle = await frame
        .evaluateHandle(() => {
          const candidates = [
            ...document.querySelectorAll<HTMLElement>("[role=tab], button, a"),
          ];
          return (
            candidates.find((el) =>
              /^\s*(application|apply( now| for this job)?)\s*$/i.test(
                el.textContent ?? "",
              ),
            ) ?? null
          );
        })
        .catch(() => null);
      const element = handle?.asElement() as
        | ElementHandle<HTMLElement>
        | null
        | undefined;
      if (element) {
        await element.click().catch(() => {});
        return true;
      }
    }
    return false;
  }

  frameUrl(): string {
    return this.frame.url();
  }

  async exists(ref: string): Promise<boolean> {
    return (await this.frame.$(selectorFor(ref))) !== null;
  }

  /** Outlines the field being worked on and shows a small badge on the page. */
  async highlight(ref: string | null, badge: string): Promise<void> {
    await this.frame
      .evaluate(
        (selector, text) => {
          for (const el of document.querySelectorAll(".ac-current"))
            el.classList.remove("ac-current");
          if (!document.getElementById("ac-style")) {
            const style = document.createElement("style");
            style.id = "ac-style";
            style.textContent =
              ".ac-current{outline:3px solid #2f6fde!important;outline-offset:3px;border-radius:4px}" +
              "#ac-badge{position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#1b1f24;color:#fff;" +
              "font:13px/1.4 system-ui,sans-serif;padding:6px 10px;border-radius:8px;box-shadow:0 2px 8px #0004}";
            document.head.append(style);
          }
          let badgeEl = document.getElementById("ac-badge");
          if (!badgeEl) {
            badgeEl = document.createElement("div");
            badgeEl.id = "ac-badge";
            document.body.append(badgeEl);
          }
          badgeEl.textContent = text;
          if (!selector) return;
          const field = document.querySelector(selector);
          const box =
            field?.closest(
              ".field-wrapper, .select__container, .application--question, fieldset, div",
            ) ?? field;
          box?.classList.add("ac-current");
          field?.scrollIntoView({ block: "center" });
        },
        ref ? selectorFor(ref) : null,
        badge,
      )
      .catch(() => {});
  }

  async fill(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    resume?: ResumeFile,
  ): Promise<FillOutcome> {
    if (value === null) return { ok: false, reason: "Nothing to fill" };
    try {
      if (entry.type === "file")
        return resume
          ? await this.attachResume(entry.ref, resume)
          : { ok: false, reason: "Tailored PDF not loaded" };
      const element = await this.frame.$(selectorFor(entry.ref));
      if (!element)
        return {
          ok: false,
          reason: "Field not found on the page; fill it yourself",
        };
      if (entry.type === "multiselect")
        return await this.multiSelect(
          element,
          Array.isArray(value) ? value : [value as string],
        );
      // Trust the page over the API: Greenhouse calls Location a text field, but renders it as an
      // async city search that only keeps a value chosen from its list.
      if (entry.type === "select" || (await isDropdown(element)))
        return await this.select(
          element,
          String(Array.isArray(value) ? value[0] : value),
        );
      return await this.type(
        element,
        entry.ref,
        Array.isArray(value) ? value.join(", ") : (value as string),
      );
    } catch (error) {
      return {
        ok: false,
        reason: `Couldn't fill: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async type(
    element: ElementHandle,
    ref: string,
    value: string,
  ): Promise<FillOutcome> {
    await element.click();
    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("a");
    await this.page.keyboard.up("Control");
    await this.page.keyboard.press("Backspace");
    await this.page.keyboard.sendCharacter(value);
    await sleep(150);
    const got = await element.evaluate(
      (el) => (el as HTMLInputElement).value ?? "",
    );
    const ok =
      ref === "phone" ? digits(got).endsWith(digits(value)) : got === value;
    return ok
      ? { ok: true, result: "filled" }
      : {
          ok: false,
          reason: `Value didn't stick (page shows "${got.slice(0, 40)}")`,
        };
  }

  private async optionLabels(): Promise<string[]> {
    return this.frame.$$eval(".select__option", (els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => (el.textContent ?? "").trim()),
    );
  }

  /** Opens a react-select, types to filter, waits for options and clicks the best one. */
  private async focusedOption(): Promise<string> {
    return this.frame
      .$eval(".select__option--is-focused", (el) =>
        (el.textContent ?? "").trim(),
      )
      .catch(() => "");
  }

  /**
   * Opens a react-select, types to filter, waits for the (possibly async) options, then moves
   * to the best one with the arrow keys and presses Enter. Keyboard selection doesn't depend on
   * where the menu is on screen, which clicking did (the menu re-renders as results arrive).
   */
  private async pick(
    element: ElementHandle,
    wanted: string,
  ): Promise<string | null> {
    await element.click();
    // One insertText event: typing letter by letter loses characters on Greenhouse's async
    // city search (it rewrites the input while results load, so "Chennai" became "nai").
    await this.page.keyboard.sendCharacter(wanted.slice(0, 40));
    const deadline = Date.now() + OPTION_WAIT_MS;
    let previous = "";
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const labels = await this.optionLabels();
      // Wait until the list stops changing (async search results arrive after typing).
      const snapshot = labels.join("|");
      if (snapshot !== previous) {
        previous = snapshot;
        continue;
      }
      const index = bestOption(labels, wanted);
      if (index === null) continue;
      const target = labels[index] ?? "";
      for (
        let moves = 0;
        moves < labels.length && (await this.focusedOption()) !== target;
        moves++
      )
        await this.page.keyboard.press("ArrowDown");
      if ((await this.focusedOption()) !== target) break;
      await this.page.keyboard.press("Enter");
      return target;
    }
    await this.page.keyboard.press("Escape");
    return null;
  }

  private async select(
    element: ElementHandle,
    wanted: string,
  ): Promise<FillOutcome> {
    const picked = await this.pick(element, wanted);
    if (!picked)
      return { ok: false, reason: `No choice matching "${wanted}" appeared` };
    await sleep(150);
    const shown = await element.evaluate(
      (el) =>
        el
          .closest(".select__control, .select-shell, .select")
          ?.querySelector(".select__single-value")
          ?.textContent?.trim() ?? "",
    );
    if (selectionMatches(shown, picked))
      return { ok: true, result: `picked "${picked}"` };
    return {
      ok: false,
      reason: shown
        ? `The form shows "${shown}" instead of "${picked}"`
        : `"${picked}" wasn't selected`,
    };
  }

  private async multiSelect(
    element: ElementHandle,
    wanted: readonly string[],
  ): Promise<FillOutcome> {
    const picked: string[] = [];
    for (const item of wanted) {
      const label = await this.pick(element, item);
      if (label) picked.push(label);
    }
    await this.page.keyboard.press("Escape");
    return picked.length
      ? { ok: true, result: `picked ${picked.join(", ")}` }
      : { ok: false, reason: "None of the choices matched" };
  }

  /** Sets the file input through the page's DataTransfer API (file paths aren't available to extensions). */
  private async attachResume(
    ref: string,
    resume: ResumeFile,
  ): Promise<FillOutcome> {
    const attached = await this.frame.evaluate(
      (selector, base64, name) => {
        const input = document.querySelector<HTMLInputElement>(selector);
        if (!input) return null;
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([bytes], name, { type: "application/pdf" }),
        );
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return input.files?.[0]?.name ?? "";
      },
      selectorFor(ref),
      resume.base64,
      resume.name,
    );
    if (attached === null)
      return {
        ok: false,
        reason: "Resume field not found; attach it yourself",
      };
    return { ok: true, result: `attached ${resume.name}` };
  }

  /** What the field shows now: typed text, or the chosen option of a dropdown. */
  async readBack(entry: PlanEntry): Promise<string> {
    if (entry.type === "file") return "";
    return this.frame
      .$eval(selectorFor(entry.ref), (el) => {
        const control = el.closest(".select__control");
        if (control)
          return [
            ...control.querySelectorAll(
              ".select__single-value, .select__multi-value__label",
            ),
          ]
            .map((v) => v.textContent?.trim() ?? "")
            .join(", ");
        return (el as HTMLInputElement).value ?? "";
      })
      .catch(() => "");
  }

  /** Validation messages and CAPTCHAs: things a person has to look at. */
  async problems(): Promise<string[]> {
    return this.frame
      .evaluate(() => {
        const errors = [
          ...document.querySelectorAll(
            ".helper-text--error, .error-message, [role=alert]",
          ),
        ]
          .map((el) => el.textContent?.trim() ?? "")
          .filter(Boolean);
        // Only a visible challenge counts; Greenhouse always carries an invisible reCAPTCHA badge.
        const challenge = [
          ...document.querySelectorAll<HTMLIFrameElement>(
            'iframe[src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"]',
          ),
        ].some(
          (frame) =>
            frame.offsetWidth > 100 &&
            frame.offsetHeight > 100 &&
            frame.checkVisibility({
              visibilityProperty: true,
              opacityProperty: true,
            }),
        );
        return challenge
          ? [...errors, "CAPTCHA on the page: solve it there"]
          : errors;
      })
      .catch(() => []);
  }

  /** True once Greenhouse shows its confirmation (you clicked Submit). */
  async submitted(): Promise<boolean> {
    for (const frame of this.page.frames()) {
      const done = await frame
        .evaluate(
          () =>
            /\/confirmation\b/.test(location.pathname) ||
            /thank you for (applying|your application)|application (has been )?(submitted|received)/i.test(
              document.body?.innerText ?? "",
            ),
        )
        .catch(() => false);
      if (done) return true;
    }
    return false;
  }
}
