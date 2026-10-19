/**
 * Greenhouse form fillers. Runs in the page (extension content script, or injected
 * by the M0 spike). Every filler returns a FillResult that the supervision layer logs.
 * No filler ever clicks Submit.
 *
 * M0 finding: synthetic input (fillText / selectOption below) is NOT reliable on
 * Greenhouse. Dropdowns ignore it, and text set this way is wiped when the form
 * re-renders. Real filling goes through trusted input (chrome.debugger). These
 * helpers stay useful for locating fields, reading values back (readField,
 * emptyRequired) and checkbox groups.
 */

export type FillStatus =
  | "ok"
  | "mismatch"
  | "not_found"
  | "no_option"
  | "error";

export interface FillResult {
  readonly fieldId: string;
  readonly kind: string;
  readonly requested: string;
  readonly readBack: string;
  readonly status: FillStatus;
  readonly detail?: string;
}

const OPTION_WAIT_MS = 2500;
const POLL_MS = 100;

function result(
  fieldId: string,
  kind: string,
  requested: string,
  readBack: string,
  status: FillStatus,
  detail?: string,
): FillResult {
  return {
    fieldId,
    kind,
    requested,
    readBack,
    status,
    ...(detail ? { detail } : {}),
  };
}

function byId(
  doc: Document,
  id: string,
): HTMLInputElement | HTMLTextAreaElement | null {
  return doc.getElementById(id) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
}

/** Set a value the way React expects: native setter + input/change events. */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs: number,
): Promise<T | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = probe();
    if (value) return value;
    await sleep(POLL_MS);
  }
  return null;
}

const normalize = (text: string) =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

/** Plain text / textarea / tel / email inputs. */
export function fillText(
  doc: Document,
  fieldId: string,
  value: string,
): FillResult {
  const el = byId(doc, fieldId);
  if (!el) return result(fieldId, "text", value, "", "not_found");
  el.focus();
  setNativeValue(el, value);
  el.blur();
  const readBack = el.value;
  return result(
    fieldId,
    "text",
    value,
    readBack,
    readBack === value ? "ok" : "mismatch",
  );
}

/** The visible value of a react-select combobox (single value chip). */
function comboboxValue(input: HTMLElement): string {
  const container =
    input.closest(".select__control, [class*='control']")?.parentElement ??
    input.parentElement;
  const single = container?.querySelector(
    ".select__single-value, [class*='singleValue'], [class*='single-value']",
  );
  const multi = [
    ...(container?.querySelectorAll(
      ".select__multi-value__label, [class*='multiValue'] [class*='label']",
    ) ?? []),
  ];
  if (single) return single.textContent?.trim() ?? "";
  return multi
    .map((m) => m.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
}

function visibleOptions(doc: Document): HTMLElement[] {
  return [
    ...doc.querySelectorAll<HTMLElement>(".select__option, [role='option']"),
  ].filter((el) => el.offsetParent !== null);
}

function pickOption(
  options: HTMLElement[],
  wanted: string,
): HTMLElement | null {
  const target = normalize(wanted);
  return (
    options.find((o) => normalize(o.textContent ?? "") === target) ??
    options.find((o) => normalize(o.textContent ?? "").startsWith(target)) ??
    options.find((o) => normalize(o.textContent ?? "").includes(target)) ??
    null
  );
}

function pressDown(el: HTMLElement): void {
  el.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
}

function clickOption(option: HTMLElement): void {
  option.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  option.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
  );
  option.click();
}

/**
 * Searchable dropdown (react-select). Types `search` (defaults to the wanted option) to
 * filter, then clicks the matching option. Works for static and async option lists.
 */
export async function selectOption(
  doc: Document,
  fieldId: string,
  wanted: string,
  search: string = wanted,
): Promise<FillResult> {
  const input = byId(doc, fieldId) as HTMLInputElement | null;
  if (!input) return result(fieldId, "select", wanted, "", "not_found");
  input.focus();
  pressDown(input);
  setNativeValue(input, search);
  const option = await waitFor(
    () => pickOption(visibleOptions(doc), wanted),
    OPTION_WAIT_MS,
  );
  if (!option) {
    const seen = visibleOptions(doc)
      .slice(0, 5)
      .map((o) => o.textContent?.trim())
      .join(" | ");
    setNativeValue(input, "");
    input.blur();
    return result(
      fieldId,
      "select",
      wanted,
      comboboxValue(input),
      "no_option",
      seen ? `options: ${seen}` : "no options shown",
    );
  }
  clickOption(option);
  await sleep(150);
  const readBack = comboboxValue(input);
  const ok =
    normalize(readBack).includes(normalize(wanted)) ||
    (normalize(wanted).includes(normalize(readBack)) && readBack !== "");
  return result(fieldId, "select", wanted, readBack, ok ? "ok" : "mismatch");
}

/** Checkbox groups (e.g. pronouns): tick the boxes whose label matches. */
export function checkBoxes(
  doc: Document,
  name: string,
  labels: readonly string[],
): FillResult {
  const boxes = [
    ...doc.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][name="${CSS.escape(name)}"]`,
    ),
  ];
  if (boxes.length === 0)
    return result(name, "checkbox", labels.join(", "), "", "not_found");
  const labelOf = (box: HTMLInputElement) =>
    normalize(
      doc.querySelector(`label[for="${CSS.escape(box.id)}"]`)?.textContent ??
        box.closest("label")?.textContent ??
        "",
    );
  for (const box of boxes) {
    const shouldCheck = labels.some((l) => labelOf(box) === normalize(l));
    if (box.checked !== shouldCheck) box.click();
  }
  const readBack = boxes
    .filter((b) => b.checked)
    .map(labelOf)
    .join(", ");
  const ok = labels.every((l) => readBack.includes(normalize(l)));
  return result(
    name,
    "checkbox",
    labels.join(", "),
    readBack,
    ok ? "ok" : "mismatch",
  );
}

/** File inputs (resume / cover letter): assign a File via DataTransfer. */
export async function attachFile(
  doc: Document,
  fieldId: string,
  file: File,
): Promise<FillResult> {
  const input = byId(doc, fieldId) as HTMLInputElement | null;
  if (!input || input.type !== "file")
    return result(fieldId, "file", file.name, "", "not_found");
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(800);
  const attached = input.files?.[0]?.name ?? "";
  const shown = doc.body.textContent?.includes(file.name) ?? false;
  return result(
    fieldId,
    "file",
    file.name,
    attached,
    attached === file.name ? "ok" : "mismatch",
    shown ? "filename shown on page" : "filename not shown on page",
  );
}

/** Click a section's "Add another" button (education / employment repeaters). */
export function clickAddAnother(
  doc: Document,
  sectionIdPrefix: string,
): FillResult {
  const anchor = doc.querySelector(`[id^="${CSS.escape(sectionIdPrefix)}"]`);
  const scope =
    anchor?.closest(
      "fieldset, section, div[class*='education'], div[class*='employment']",
    ) ?? doc;
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => /add another/i.test(b.textContent ?? ""),
  );
  if (!button)
    return result(sectionIdPrefix, "repeater", "add", "", "not_found");
  const before = doc.querySelectorAll(
    `[id^="${CSS.escape(sectionIdPrefix)}"]`,
  ).length;
  button.click();
  const after = doc.querySelectorAll(
    `[id^="${CSS.escape(sectionIdPrefix)}"]`,
  ).length;
  return result(
    sectionIdPrefix,
    "repeater",
    "add",
    `${before}→${after}`,
    after > before ? "ok" : "mismatch",
  );
}

/** Read the current value of any field by id (text, combobox, or file). */
export function readField(doc: Document, fieldId: string): string {
  const el = byId(doc, fieldId);
  if (!el) return "";
  if (el instanceof HTMLInputElement && el.type === "file")
    return el.files?.[0]?.name ?? "";
  if (el.getAttribute("role") === "combobox" || el.closest(".select__control"))
    return comboboxValue(el);
  return el.value;
}

/** Required fields that are still empty, as the pre-submit review sees them. */
export function emptyRequired(doc: Document): string[] {
  return [
    ...doc.querySelectorAll<HTMLInputElement>(
      "input[aria-required='true'], input[required], textarea[required]",
    ),
  ]
    .filter(
      (el) =>
        el.id &&
        el.type !== "hidden" &&
        el.offsetParent !== null &&
        readField(doc, el.id) === "",
    )
    .map((el) => el.id);
}
