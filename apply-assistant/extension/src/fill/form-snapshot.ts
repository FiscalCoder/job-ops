/**
 * The form's HTML for Claude's closer read of a page (a field got stuck, or you asked): the
 * smallest part of the page holding every field, each field marked `data-aa-field="<i>"` in the
 * order the page was read, with scripts, styles, images and most attributes removed. What you
 * typed is left out: text values are dropped, only the choices' own values stay.
 */

/** The most HTML sent (the server takes no more). */
export const MAX_SNAPSHOT = 60_000;

/** Runs in the page (self-contained): the trimmed HTML around these fields. */
export function trimmedForm(refs: readonly string[], max: number): string {
  const KEEP =
    /^(id|name|type|placeholder|aria-label|aria-labelledby|aria-expanded|aria-haspopup|aria-required|role|for|value|readonly|disabled|multiple|checked|selected|title|class|data-aa-field|data-automation-id|contenteditable)$/;
  const CHOICE = /^(radio|checkbox|submit|button)$/i;
  const found: Element[] = [];
  refs.forEach((ref, i) => {
    let el: Element | null = null;
    try {
      el = document.querySelector(ref);
    } catch {
      el = null;
    }
    if (!el) return;
    el.setAttribute("data-aa-field", String(i));
    found.push(el);
  });
  // The smallest element holding every field (the form), else the whole page.
  let root: Element = found[0]?.parentElement ?? document.body;
  while (root !== document.body && !found.every((e) => root.contains(e)))
    root = root.parentElement ?? document.body;
  const copy = root.cloneNode(true) as Element;
  for (const el of found) el.removeAttribute("data-aa-field");
  for (const gone of copy.querySelectorAll(
    "script, style, link, meta, noscript, template, svg, img, picture, video, canvas, iframe",
  ))
    gone.remove();
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    const tag = el.tagName.toLowerCase();
    const choice =
      tag === "option" ||
      (tag === "input" && CHOICE.test(el.getAttribute("type") ?? ""));
    for (const { name, value } of [...el.attributes]) {
      if (!KEEP.test(name) || (name === "value" && !choice))
        el.removeAttribute(name);
      else if (value.length > 80) el.setAttribute(name, value.slice(0, 80));
    }
    if (tag === "textarea") el.textContent = "";
  }
  return copy.outerHTML
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .slice(0, max);
}
