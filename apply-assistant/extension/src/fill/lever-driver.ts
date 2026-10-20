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
 * Fills a Lever application form (jobs.lever.co/<site>/<posting>/apply). Fields are found by
 * their input `name` (the plan's ref); choices are radio buttons, checkboxes or native
 * dropdowns; "Current location" is a search that only keeps a place picked from its list.
 * Lever parses an attached resume and may fill fields from it, so the run attaches it first.
 */

const clean = (ref: string) => ref.replace(/["\\]/g, "");
const byName = (ref: string) => `[name="${clean(ref)}"]`;

/** The apply page for a Lever posting link. */
export function leverFormUrl(postingUrl: string): string {
  const url = new URL(postingUrl);
  if (!/\/apply\/?$/.test(url.pathname))
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/apply`;
  return url.toString();
}

export class LeverDriver extends TrustedDriver {
  protected readonly errorSelector =
    ".application-error, .error-message, [role=alert]";
  protected override readonly boxClosest = ".application-question";

  static async attach(page: Page): Promise<LeverDriver | null> {
    const deadline = Date.now() + FORM_WAIT_MS;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const found = await frame
          .$('form#application-form [name="name"]')
          .catch(() => null);
        if (found) return new LeverDriver(page, frame);
      }
      await sleep(400);
    }
    return null;
  }

  protected boxFor(ref: string): string {
    return byName(ref);
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
              `input[type=file]${byName(entry.ref)}`,
              resume,
            )
          : { ok: false, reason: "Tailored PDF not loaded" };
      const wanted = Array.isArray(value) ? value : [value as string];
      const element = await this.frame.$(byName(entry.ref));
      if (!element)
        return {
          ok: false,
          reason: "Field not found on the page; fill it yourself",
        };
      const kind = await element.evaluate((el) =>
        el.tagName === "SELECT"
          ? "dropdown"
          : (el as HTMLInputElement).type === "radio" ||
              (el as HTMLInputElement).type === "checkbox"
            ? "choice"
            : "text",
      );
      if (kind === "dropdown")
        return await this.dropdown(element, wanted[0] ?? "");
      if (kind === "choice") return await this.choose(entry.ref, wanted);
      if (entry.ref === "location")
        return await this.location(element, wanted[0] ?? "");
      return await this.typeText(
        element,
        wanted.join(", "),
        entry.ref === "phone",
      );
    } catch (error) {
      return failed(error);
    }
  }

  private async dropdown(
    element: ElementHandle,
    wanted: string,
  ): Promise<FillOutcome> {
    const options = await element.evaluate((el) =>
      [...(el as HTMLSelectElement).options]
        .filter((o) => o.value)
        .map((o) => ({ value: o.value, label: o.text.trim() })),
    );
    const index = bestOption(
      options.map((o) => o.label),
      wanted,
    );
    const option = index === null ? undefined : options[index];
    if (!option) return { ok: false, reason: `No choice matching "${wanted}"` };
    await element.select(option.value);
    const shown = await element.evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.text.trim() ?? "",
    );
    return shown === option.label
      ? { ok: true, result: `picked "${shown}"` }
      : { ok: false, reason: `"${option.label}" wasn't selected` };
  }

  private async choices(ref: string) {
    return this.frame.$$eval(byName(ref), (inputs) =>
      inputs.map((input) => ({
        value: (input as HTMLInputElement).value,
        label: (
          input.closest("label")?.textContent ??
          (input as HTMLInputElement).value
        ).trim(),
        checked: (input as HTMLInputElement).checked,
      })),
    );
  }

  private async choose(
    ref: string,
    wanted: readonly string[],
  ): Promise<FillOutcome> {
    const options = await this.choices(ref);
    const labels = options.map((o) => o.label);
    const picked: string[] = [];
    for (const item of wanted) {
      const index = bestOption(labels, item);
      const option = index === null ? undefined : options[index];
      if (!option) continue;
      if (!option.checked) {
        const input = await this.frame.$(
          `${byName(ref)}[value="${clean(option.value)}"]`,
        );
        const label = await input?.evaluateHandle((el) => el.closest("label"));
        const target = (label?.asElement() ?? input) as ElementHandle | null;
        await target?.click();
      }
      picked.push(option.label);
    }
    await sleep(150);
    const now = await this.choices(ref);
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

  /** "Current location": type, wait for Lever's suggestions to settle, click the best. */
  private async location(
    element: ElementHandle,
    wanted: string,
  ): Promise<FillOutcome> {
    const typed = await this.typeText(element, wanted.slice(0, 60), false);
    if (!typed.ok) return typed;
    const deadline = Date.now() + OPTION_WAIT_MS;
    let previous = "";
    while (Date.now() < deadline) {
      await sleep(POLL_MS * 2);
      const labels = await this.frame.$$eval(".dropdown-location", (els) =>
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
      const options = await this.frame.$$(".dropdown-location");
      const visible: ElementHandle[] = [];
      for (const option of options)
        if (
          await option.evaluate(
            (el) => (el as HTMLElement).offsetParent !== null,
          )
        )
          visible.push(option);
      await visible[index]?.click();
      await sleep(250);
      const chosen = await this.frame
        .$eval("#selected-location", (el) => (el as HTMLInputElement).value)
        .catch(() => "");
      const target = labels[index] ?? "";
      return chosen
        ? { ok: true, result: `picked "${target}"` }
        : { ok: false, reason: `"${target}" wasn't selected` };
    }
    return { ok: false, reason: `No place matching "${wanted}" appeared` };
  }

  async readBack(entry: PlanEntry): Promise<string> {
    if (entry.type === "file") return "";
    if (entry.type === "select" || entry.type === "multiselect") {
      const dropdown = await this.frame
        .$eval(byName(entry.ref), (el) =>
          el.tagName === "SELECT"
            ? (el as HTMLSelectElement).value
              ? ((el as HTMLSelectElement).selectedOptions[0]?.text.trim() ??
                "")
              : ""
            : null,
        )
        .catch(() => null);
      if (dropdown !== null) return dropdown;
      return (await this.choices(entry.ref))
        .filter((o) => o.checked)
        .map((o) => o.label)
        .join(", ");
    }
    return this.frame
      .$eval(byName(entry.ref), (el) => (el as HTMLInputElement).value ?? "")
      .catch(() => "");
  }
}
