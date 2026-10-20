/**
 * Apply kit on the current tab (APPLY_TRACE_AND_KIT_PLAN.md §T2): put a value into the field
 * you focused, or attach the tailored resume to the page's upload field. Only on sites you
 * allowed, never on LinkedIn. Otherwise the side panel copies to the clipboard instead.
 *
 * The functions passed to chrome.scripting run inside the page, so they stay self-contained:
 * no imports, no outside helpers, no named inner functions.
 */

export interface FieldInfo {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly id: string;
  readonly label: string;
  readonly autocomplete: string;
}

export interface FocusedResult {
  readonly field: FieldInfo;
  /** What the field shows after inserting (only when a value was given). */
  readonly shown?: string;
}

/** Describes the focused editable field (value null), or types `value` into it. */
export function focusedField(value: string | null): FocusedResult | null {
  let el = document.activeElement as HTMLElement | null;
  while (el?.shadowRoot?.activeElement)
    el = el.shadowRoot.activeElement as HTMLElement;
  if (!el) return null;
  const input = el as HTMLInputElement;
  const textTypes = /^(text|email|tel|url|number|search|date|month)?$/;
  const editable =
    (el.tagName === "INPUT" && textTypes.test(input.type ?? "")) ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable;
  if (!editable || input.disabled || input.readOnly) return null;

  const byIds = (el.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ")
    .trim();
  const label =
    input.labels?.[0]?.textContent?.trim() ||
    el.getAttribute("aria-label") ||
    byIds ||
    el.closest("label")?.textContent?.trim() ||
    el.getAttribute("placeholder") ||
    "";
  const field = {
    tag: el.tagName.toLowerCase(),
    type: el.isContentEditable ? "contenteditable" : (input.type ?? ""),
    name: el.getAttribute("name") ?? "",
    id: el.id,
    label: label.replace(/\s+/g, " ").slice(0, 200),
    autocomplete: el.getAttribute("autocomplete") ?? "",
  };
  if (value === null) return { field };

  el.focus();
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, value);
    return { field, shown: el.innerText };
  }
  input.select();
  // insertText goes through the browser's editing path, so React and friends see real input.
  const inserted =
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, value);
  if (!inserted || input.value !== value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { field, shown: input.value };
}

export interface UploadField {
  readonly field: FieldInfo;
  /** Higher is a better match for a resume (name/label says resume or CV, accepts PDF). */
  readonly score: number;
}

/** Finds the page's best resume upload field (attach false), or attaches the PDF to it. */
export function resumeUpload(
  attach: { base64: string; name: string } | null,
): UploadField | null {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>("input[type=file]"),
  ];
  let best: HTMLInputElement | null = null;
  let bestScore = -1;
  let bestLabel = "";
  for (const input of inputs) {
    const label = (
      input.labels?.[0]?.textContent ??
      input.getAttribute("aria-label") ??
      input.closest("label, fieldset, [class*=field], [class*=upload]")
        ?.textContent ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const text = `${input.name} ${input.id} ${label}`.toLowerCase();
    let score = 0;
    if (/resume|cv|curriculum/.test(text)) score += 3;
    if (/cover/.test(text)) score -= 3;
    if (/pdf/.test(input.accept.toLowerCase()) || !input.accept) score += 1;
    if (score > bestScore) {
      best = input;
      bestScore = score;
      bestLabel = label;
    }
  }
  if (!best) return null;
  const field = {
    tag: "input",
    type: "file",
    name: best.name,
    id: best.id,
    label: bestLabel.slice(0, 200),
    autocomplete: "",
  };
  if (attach) {
    const bytes = Uint8Array.from(atob(attach.base64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([bytes], attach.name, { type: "application/pdf" }),
    );
    best.files = transfer.files;
    best.dispatchEvent(new Event("input", { bubbles: true }));
    best.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { field, score: bestScore };
}

export type PageFillOutcome =
  | {
      readonly ok: true;
      readonly field: FieldInfo;
      readonly host: string;
      readonly path: string;
    }
  | { readonly ok: false; readonly reason: string };

export const ALL_SITES = "https://*/*";

/** Why the kit can't touch this tab, or null when it may. */
export async function pageBlock(
  tab: chrome.tabs.Tab | undefined,
): Promise<string | null> {
  if (tab?.id === undefined) return "No page is open";
  // Chrome hides the address of sites the extension may not access.
  if (!tab.url) return "Company sites aren't allowed yet";
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return "No page is open";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "This isn't a web page";
  if (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))
    return "LinkedIn: copy only";
  const allowed = await chrome.permissions.contains({
    origins: [`${url.origin}/*`],
  });
  return allowed ? null : "Company sites aren't allowed yet";
}

const isWebPage = (tab: chrome.tabs.Tab) => /^https?:/.test(tab.url ?? "");

/**
 * The page you're applying on: the window's active tab, or (when that is the kit itself, opened
 * as a tab) the web page you used last.
 */
export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // In the side panel there is no "current tab"; only the kit opened as a tab has one.
  const self = await chrome.tabs.getCurrent();
  if (!self || tab?.id !== self.id) return tab;
  const pages = (await chrome.tabs.query({})).filter(isWebPage);
  return pages.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

const where = (tab: chrome.tabs.Tab) => {
  const url = new URL(tab.url ?? "");
  return { host: url.host, path: url.pathname };
};

/** The frame to act in: the best-scoring match, the top frame winning ties. */
export function pickFrame<T>(
  results: readonly { frameId: number; result?: T | null }[],
  score: (result: T) => number,
): number | null {
  const found = results.filter(
    (r): r is { frameId: number; result: T } =>
      r.result !== null && r.result !== undefined,
  );
  const [best] = [...found].sort(
    (a, b) =>
      score(b.result) - score(a.result) ||
      Number(b.frameId === 0) - Number(a.frameId === 0),
  );
  return best?.frameId ?? null;
}

/** Types the value into the focused field of the current tab. */
export async function fillFocusedField(
  value: string,
): Promise<PageFillOutcome> {
  const tab = await activeTab();
  const blocked = await pageBlock(tab);
  if (blocked || tab?.id === undefined)
    return { ok: false, reason: blocked ?? "No page is open" };
  const probes = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: focusedField,
    args: [null],
  });
  const frameId = pickFrame(probes, () => 0);
  if (frameId === null)
    return { ok: false, reason: "No field is selected on the page" };
  const [done] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func: focusedField,
    args: [value],
  });
  const result = done?.result;
  if (!result) return { ok: false, reason: "The field lost focus" };
  if (result.shown !== undefined && result.shown.trim() !== value.trim())
    return {
      ok: false,
      reason: `The field didn't keep it (shows "${result.shown.slice(0, 40)}")`,
    };
  return { ok: true, field: result.field, ...where(tab) };
}

/** Attaches the PDF to the page's resume upload field. */
export async function attachResumeToPage(resume: {
  base64: string;
  name: string;
}): Promise<PageFillOutcome> {
  const tab = await activeTab();
  const blocked = await pageBlock(tab);
  if (blocked || tab?.id === undefined)
    return { ok: false, reason: blocked ?? "No page is open" };
  const probes = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: resumeUpload,
    args: [null],
  });
  const frameId = pickFrame(probes, (r) => r.score);
  if (frameId === null)
    return { ok: false, reason: "No upload field on this page" };
  const [done] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func: resumeUpload,
    args: [resume],
  });
  if (!done?.result) return { ok: false, reason: "The upload field went away" };
  return { ok: true, field: done.result.field, ...where(tab) };
}
