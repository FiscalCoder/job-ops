import type {
  ElementHandle,
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { captureDom, type DomCapture, MAX_DOM_CHARS } from "../trace/dom";
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
}

export const OPTION_WAIT_MS = 5_000;
export const POLL_MS = 120;
export const FORM_WAIT_MS = 15_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Dropdown option ranking: exact > starts-with > whole word > contains. Among options starting
 * with your answer, one where it's followed by punctuation ("Bengaluru, Karnataka", "India +91")
 * is the place itself; one where another word follows ("Bengaluru Rural") ranks just below.
 */
export function rankOption(label: string, wanted: string): number {
  const s = label.toLowerCase().replace(/\s+/g, " ").trim();
  const w = wanted.toLowerCase().replace(/\s+/g, " ").trim();
  if (!w) return 9;
  if (s === w) return 0;
  if (s.startsWith(w)) return /^ [\p{L}\p{N}]/u.test(s.slice(w.length)) ? 1.5 : 1;
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
