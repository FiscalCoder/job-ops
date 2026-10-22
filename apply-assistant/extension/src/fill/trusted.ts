import type {
  ElementHandle,
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { captureDom, type DomCapture, MAX_DOM_CHARS } from "../trace/dom";
import { digits, sleep } from "./options";
import { type OperateApi, operateField } from "./operate";
import { type SiteHelp, rescueField } from "./site-help";
import type { PlanEntry } from "./supervisor";

/**
 * What every application system's driver shares: trusted input through CDP (chrome.debugger),
 * the only input React forms keep; read-back after each action; highlighting; file attach;
 * spotting problems and the confirmation page. No driver can submit: they only click fields,
 * their options, and the tab that reveals a form.
 */

export type FillOutcome =
  | { readonly ok: true; readonly result: string }
  | { readonly ok: false; readonly reason: string };

export interface ResumeFile {
  readonly base64: string;
  readonly name: string;
}

/** The controller's view of a form, whatever the system. */
export interface FormDriver {
  highlight(ref: string | null, badge: string): Promise<void>;
  fill(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    resume?: ResumeFile,
  ): Promise<FillOutcome>;
  /** What the field shows now ("" when empty), to catch fields that were cleared again. */
  readBack(entry: PlanEntry): Promise<string>;
  /** Validation messages and visible CAPTCHAs: things a person has to look at. */
  problems(): Promise<string[]>;
  /** True once the system shows its confirmation (you clicked Submit). */
  submitted(): Promise<boolean>;
  /** The form's frame as markup with current values, for the run trace. */
  dom(): Promise<DomCapture>;
  /** A field fill() couldn't set: other ways to set it (saved steps, Claude); null if none ran. */
  rescue?(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    failure: string,
  ): Promise<FillOutcome | null>;
  /** "Let Claude do it" on a field that failed. */
  operate?(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    failure: string,
    api: OperateApi,
    stopped: () => boolean,
  ): Promise<FillOutcome>;
}

export {
  bestOption,
  digits,
  FORM_WAIT_MS,
  OPTION_WAIT_MS,
  POLL_MS,
  rankOption,
  selectionMatches,
  sleep,
} from "./options";

export const failed = (error: unknown): FillOutcome => ({
  ok: false,
  reason: `Couldn't fill: ${error instanceof Error ? error.message : String(error)}`,
});

const CONFIRMATION =
  /thank you for (applying|your application)|thanks for applying|application (has been |was )?(successfully )?(submitted|received)/i;

export abstract class TrustedDriver implements FormDriver {
  protected constructor(
    protected readonly page: Page,
    protected readonly frame: Frame,
  ) {}

  /** CSS selector of the outline target for a field (its container). */
  protected abstract boxFor(ref: string): string;

  abstract fill(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    resume?: ResumeFile,
  ): Promise<FillOutcome>;

  abstract readBack(entry: PlanEntry): Promise<string>;

  /** Validation-message selectors for this system. */
  protected abstract readonly errorSelector: string;

  /** When set, the outline goes on the field's nearest matching wrapper instead of the field. */
  protected readonly boxClosest: string | null = null;

  /** Set by the run: this site's saved steps and Claude, for fields filled no other way. */
  help: SiteHelp | null = null;

  /** A field fill() couldn't set: this site's saved steps, then Claude's; null if neither ran. */
  async rescue(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    failure: string,
  ): Promise<FillOutcome | null> {
    const wanted = (Array.isArray(value) ? value : [value]).filter(Boolean).join(", ");
    if (!this.help || !wanted || entry.type === "file") return null;
    const target = {
      page: this.page,
      frame: this.frame,
      selector: this.boxFor(entry.ref),
      readBack: () => this.readBack(entry),
    };
    return rescueField(target, this.help, entry, wanted, failure);
  }

  /** "Let Claude do it": Claude works the field on the page (screenshots and the field's outline). */
  operate(
    entry: PlanEntry,
    value: string | readonly string[] | null,
    failure: string,
    api: OperateApi,
    stopped: () => boolean,
  ): Promise<FillOutcome> {
    const wanted = (Array.isArray(value) ? value : [value]).filter(Boolean).join(", ");
    if (!wanted || entry.type === "file")
      return Promise.resolve({ ok: false, reason: "Nothing Claude can put in this field" });
    const target = {
      page: this.page,
      frame: this.frame,
      selector: this.boxFor(entry.ref),
      readBack: () => this.readBack(entry),
    };
    return operateField(target, entry, wanted, failure, api, { help: this.help, stopped });
  }

  /** Outlines the field being worked on and shows a small badge on the page. */
  async highlight(ref: string | null, badge: string): Promise<void> {
    await this.frame
      .evaluate(
        (selector, closest, text) => {
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
          const box = (closest ? field?.closest(closest) : null) ?? field;
          box?.classList.add("ac-current");
          box?.scrollIntoView({ block: "center" });
        },
        ref ? this.boxFor(ref) : null,
        this.boxClosest,
        badge,
      )
      .catch(() => {});
  }

  /** Clears the field and inserts the text in one event, then reads it back. */
  protected async typeText(
    element: ElementHandle,
    value: string,
    compareDigits: boolean,
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
    const ok = compareDigits
      ? digits(got).endsWith(digits(value))
      : got === value;
    return ok
      ? { ok: true, result: "filled" }
      : {
          ok: false,
          reason: `Value didn't stick (page shows "${got.slice(0, 40)}")`,
        };
  }

  /** Sets a file input through the page's DataTransfer API (file paths aren't available to extensions). */
  protected async attachFile(
    selector: string,
    resume: ResumeFile,
  ): Promise<FillOutcome> {
    const attached = await this.frame.evaluate(
      (sel, base64, name) => {
        const input = document.querySelector<HTMLInputElement>(sel);
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
      selector,
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

  async problems(): Promise<string[]> {
    return this.frame
      .evaluate((errorSelector) => {
        const errors = [...document.querySelectorAll(errorSelector)]
          .map((el) => el.textContent?.trim() ?? "")
          .filter(Boolean);
        // Only a visible challenge counts; forms often carry an invisible reCAPTCHA badge.
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
      }, this.errorSelector)
      .catch(() => []);
  }

  dom(): Promise<DomCapture> {
    return this.frame.evaluate(captureDom, MAX_DOM_CHARS);
  }

  async submitted(): Promise<boolean> {
    for (const frame of this.page.frames()) {
      const done = await frame
        .evaluate(
          (pattern) =>
            /\/confirmation\b/.test(location.pathname) ||
            new RegExp(pattern, "i").test(document.body?.innerText ?? ""),
          CONFIRMATION.source,
        )
        .catch(() => false);
      if (done) return true;
    }
    return false;
  }
}
