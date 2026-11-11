import type {
  ElementHandle,
  Frame,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import {
  bestOption,
  containsWords,
  digits,
  OPTION_WAIT_MS,
  POLL_MS,
  sameNumber,
  selectionMatches,
  sleep,
} from "./options";
import { equivalentTerms } from "./equivalents";
import { takeoverSkipped } from "./takeover-policy";
import { deepChoices, deepFind } from "./locate";
import type { PlanEntry } from "./supervisor";
import type { FillOutcome } from "./trusted";

/**
 * For a field a driver couldn't fill by itself, on any system (Workday, Greenhouse, Ashby,
 * Lever, a company's own site): this site's saved steps for the question (a recipe), then
 * Claude, who sees the field's HTML and replies with a few steps (click, type, press, pick).
 * Steps that worked are kept for the site, so it relies on Claude less each time.
 */

export interface ActStep {
  readonly action: "click" | "type" | "press" | "pick" | "wait";
  readonly value: string;
}

export interface SiteRecipe {
  readonly labelKey: string;
  readonly steps: readonly ActStep[];
  readonly worked: number;
  readonly failed: number;
}

/** The server's help for fields a driver can't fill by itself (set by the run). */
export interface SiteHelp {
  /** Claude's steps for one field, from its HTML. */
  act(ask: {
    label: string;
    wanted: string;
    html: string;
    failure: string;
  }): Promise<readonly ActStep[]>;
  /** This site's saved steps, by question. */
  readonly recipes: ReadonlyMap<string, SiteRecipe>;
  /** How a recipe (or Claude's steps, which become one) did. */
  record(label: string, steps: readonly ActStep[], ok: boolean): Promise<void>;
  /** Steps that worked on this kind of widget on any site (by widgetKind). */
  widget?(kind: string): Promise<SiteRecipe | null>;
  /** How steps did on this kind of widget (only steps with nothing site-specific). */
  recordWidget?(kind: string, steps: readonly ActStep[], ok: boolean): Promise<void>;
}

/**
 * What kind of widget a field is, the same on every site that uses it: its tag, role and the
 * class names a widget library gives it and its wrapper ("a.combobox.dropdown-select" for
 * iCIMS's dropdowns). "" when nothing tells it apart from a plain field. Runs inside the page.
 */
export function widgetKind(selector: string): string {
  const el = document.querySelector(selector) ?? (window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(selector) ?? null;
  if (!el) return "";
  const PLAIN =
    /^(form-control|form-group|input|field|control|required|valid|invalid|active|focus|focused|open|hidden|visible|ng-.*|is-.*|has-.*|col-.*|row|w-.*|mb-.*|mt-.*|p-.*|m-.*)$/i;
  const tokens = [el, el.parentElement]
    .flatMap((e) => [...(e?.classList ?? [])])
    .filter((t) => /^[a-z][a-z-]{2,29}$/i.test(t) && !PLAIN.test(t))
    .map((t) => t.toLowerCase());
  const unique = [...new Set(tokens)].sort().slice(0, 4);
  if (!unique.length) return "";
  const role = el.getAttribute("role") ?? "-";
  return `${el.tagName}.${role}.${unique.join(".")}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .slice(0, 180);
}

/** Steps worth trying on another site: no ids or numbered names that only exist on this one. */
export const portableSteps = (steps: readonly ActStep[]): boolean =>
  steps.length > 0 &&
  steps.every(
    (s) => s.action !== "click" || (!/#|\d/.test(s.value) && s.value.length <= 120),
  );

/** The field being rescued, as its driver sees it. */
export interface RescueTarget {
  readonly page: Page;
  readonly frame: Frame;
  /** CSS selector of the field (or its container). */
  readonly selector: string;
  /** What the field shows now. */
  readBack(): Promise<string>;
}

/** "Date of birth *" and "date of birth" are the same question (as the server keys them). */
export const labelKey = (label: string) =>
  label
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 200);

/**
 * Whose steps these are: every Workday tenant (acme.wd5.myworkdayjobs.com) is the same
 * software, so they share one set; anything else is its own site.
 */
export function recipeHost(url: string): string {
  const host = new URL(url).host.toLowerCase();
  const workday = /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/.exec(host);
  return workday ? `${workday[2]}.com` : host;
}

const ALLOWED_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "Backspace",
]);
/** Nothing Claude's steps click may submit, move on or delete. */
const FORBIDDEN_CLICK =
  /\b(submit|apply|save|continue|next|send|finish|delete|remove|upload)\b/i;
const MAX_WAIT_MS = 1_500;
const MAX_HTML_CHARS = 8_000;
/** Visible choices of a list that's open somewhere on the page (lists often open in a portal). */
/** The choices of an open list; Oracle's lists are grids, one choice per cell. */
const OPEN_CHOICES =
  "[role='option'], [role='gridcell'], [role='listbox'] li, li[class*='option' i], div[class*='option' i]:not([class*='options' i])";

/**
 * The field's HTML for Claude: the field marked data-ac-target="1" and the markup around it
 * (marked data-ac-box="1", what its steps may click in), cleaned of scripts, styles and long
 * attribute values. Runs inside the page.
 */
function fieldHtml(selector: string, limit: number): string {
  const deepAll =
    (window as unknown as { __acDeepAll?: (s: string) => Element[] }).__acDeepAll ?? (() => []);
  // Marks left inside web components are cleared too: one field area at a time.
  for (const el of [
    ...document.querySelectorAll("[data-ac-target], [data-ac-box]"),
    ...deepAll("[data-ac-target], [data-ac-box]"),
  ]) {
    el.removeAttribute("data-ac-target");
    el.removeAttribute("data-ac-box");
  }
  const el = document.querySelector(selector) ?? (window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(selector) ?? null;
  if (!el) return "";
  el.setAttribute("data-ac-target", "1");
  let box: Element = el;
  for (let depth = 0; depth < 6; depth++) {
    const parent: Element | null = box.parentElement;
    if (!parent || parent === document.body || parent.outerHTML.length > limit)
      break;
    box = parent;
  }
  box.setAttribute("data-ac-box", "1");
  const copy = box.cloneNode(true) as Element;
  for (const junk of copy.querySelectorAll(
    "script, style, svg, img, iframe, noscript",
  ))
    junk.remove();
  for (const node of [copy, ...copy.querySelectorAll("*")])
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || attr.name === "style")
        node.removeAttribute(attr.name);
      else if (attr.value.length > 120)
        node.setAttribute(attr.name, `${attr.value.slice(0, 120)}…`);
    }
  return copy.outerHTML.slice(0, limit);
}

/** Clicks the best-matching choice of a list open anywhere in the frame. */
export async function pickOpenChoice(
  frame: Frame,
  wanted: string,
  waitMs: number = OPTION_WAIT_MS,
): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS * 2);
    const handles: ElementHandle[] = [];
    const labels: string[] = [];
    for (const option of await frame.$$(OPEN_CHOICES)) {
      const label = await option.evaluate((el) =>
        (el as HTMLElement).offsetParent === null
          ? null
          : (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      );
      if (!label) continue;
      handles.push(option);
      labels.push(label);
    }
    // None on the page itself: a list open inside a web component, or in a fixed popup.
    if (!labels.length)
      for (const { handle, label } of await deepChoices(frame, OPEN_CHOICES)) {
        handles.push(handle);
        labels.push(label);
      }
    // Nothing that matches yet (only other lists' choices, or tags already picked): keep looking.
    const index = bestOption(labels, wanted);
    if (index === null) continue;
    await handles[index]?.click();
    await sleep(250);
    return labels[index] ?? null;
  }
  return null;
}

/** The choices of a list open in the frame, once any show (none after waitMs). */
export async function visibleChoices(
  frame: Frame,
  waitMs: number,
): Promise<string[]> {
  const deadline = Date.now() + waitMs;
  do {
    await sleep(POLL_MS * 2);
    const labels = await frame
      .$$eval(OPEN_CHOICES, (els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean),
      )
      .catch(() => [] as string[]);
    if (labels.length) return [...new Set(labels)];
    const deep = (await deepChoices(frame, OPEN_CHOICES)).map((c) => c.label);
    if (deep.length) return [...new Set(deep)];
  } while (Date.now() < deadline);
  return [];
}

/** Shows the value (a number may show formatted: "+91 98…" for "98…"). */
export const showsValue = (shown: string, wanted: string): boolean =>
  selectionMatches(shown, wanted) ||
  (digits(wanted).length > 5 && sameNumber(shown, wanted)) ||
  // Your answer as the list words it ("BA" for "Bachelor's Degree", "TN" for "Tamil Nadu"):
  // filled right, not a failure to hand to Claude. The field must show the whole wording.
  showsEquivalent(shown, wanted);

function showsEquivalent(shown: string, wanted: string): boolean {
  const s = shown.trim().toLowerCase();
  if (!s) return false;
  return equivalentTerms(wanted).some((term) => {
    const t = term.trim().toLowerCase();
    return s === t || containsWords(s, t);
  });
}

/** This site's saved steps for the question, else Claude's; null when neither sets it. */
export async function rescueField(
  target: RescueTarget,
  help: SiteHelp,
  entry: PlanEntry,
  wanted: string,
  failure: string,
): Promise<FillOutcome | null> {
  const recipe = help.recipes.get(labelKey(entry.label));
  let tried = failure;
  if (recipe && recipe.worked > recipe.failed) {
    const ok = await runSteps(target, recipe.steps, wanted);
    await help.record(entry.label, recipe.steps, ok).catch(() => {});
    if (ok) return { ok: true, result: "filled with this site's saved steps" };
    tried = `${tried}; this site's saved steps (${describeSteps(recipe.steps)}) didn't set it`;
  }
  // Steps that worked on the same kind of widget on another site.
  const kind = help.widget
    ? await target.frame.evaluate(widgetKind, target.selector).catch(() => "")
    : "";
  const shared = kind ? await help.widget?.(kind).catch(() => null) : null;
  if (shared && shared.worked > shared.failed) {
    const ok = await runSteps(target, shared.steps, wanted);
    await help.recordWidget?.(kind, shared.steps, ok).catch(() => {});
    if (ok) {
      await help.record(entry.label, shared.steps, true).catch(() => {});
      return { ok: true, result: "filled with steps that worked on this kind of field on another site" };
    }
    tried = `${tried}; steps from this kind of field elsewhere (${describeSteps(shared.steps)}) didn't set it`;
  }
  // Where Claude's steps rarely work (location fields: about 15% for these steps, 14% for a
  // takeover; a field that isn't on the page), no Claude call: the field is yours.
  const skipped = takeoverSkipped(entry.label, tried);
  if (skipped) return { ok: false, reason: `${tried}; no Claude steps: ${skipped}` };
  const html = await target.frame
    .evaluate(fieldHtml, target.selector, MAX_HTML_CHARS)
    .catch(() => "");
  if (!html) return null;
  const steps = await help
    .act({ label: entry.label, wanted, html, failure: tried })
    .catch(() => [] as ActStep[]);
  if (!steps.length)
    return { ok: false, reason: `${tried}; Claude found no steps from the field's HTML` };
  // Kept without your answer: "{value}" in its place.
  const general = steps.map((s) => ({
    ...s,
    value: s.value.split(wanted).join("{value}"),
  }));
  const ran = await runSteps(target, general, wanted);
  // Your answer isn't among the choices and Claude picked the closest one by name ("Website/
  // Social Media" for "LinkedIn"): the field showing that choice is set.
  const instead = ran ? null : await pickedInstead(target, general);
  const ok = ran || instead !== null;
  await help.record(entry.label, general, ok).catch(() => {});
  // Shared with every site using this kind of widget, when nothing in them is this site's own.
  if (ran && kind && portableSteps(general))
    await help.recordWidget?.(kind, general, true).catch(() => {});
  if (ran) return { ok: true, result: `filled with Claude's steps (${steps.length})` };
  if (instead)
    return {
      ok: true,
      result: `Claude's steps picked "${instead}", the closest choice to "${wanted.slice(0, 60)}"`,
    };
  const shown = await target.frame
    .evaluate(shownText, target.selector)
    .catch(() => "");
  // Everything tried, for whoever goes next (Claude on the page, or you): never the same again.
  return {
    ok: false,
    reason: `${tried}; Claude's steps (${describeSteps(general)}) didn't set it either; the field shows "${shown.slice(0, 60)}"`,
  };
}

/** Results of a fill made with saved or Claude's steps (what `rescueField` returns). */
const BY_STEPS = /saved steps|steps that worked|Claude's steps/;

/**
 * A field filled with saved or Claude's steps didn't hold (empty again, or invalid at review):
 * its recipe counts a failure, so a bad one stops being used. Nothing when no steps filled it.
 */
export async function unlearn(
  help: SiteHelp | null,
  label: string,
  result: string | undefined,
): Promise<void> {
  if (!help || !result || !BY_STEPS.test(result)) return;
  const recipe = help.recipes.get(labelKey(label));
  if (recipe) await help.record(label, recipe.steps, false).catch(() => {});
}

/**
 * The choice the steps picked by name (a "pick" without "{value}"), when the field now shows
 * it; else null.
 */
export async function pickedInstead(
  target: RescueTarget,
  steps: readonly ActStep[],
): Promise<string | null> {
  const named = steps
    .filter((s) => s.action === "pick" && !s.value.includes("{value}"))
    .at(-1)?.value;
  if (!named) return null;
  // Typed as it's named: a text box shows it whether or not a choice was clicked (Mastercard's
  // skills box still holding "Bash"), so that's no pick.
  const same = (a: string) => a.trim().toLowerCase() === named.trim().toLowerCase();
  if (steps.some((s) => s.action === "type" && same(s.value))) return null;
  return selectionMatches(await target.readBack(), named) ? named : null;
}

/** Steps as one line for the next attempt to read: click ".x" → type "{value}" → press Enter. */
export function describeSteps(steps: readonly ActStep[]): string {
  return steps
    .map((s) => `${s.action} ${JSON.stringify(s.value.slice(0, 60))}`)
    .join(" → ")
    .slice(0, 400);
}

/** What a field shows (its value or text); runs inside the page. */
function shownText(selector: string): string {
  const el =
    document.querySelector<HTMLInputElement>(selector) ??
    (((window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(selector) as HTMLInputElement | null | undefined) ?? null);
  if (!el) return "";
  return (el.value ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Runs steps with trusted input: clicks only inside the field's surroundings (never a
 * submit / continue / delete button), allowed keys only, short waits. True when the field
 * then shows the value.
 */
async function runSteps(
  target: RescueTarget,
  steps: readonly ActStep[],
  wanted: string,
): Promise<boolean> {
  const { page, frame } = target;
  await frame
    .evaluate(fieldHtml, target.selector, MAX_HTML_CHARS)
    .catch(() => "");
  for (const step of steps) {
    const value = step.value.split("{value}").join(wanted);
    switch (step.action) {
      case "click": {
        const element =
          (await frame
            .$(`[data-ac-box="1"] :is(${value}), [data-ac-box="1"]:is(${value})`)
            .catch(() => null)) ??
          // Inside a web component (its own box is there too), still only in the field's area.
          (await deepFind(frame, value, true));
        if (!element) return false;
        const blocked = await element.evaluate(
          (el, pattern) =>
            (el as HTMLInputElement).type === "submit" ||
            new RegExp(pattern, "i").test(
              `${el.textContent ?? ""} ${(el as HTMLInputElement).value ?? ""} ${el.getAttribute("aria-label") ?? ""}`,
            ),
          FORBIDDEN_CLICK.source,
        );
        if (blocked) return false;
        await element
          .click()
          .catch(() => element.evaluate((el) => (el as HTMLElement).click()));
        break;
      }
      case "type":
        await page.keyboard.sendCharacter(value.slice(0, 2_000));
        break;
      case "press":
        if (!ALLOWED_KEYS.has(value)) return false;
        await page.keyboard.press(value as "Enter");
        break;
      case "pick":
        if (!(await pickOpenChoice(frame, value))) return false;
        break;
      case "wait":
        await sleep(Math.min(Number(value) || 0, MAX_WAIT_MS));
        break;
    }
    await sleep(150);
  }
  await sleep(200);
  return showsValue(await target.readBack(), wanted);
}
