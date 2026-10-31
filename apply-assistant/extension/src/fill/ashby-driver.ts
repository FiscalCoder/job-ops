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
  sleep,
  TrustedDriver,
} from "./trusted";

/**
 * Fills an Ashby application form (jobs.ashbyhq.com/<org>/<posting>/application). Every field
 * sits in a container tagged data-field-path="<path>" (the plan's ref): text and long text use
 * the path as their id, single choices are radio buttons labelled with the option, Location is
 * a type-ahead. The "autofill from resume" upload at the top is never touched.
 */

const clean = (ref: string) => ref.replace(/["\\]/g, "");
export const ashbyBox = (ref: string) => `[data-field-path="${clean(ref)}"]`;
const byId = (ref: string) => `[id="${clean(ref)}"]`;

/** The application page for an Ashby posting link (the form lives on its own tab). */
export function ashbyFormUrl(postingUrl: string): string {
  const url = new URL(postingUrl);
  if (!/\/application\/?$/.test(url.pathname))
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/application`;
  return url.toString();
}

export class AshbyDriver extends TrustedDriver {
  protected readonly errorSelector =
    '[role=alert], [class*="_error"], .ashby-application-form-field-entry [class*="rror"]';

  static async attach(page: Page): Promise<AshbyDriver | null> {
    const deadline = Date.now() + FORM_WAIT_MS;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const found = await frame.$("[data-field-path]").catch(() => null);
        if (found) return new AshbyDriver(page, frame);
      }
      await sleep(400);
    }
    return null;
  }

  protected boxFor(ref: string): string {
    return ashbyBox(ref);
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
          ? await this.attachFile(
              `${ashbyBox(entry.ref)} input[type=file]`,
              resume,
            )
          : { ok: false, reason: "Tailored PDF not loaded" };
      const wanted = Array.isArray(value) ? value : [value as string];
      // A yes/no question: two buttons over a hidden checkbox.
      if ((await this.buttons(entry.ref)).length)
        return await this.press(entry.ref, wanted[0] ?? "");
      // A long list of choices is a type-ahead ("Start typing..."), not radio buttons.
      const combobox = await this.frame.$(
        `${ashbyBox(entry.ref)} input[role=combobox]`,
      );
      if (combobox) return await this.typeAhead(combobox, wanted[0] ?? "");
      if (entry.type === "select" || entry.type === "multiselect")
        return await this.choose(entry.ref, wanted);
      const element = await this.frame.$(byId(entry.ref));
      if (!element)
        return {
          ok: false,
          reason: "Field not found on the page; fill it yourself",
        };
      const isPhone = await element.evaluate(
        (el) => (el as HTMLInputElement).type === "tel",
      );
      return await this.typeText(element, wanted.join(", "), isPhone);
    } catch (error) {
      return failed(error);
    }
  }

  /** A yes/no question's buttons ("Yes", "No"), and which one is pressed. */
  private async buttons(ref: string) {
    return this.frame.$$eval(
      `${ashbyBox(ref)} button[aria-pressed]`,
      (buttons) =>
        buttons.map((b) => ({
          label: (b.textContent ?? "").trim(),
          pressed: b.getAttribute("aria-pressed") === "true",
        })),
    );
  }

  /** Presses the yes/no button worded like your answer, then checks it stayed pressed. */
  private async press(ref: string, wanted: string): Promise<FillOutcome> {
    const before = await this.buttons(ref);
    const index = bestOption(
      before.map((b) => b.label),
      wanted,
    );
    const target = index === null ? undefined : before[index];
    if (index === null || !target)
      return { ok: false, reason: `No choice matching "${wanted}"` };
    if (!target.pressed) {
      const handles = await this.frame.$$(
        `${ashbyBox(ref)} button[aria-pressed]`,
      );
      await handles[index]?.click();
      await sleep(150);
    }
    const now = await this.buttons(ref);
    return now[index]?.pressed
      ? { ok: true, result: `picked "${target.label}"` }
      : { ok: false, reason: `"${target.label}" didn't stay selected` };
  }

  /** Radio or checkbox options of a question, with their visible labels. */
  private async options(ref: string) {
    return this.frame.$$eval(
      `input[type=radio][name$="_${clean(ref)}"], input[type=checkbox][name$="_${clean(ref)}"], ${ashbyBox(ref)} input[type=radio], ${ashbyBox(ref)} input[type=checkbox]`,
      (inputs) =>
        [...new Set(inputs)].map((input) => ({
          id: input.id,
          label: (
            document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
              ?.textContent ??
            input.closest("label")?.textContent ??
            ""
          ).trim(),
          checked: (input as HTMLInputElement).checked,
        })),
    );
  }

  /** Clicks the label of each wanted option (radio or checkbox), then checks it took. */
  private async choose(
    ref: string,
    wanted: readonly string[],
  ): Promise<FillOutcome> {
    const options = await this.options(ref);
    if (options.length === 0)
      return { ok: false, reason: "Choices not found; pick it yourself" };
    const labels = options.map((o) => o.label);
    const picked: string[] = [];
    for (const item of wanted) {
      const index = bestOption(labels, item);
      const option = index === null ? undefined : options[index];
      if (!option) continue;
      if (!option.checked) {
        const label = await this.frame.$(`label[for="${clean(option.id)}"]`);
        await (
          label ?? (await this.frame.$(`[id="${clean(option.id)}"]`))
        )?.click();
      }
      picked.push(option.label);
    }
    await sleep(150);
    const now = await this.options(ref);
    const missing = picked.filter(
      (label) => !now.some((o) => o.label === label && o.checked),
    );
    if (picked.length === 0)
      return { ok: false, reason: `No choice matching "${wanted.join(", ")}"` };
    return missing.length
      ? { ok: false, reason: `"${missing.join(", ")}" didn't stay selected` }
      : {
          ok: true,
          result: `picked ${picked.map((p) => `"${p}"`).join(", ")}`,
        };
  }

  /** Location-style search: insert the text, wait for the options to settle, pick the best. */
  private async typeAhead(
    element: ElementHandle,
    wanted: string,
  ): Promise<FillOutcome> {
    await element.click();
    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("a");
    await this.page.keyboard.up("Control");
    await this.page.keyboard.press("Backspace");
    await this.page.keyboard.sendCharacter(wanted.slice(0, 40));
    const deadline = Date.now() + OPTION_WAIT_MS;
    let previous = "";
    while (Date.now() < deadline) {
      await sleep(POLL_MS * 2);
      const labels = await this.frame.$$eval("[role=option]", (els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => (el.textContent ?? "").trim()),
      );
      const snapshot = labels.join("|");
      if (snapshot !== previous) {
        previous = snapshot;
        continue;
      }
      const index = bestOption(labels, wanted);
      if (index === null) continue;
      const options = await this.frame.$$("[role=option]");
      const visible = [];
      for (const option of options)
        if (
          await option.evaluate(
            (el) => (el as HTMLElement).offsetParent !== null,
          )
        )
          visible.push(option);
      await visible[index]?.click();
      await sleep(250);
      const shown = await element.evaluate(
        (el) => (el as HTMLInputElement).value ?? "",
      );
      const target = labels[index] ?? "";
      return shown.trim()
        ? { ok: true, result: `picked "${target}"` }
        : { ok: false, reason: `"${target}" wasn't selected` };
    }
    await this.page.keyboard.press("Escape");
    return { ok: false, reason: `No place matching "${wanted}" appeared` };
  }

  async readBack(entry: PlanEntry): Promise<string> {
    if (entry.type === "file") return "";
    const buttons = await this.buttons(entry.ref).catch(() => []);
    if (buttons.length)
      return buttons
        .filter((b) => b.pressed)
        .map((b) => b.label)
        .join(", ");
    const combobox = await this.frame.$(
      `${ashbyBox(entry.ref)} input[role=combobox]`,
    );
    if (combobox)
      return combobox.evaluate((el) => (el as HTMLInputElement).value ?? "");
    if (entry.type === "select" || entry.type === "multiselect")
      return (await this.options(entry.ref))
        .filter((o) => o.checked)
        .map((o) => o.label)
        .join(", ");
    return this.frame
      .$eval(
        `${ashbyBox(entry.ref)} input:not([type=file]), ${ashbyBox(entry.ref)} textarea`,
        (el) => (el as HTMLInputElement).value ?? "",
      )
      .catch(() => "");
  }
}
