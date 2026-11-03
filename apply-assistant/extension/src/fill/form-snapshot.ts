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
    /^(id|name|type|placeholder|aria-label|aria-labelledby|aria-expanded|aria-haspopup|aria-required|role|for|value|readonly|disabled|multiple|checked|selected|title|class|data-aa-field|data-automation-id|contenteditable|data-test|data-testid|data-qa|data-cy|aria-autocomplete|aria-controls)$/;
  const CHOICE = /^(radio|checkbox|submit|button)$/i;
  const found: Element[] = [];
  refs.forEach((ref, i) => {
    let el: Element | null = null;
    try {
      el = (document.querySelector(ref) ?? (window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(ref) ?? null);
    } catch {
      el = null;
    }
    if (!el) return;
    el.setAttribute("data-aa-field", String(i));
    found.push(el);
  });
  // A field inside a web component counts as its outermost host on the page.
  const onPage = (e: Element): Element => {
    let node = e;
    for (let root = node.getRootNode(); root instanceof ShadowRoot; root = node.getRootNode())
      node = root.host;
    return node;
  };
  const placed = found.map(onPage);
  // The smallest element holding every field (the form), else the whole page.
  let root: Element = placed[0]?.parentElement ?? document.body;
  while (root !== document.body && !placed.every((e) => root.contains(e)))
    root = root.parentElement ?? document.body;
  // A copy with each web component's own content (its shadow root) written in, where its
  // fields are, so Claude reads what's on screen: inside <shadow-root> in the component, so
  // Claude knows where one starts (its ids are its own: "host >>> inner" finds them).
  const flat = (node: Node): Node => {
    const copy = node.cloneNode(false);
    const shadow = node instanceof Element ? node.shadowRoot : null;
    if (shadow) {
      const inside = document.createElement("shadow-root");
      for (const child of shadow.childNodes) inside.appendChild(flat(child));
      copy.appendChild(inside);
    }
    for (const child of node.childNodes) copy.appendChild(flat(child));
    return copy;
  };
  const copy = flat(root) as Element;
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
