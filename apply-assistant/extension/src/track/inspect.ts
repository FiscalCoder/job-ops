/**
 * Manual applications, recorded (APPLY_TRACE_AND_KIT_PLAN.md, "record manual fills"): what a
 * form page asks and what you answered, so the next filler can be built and taught from it.
 *
 * `watchForm` runs inside the page (chrome.scripting), so it stays self-contained: no imports,
 * nothing from outside it. It returns the page's fields now, and (once per page) installs
 * listeners that report each answer you change and every Next / Continue / Submit click.
 * Password and one-time-code values are never read.
 */

export interface PageField {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly id: string;
  /** Workday and others mark fields with data-automation-id. */
  readonly automationId: string;
  readonly label: string;
  readonly required: boolean;
  readonly options: readonly string[];
  readonly value: string | readonly string[];
  readonly hidden: boolean;
}

export interface FormPage {
  readonly url: string;
  readonly title: string;
  /** The page's own heading, such as Workday's step name ("My Information"). */
  readonly heading: string;
  readonly fields: readonly PageField[];
}

/** Messages the page sends to the background. */
export type WatchMessage =
  | {
      readonly type: "manual-field";
      readonly url: string;
      readonly field: PageField;
    }
  | {
      readonly type: "manual-step";
      readonly url: string;
      readonly button: string;
      readonly page: FormPage;
    };

export function watchForm(install: boolean): FormPage {
  const SECRET = /password|one-time-code|otp/i;
  const SKIP = /^(hidden|submit|button|reset|image)$/i;
  const STEP = /\b(next|continue|submit|save|review|apply|finish|send)\b/i;
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  const labelOf = (el: HTMLElement): string => {
    const input = el as HTMLInputElement;
    const byIds = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .join(" ")
      .trim();
    const box = el.closest(
      "[data-automation-id^='formField'], fieldset, .application-question, .field, [class*='field']",
    );
    return (
      text(input.labels?.[0]) ||
      el.getAttribute("aria-label") ||
      byIds ||
      text(el.closest("label")) ||
      text(box?.querySelector("label, legend")) ||
      el.getAttribute("placeholder") ||
      ""
    ).slice(0, 300);
  };

  const automationIdOf = (el: HTMLElement) =>
    el.getAttribute("data-automation-id") ??
    el.closest("[data-automation-id]")?.getAttribute("data-automation-id") ??
    "";

  const describe = (el: HTMLElement): PageField => {
    const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    const isDropdownButton =
      tag === "button" && el.getAttribute("aria-haspopup") === "listbox";
    const type = isDropdownButton
      ? "dropdown"
      : tag === "select"
        ? "select"
        : tag === "textarea"
          ? "textarea"
          : el.getAttribute("role") === "combobox" && tag !== "input"
            ? "combobox"
            : (input.type || "text").toLowerCase();
    const secret =
      SECRET.test(input.type ?? "") ||
      SECRET.test(el.getAttribute("autocomplete") ?? "") ||
      SECRET.test(input.name ?? "");
    let value: string | string[] = "";
    let options: string[] = [];
    if (tag === "select") {
      const select = el as unknown as HTMLSelectElement;
      options = [...select.options].map((o) => o.text.trim()).slice(0, 80);
      value = [...select.selectedOptions].map((o) => o.text.trim());
    } else if (type === "checkbox" || type === "radio") {
      const group = input.name
        ? [
            ...document.querySelectorAll<HTMLInputElement>(
              `input[name="${input.name.replace(/["\\]/g, "")}"]`,
            ),
          ]
        : [input];
      const optionLabel = (i: HTMLInputElement) =>
        text(i.labels?.[0]) || i.getAttribute("aria-label") || i.value;
      options = group.map(optionLabel).slice(0, 80);
      value = group.filter((i) => i.checked).map(optionLabel);
    } else if (type === "file") {
      value = [...(input.files ?? [])].map((f) => f.name);
    } else if (isDropdownButton || type === "combobox") {
      value = text(el);
    } else if (!secret) {
      value = el.isContentEditable ? text(el) : (input.value ?? "");
    }
    return {
      tag,
      type,
      name: input.name ?? "",
      id: el.id,
      automationId: automationIdOf(el),
      label: labelOf(el),
      required:
        input.required === true || el.getAttribute("aria-required") === "true",
      options,
      value,
      hidden: el.offsetParent === null,
    };
  };

  const fieldsNow = (): PageField[] => {
    const seenGroups = new Set<string>();
    const found: PageField[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      "input, select, textarea, button[aria-haspopup='listbox'], [role='combobox']:not(input), [contenteditable='true']",
    )) {
      const input = el as HTMLInputElement;
      if (el.tagName === "INPUT" && SKIP.test(input.type)) continue;
      if (input.type === "checkbox" || input.type === "radio") {
        const key = input.name || input.id;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
      }
      found.push(describe(el));
    }
    return found;
  };

  const page = (): FormPage => ({
    url: location.href,
    title: document.title,
    heading: text(
      document.querySelector(
        "[data-automation-id='pageHeader'], [data-automation-id='progressBarActiveStep'], h2, h1",
      ),
    ).slice(0, 200),
    fields: fieldsNow(),
  });

  const flag = window as unknown as { __applyCopilotWatch?: boolean };
  if (install && !flag.__applyCopilotWatch) {
    flag.__applyCopilotWatch = true;
    const send = (message: WatchMessage) => {
      chrome.runtime.sendMessage(message).catch(() => {});
    };
    const onAnswer = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (!el?.matches?.("input, select, textarea, [contenteditable='true']"))
        return;
      const input = el as HTMLInputElement;
      if (el.tagName === "INPUT" && SKIP.test(input.type)) return;
      send({ type: "manual-field", url: location.href, field: describe(el) });
    };
    document.addEventListener("change", onAnswer, true);
    document.addEventListener(
      "click",
      (event) => {
        const target = (event.target as HTMLElement | null)?.closest?.(
          "button, [role='button'], input[type='submit']",
        ) as HTMLElement | null;
        if (!target) return;
        const name = `${text(target)} ${target.getAttribute("data-automation-id") ?? ""} ${(target as HTMLInputElement).value ?? ""}`;
        if (!STEP.test(name)) return;
        send({
          type: "manual-step",
          url: location.href,
          button: text(target).slice(0, 80) || name.trim().slice(0, 80),
          page: page(),
        });
      },
      true,
    );
  }
  return page();
}
