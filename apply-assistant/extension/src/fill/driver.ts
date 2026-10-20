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
 * Fills a Greenhouse application form. Greenhouse's React form only keeps trusted input (M0);
 * its dropdowns are react-selects (some with async search), driven from the keyboard.
 */

export {
  bestOption,
  type FillOutcome,
  type ResumeFile,
  rankOption,
  selectionMatches,
} from "./trusted";

/** DOM id for a plan field; Greenhouse renders most fields with id = field name. */
export function selectorFor(ref: string): string {
  if (ref === "location") return "#candidate-location";
  return `[id="${ref.replace(/["\\]/g, "")}"]`;
}

/** Greenhouse's page-only "Are you Hispanic/Latino?" question (not in its API). */
const ETHNICITY = "hispanic_ethnicity";

/** The Hispanic/Latino answer that goes with a saved race answer. */
export function ethnicityAnswer(race: string): "Yes" | "No" | "Decline" {
  if (/decline|prefer not|don'?t wish|not to (say|answer)/i.test(race))
    return "Decline";
  return /hispanic|latin/i.test(race) ? "Yes" : "No";
}

const isDropdown = (element: ElementHandle) =>
  element.evaluate(
    (el) =>
      el.getAttribute("role") === "combobox" ||
      el.closest(".select__control") !== null,
  );

/** Finds a "Apply" / "Application" tab or button that reveals a hidden form. */
export async function revealForm(page: Page): Promise<boolean> {
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

export class GreenhouseDriver extends TrustedDriver {
  protected readonly errorSelector =
    ".helper-text--error, .error-message, [role=alert]";

  /** Finds the form (on the page or in Greenhouse's embed iframe), clicking "Apply" if it's hidden. */
  static async attach(page: Page): Promise<GreenhouseDriver | null> {
    const deadline = Date.now() + FORM_WAIT_MS;
    let revealed = false;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const found = await frame.$("#first_name").catch(() => null);
        if (found) return new GreenhouseDriver(page, frame);
      }
      if (!revealed) revealed = await revealForm(page);
      await sleep(400);
    }
    return null;
  }

  // Greenhouse has no single wrapper class: outline the field's nearest container.
  protected override readonly boxClosest =
    ".field-wrapper, .select__container, .application--question, fieldset, div";

  protected boxFor(ref: string): string {
    return selectorFor(ref);
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
          ? await this.attachFile(selectorFor(entry.ref), resume)
          : { ok: false, reason: "Tailored PDF not loaded" };
      const element = await this.frame.$(selectorFor(entry.ref));
      if (!element && entry.ref === "race")
        return await this.raceAfterEthnicity(
          String(Array.isArray(value) ? value[0] : value),
        );
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
      return await this.typeText(
        element,
        Array.isArray(value) ? value.join(", ") : (value as string),
        entry.ref === "phone",
      );
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * Greenhouse's US voluntary questions: the page asks "Are you Hispanic/Latino?" (missing from
   * its API) and shows Race only after "No". Answers that first, from your saved race answer,
   * then picks Race when it appears.
   */
  private async raceAfterEthnicity(race: string): Promise<FillOutcome> {
    const ethnicity = await this.frame.$(selectorFor(ETHNICITY));
    if (!ethnicity)
      return {
        ok: false,
        reason: "Field not found on the page; fill it yourself",
      };
    const answer = ethnicityAnswer(race);
    const first = await this.select(ethnicity, answer);
    if (!first.ok)
      return {
        ok: false,
        reason: `"Are you Hispanic/Latino?": ${first.reason}`,
      };
    if (answer !== "No")
      return { ok: true, result: `answered Hispanic/Latino: ${answer}` };
    const deadline = Date.now() + OPTION_WAIT_MS;
    while (Date.now() < deadline) {
      const shown = await this.frame.$(selectorFor("race"));
      if (shown) {
        const picked = await this.select(shown, race);
        return picked.ok
          ? { ok: true, result: `Hispanic/Latino: No, then ${picked.result}` }
          : picked;
      }
      await sleep(POLL_MS);
    }
    return {
      ok: false,
      reason: "Race didn't appear after answering Hispanic/Latino",
    };
  }

  private async optionLabels(): Promise<string[]> {
    return this.frame.$$eval(".select__option", (els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => (el.textContent ?? "").trim()),
    );
  }

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

  /** What the field shows now: typed text, or the chosen option of a dropdown. */
  async readBack(entry: PlanEntry): Promise<string> {
    if (entry.type === "file") return "";
    // Race hidden (Hispanic/Latino answered Yes or declined): that answer stands in for it.
    const ref =
      entry.ref === "race" && !(await this.frame.$(selectorFor("race")))
        ? ETHNICITY
        : entry.ref;
    return this.frame
      .$eval(selectorFor(ref), (el) => {
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
}
