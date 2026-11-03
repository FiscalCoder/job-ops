/**
 * What "Let Claude do it" runs inside the page: the outline of the field's area Claude sees
 * beside the screenshot, and the checks every action passes before it happens. Each function
 * runs in the page's frame, so each is self-contained.
 */

import type { Locator } from "./locate";

/** Why an action was refused (null: allowed), and what to save as a step if it worked. */
export interface Inspection {
  readonly refused: string | null;
  readonly learn: { readonly action: "click" | "pick"; readonly value: string } | null;
}

/**
 * Marks the field's area (data-ac-box, as for Claude's HTML steps) and lists the elements in it
 * and in any list or dialog open on the page: ref, role, name, value, state and box in the
 * screenshot's pixels. Values of password fields are never listed.
 */
export function outlineField(
  selector: string,
  offsetX: number,
  offsetY: number,
  scale: number,
  limit: number,
): string {
  // The locator (installed first): fields and lists inside web components too.
  const ac = (window as unknown as { __ac?: Locator }).__ac;
  const MARKS = "[data-ac-el], [data-ac-box], [data-ac-target]";
  for (const el of ac ? ac.all(MARKS) : document.querySelectorAll(MARKS)) {
    el.removeAttribute("data-ac-el");
    el.removeAttribute("data-ac-box");
    el.removeAttribute("data-ac-target");
  }
  const target = document.querySelector(selector) ?? (window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(selector) ?? null;
  if (!target) return "";
  target.setAttribute("data-ac-target", "1");
  // The field's own area: up from the field until a parent holds another field too (out of
  // a web component to the component itself, its neighbours' insides counted).
  const CONTROLS = "input:not([type=hidden]), select, textarea, [role=combobox]";
  const controls = (el: Element) =>
    ac ? ac.all(CONTROLS, el).length : el.querySelectorAll(CONTROLS).length;
  let box: Element = target;
  for (let depth = 0; depth < 6; depth++) {
    const parent: Element | null = ac ? ac.parent(box) : box.parentElement;
    if (!parent || parent === document.body || parent.outerHTML.length > 8_000) break;
    if (controls(parent) > Math.max(controls(box), 1)) break;
    box = parent;
  }
  box.setAttribute("data-ac-box", "1");

  const INTERACTIVE =
    "input:not([type=hidden]), select, textarea, button, a[href], label, [role=button], [role=option], [role=combobox], [role=checkbox], [role=radio], [role=menuitem], [role=gridcell], [role=switch], [role=tab], [role=textbox], [tabindex]:not([tabindex='-1'])";
  const POPUPS = "[role=listbox], [role=menu], [role=dialog], [role=grid], [role=tree]";
  const text = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true });
  };
  const px = (v: number) => Math.round(v * scale);
  const boxOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return `[${px(r.x + offsetX)},${px(r.y + offsetY)},${px(r.width)},${px(r.height)}]`;
  };
  const roleOf = (el: Element) => {
    const role = el.getAttribute("role");
    if (role) return role;
    const input = el as HTMLInputElement;
    if (el.tagName === "INPUT") return input.type === "text" ? "textbox" : input.type;
    return { A: "link", SELECT: "select", TEXTAREA: "textbox", BUTTON: "button", LABEL: "label" }[
      el.tagName
    ] ?? el.tagName.toLowerCase();
  };
  const nameOf = (el: Element) => {
    const input = el as HTMLInputElement;
    const labelled = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)?.textContent))
      .join(" ")
      .trim();
    return (
      text(el.getAttribute("aria-label")) ||
      labelled ||
      text(input.labels?.[0]?.textContent) ||
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "" : text(el.textContent)) ||
      text(input.placeholder)
    ).slice(0, 80);
  };
  const line = (el: Element, ref: string) => {
    const input = el as HTMLInputElement;
    const secret =
      input.type === "password" || /one-time-code/i.test(input.autocomplete ?? "");
    const value =
      el.tagName === "SELECT"
        ? text((el as HTMLSelectElement).selectedOptions[0]?.textContent)
        : "value" in input && typeof input.value === "string" && !/checkbox|radio/.test(input.type)
          ? secret
            ? "[hidden]"
            : input.value.slice(0, 80)
          : "";
    const states = [
      input.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "",
      el.getAttribute("aria-selected") === "true" ? "selected" : "",
      el.getAttribute("aria-expanded") === "true" ? "expanded" : "",
      input.disabled || el.getAttribute("aria-disabled") === "true" ? "disabled" : "",
      el === target || el.closest("[data-ac-target]") ? "target" : "",
    ].filter(Boolean);
    return `${ref} ${roleOf(el)} "${nameOf(el)}"${value ? ` value="${value}"` : ""}${
      states.length ? ` (${states.join(", ")})` : ""
    } box=${boxOf(el)}`;
  };

  const lines: string[] = [`Field area box=${boxOf(box)}`];
  let n = 0;
  const add = (els: Iterable<Element>) => {
    for (const el of els) {
      if (n >= limit || el.hasAttribute("data-ac-el") || !visible(el)) continue;
      const ref = `e${++n}`;
      el.setAttribute("data-ac-el", ref);
      lines.push(line(el, ref));
    }
  };
  add(
    [box, ...(ac ? ac.all(INTERACTIVE, box) : box.querySelectorAll(INTERACTIVE))].filter((el) =>
      el.matches(INTERACTIVE),
    ),
  );
  const inside = (outer: Element, el: Element) => outer.contains(el) || !!ac?.contains(outer, el);
  for (const popup of ac ? ac.all(POPUPS) : document.querySelectorAll(POPUPS)) {
    if (inside(box, popup) || !visible(popup)) continue;
    lines.push(`Open ${roleOf(popup)} "${nameOf(popup).slice(0, 40)}" box=${boxOf(popup)}:`);
    add(ac ? ac.all(INTERACTIVE, popup) : popup.querySelectorAll(INTERACTIVE));
  }
  if (n >= limit) lines.push(`(more elements not listed)`);
  return lines.join("\n");
}

/**
 * The checks before a click: on an element by ref, or on whatever is at a point. Refuses
 * Apply Copilot's own banner, anything that submits, applies, saves, continues, deletes or
 * uploads, links that leave the page, and anything outside the field's area or a list it
 * opened. What it clicked becomes a saved step: a selector inside the field, or the text of
 * the option picked from a list.
 */
export function inspectTarget(
  /** "ref" (refOrX is an outline ref) or "point" (refOrX, y in the frame's CSS pixels). */
  mode: string,
  refOrX: string | number,
  y: number,
  forbidden: string,
): Inspection {
  // The locator (installed first): what's inside a web component is the field's, not its host's.
  const ac = (window as unknown as { __ac?: Locator }).__ac;
  const closest = (from: Element, selector: string) =>
    from.closest(selector) ?? ac?.closest(from, selector) ?? null;
  const elRef = `[data-ac-el="${String(refOrX).replace(/["\\]/g, "")}"]`;
  const el =
    mode === "ref"
      ? (document.querySelector(elRef) ?? ac?.one(elRef) ?? null)
      : (ac?.fromPoint(Number(refOrX), y) ?? document.elementFromPoint(Number(refOrX), y));
  if (!el) return { refused: "Nothing there", learn: null };
  if (closest(el, "#ac-operate-banner, #ac-badge"))
    return { refused: "That's Apply Copilot's banner", learn: null };
  const text = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const actionable =
    closest(el, "a[href], button, input, [role=button], [role=link], [role=menuitem], [role=option], label") ??
    el;
  const input = actionable as HTMLInputElement;
  const opensList =
    actionable.hasAttribute("aria-haspopup") ||
    actionable.hasAttribute("aria-expanded") ||
    /^(combobox|option|tab)$/.test(actionable.getAttribute("role") ?? "");
  if (
    (actionable.tagName === "INPUT" && /^(submit|image|reset)$/.test(input.type)) ||
    (actionable.tagName === "BUTTON" &&
      !opensList &&
      (input.type === "submit" ||
        (!actionable.getAttribute("type") && actionable.closest("form") !== null)))
  )
    return { refused: "Refused: that button submits the form", learn: null };
  const words = text(
    `${actionable.textContent ?? ""} ${input.value ?? ""} ${actionable.getAttribute("aria-label") ?? ""}`,
  ).slice(0, 120);
  const command = /^(A|BUTTON|INPUT)$/.test(actionable.tagName) || /^(button|link)$/.test(actionable.getAttribute("role") ?? "");
  if (command && !opensList && new RegExp(forbidden, "i").test(words))
    return { refused: `Refused: "${words.slice(0, 40)}" would submit, move on or delete`, learn: null };
  const href = actionable.getAttribute("href");
  if (actionable.tagName === "A" && href && !/^(#|javascript:)/i.test(href))
    return { refused: "Refused: that link leaves the page", learn: null };
  const box = document.querySelector("[data-ac-box='1']") ?? ac?.one("[data-ac-box='1']") ?? null;
  const inBox = !!box && (box.contains(el) || !!ac?.contains(box, el));
  const popup = closest(el, 
    "[role=listbox], [role=option], [role=menu], [role=menuitem], [role=dialog], [role=grid], [role=tree], [class*='menu' i], [class*='popover' i], [class*='dropdown' i], [class*='picker' i], [class*='calendar' i], [class*='option' i]",
  );
  if (!inBox && !popup) return { refused: "Refused: that's outside this field", learn: null };
  if (!inBox) {
    const label = text(actionable.textContent).slice(0, 120);
    return { refused: null, learn: label ? { action: "pick", value: label } : null };
  }
  // A selector that finds just this element inside the field's area.
  const tag = actionable.tagName.toLowerCase();
  const candidates = [
    actionable.id ? `#${CSS.escape(actionable.id)}` : "",
    ...["data-automation-id", "data-testid", "name", "aria-label", "for", "value"].map((attr) => {
      const v = actionable.getAttribute(attr);
      return v && v.length < 80 ? `${tag}[${attr}="${v.replace(/["\\]/g, "\\$&")}"]` : "";
    }),
  ].filter(Boolean);
  const selector = candidates.find((s) => {
    try {
      const found = box ? (ac ? ac.all(s, box) : [...box.querySelectorAll(s)]) : [];
      return found.length === 1 && found[0] === actionable;
    } catch {
      return false;
    }
  });
  return { refused: null, learn: selector ? { action: "click", value: selector } : null };
}

/** Typing only into the field (or a search box of a list it opened), never a password. */
export function focusCheck(forEnter: boolean): string | null {
  // Run in the frame that has the focus (the caller finds it).
  // Focus inside a web component: the element itself, not the component.
  const ac = (window as unknown as { __ac?: Locator }).__ac;
  const el = ac?.focused() ?? document.activeElement;
  const closest = (selector: string) => el?.closest(selector) ?? (el && ac?.closest(el, selector)) ?? null;
  if (!el || el === document.body || el.tagName === "IFRAME") return forEnter ? null : "Refused: nothing has focus to type into";
  const input = el as HTMLInputElement;
  if (input.type === "password" || /one-time-code/i.test(input.autocomplete ?? "") || /\botp\b/i.test(input.name ?? ""))
    return "Refused: that's a password or one-time-code field";
  const inField =
    !!closest("[data-ac-box='1']") ||
    !!closest("[role=listbox], [role=menu], [role=dialog], [role=grid], [role=combobox]");
  if (!inField) return "Refused: the focus is outside this field";
  if (!forEnter) return null;
  // Enter in a plain text box submits its form: only where it picks (a combobox, a list).
  const picks =
    el.tagName === "SELECT" ||
    /^(combobox|option|listbox|searchbox)$/.test(el.getAttribute("role") ?? "") ||
    el.hasAttribute("aria-autocomplete") ||
    el.hasAttribute("aria-expanded") ||
    el.hasAttribute("aria-activedescendant") ||
    !!closest("[role=listbox], [role=menu], [role=grid]");
  return picks ? null : "Refused: Enter here could submit the form";
}
