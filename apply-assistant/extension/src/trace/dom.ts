/**
 * The DOM snapshot for the run trace: the page as the filler sees it, with every field's current
 * value written into the markup, and scripts, styles, media and event handlers removed.
 * Password and one-time-code values are always blanked. Hidden fields are marked
 * data-ac-hidden="1".
 *
 * `captureDom` runs inside the page (puppeteer `frame.evaluate` or `chrome.scripting`), so it
 * must stay self-contained: no imports, no helpers defined outside it, no named inner functions
 * (bundlers can wrap those in helpers that don't exist in the page).
 */

export interface DomCapture {
  readonly html: string;
  readonly url: string;
  readonly title: string;
  /** True when the page was too big and only its forms (or a cut) were kept. */
  readonly trimmed: boolean;
}

export const MAX_DOM_CHARS = 2_500_000;

export function captureDom(maxChars: number): DomCapture {
  const DROP =
    "script,style,link,noscript,template,svg,canvas,video,audio,object,embed,picture source,meta";
  const KEEP_ATTR =
    /^(id|class|name|type|value|checked|selected|disabled|required|readonly|multiple|for|role|href|placeholder|autocomplete|title|alt|src|tabindex|aria-.*|data-.*)$/;
  const SECRET = /password|one-time-code/i;

  // Web components (open shadow roots, nested too) are marked, to write their insides in.
  const hosts: Element[] = [];
  const findHosts = (from: Document | ShadowRoot) => {
    for (const el of from.querySelectorAll("*"))
      if (el.shadowRoot) {
        el.setAttribute("data-ac-sh", String(hosts.length));
        hosts.push(el);
        findHosts(el.shadowRoot);
      }
  };
  findHosts(document);
  const live = document.querySelectorAll("input, textarea, select");
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  const copies = root.querySelectorAll("input, textarea, select");
  for (let i = 0; i < live.length && i < copies.length; i++) {
    const from = live[i] as HTMLInputElement;
    const to = copies[i] as HTMLElement;
    const secret =
      SECRET.test(from.type ?? "") || SECRET.test(from.autocomplete ?? "");
    if (from.type !== "hidden" && from.offsetParent === null)
      to.setAttribute("data-ac-hidden", "1");
    if (from.tagName === "SELECT") {
      const options = (from as unknown as HTMLSelectElement).options;
      const copied = to.querySelectorAll("option");
      for (let j = 0; j < options.length && j < copied.length; j++) {
        if (options[j]?.selected) copied[j]?.setAttribute("selected", "");
        else copied[j]?.removeAttribute("selected");
      }
    } else if (from.tagName === "TEXTAREA") {
      to.textContent = from.value;
    } else if (from.type === "checkbox" || from.type === "radio") {
      if (from.checked) to.setAttribute("checked", "");
      else to.removeAttribute("checked");
    } else if (from.type === "file") {
      const names = [...(from.files ?? [])].map((f) => f.name).join(", ");
      to.setAttribute("data-ac-files", names);
    } else {
      to.setAttribute("value", secret ? "" : from.value);
    }
  }

  // Each component's insides, in a <div data-ac-shadow> inside it, with what its fields hold.
  const pending = [...root.querySelectorAll("[data-ac-sh]")];
  for (let at = pending.shift(); at; at = pending.shift()) {
    const shadow = hosts[Number(at.getAttribute("data-ac-sh"))]?.shadowRoot;
    if (!shadow) continue;
    const box = document.createElement("div");
    box.setAttribute("data-ac-shadow", "");
    for (const child of shadow.childNodes) box.append(child.cloneNode(true));
    const fields = shadow.querySelectorAll("input, textarea, select");
    const copied = box.querySelectorAll("input, textarea, select");
    for (let i = 0; i < fields.length && i < copied.length; i++) {
      const from = fields[i] as HTMLInputElement;
      const to = copied[i] as HTMLElement;
      if (from.type === "checkbox" || from.type === "radio") {
        if (from.checked) to.setAttribute("checked", "");
      } else if (from.type === "file")
        to.setAttribute("data-ac-files", [...(from.files ?? [])].map((f) => f.name).join(", "));
      else if (from.tagName === "TEXTAREA") to.textContent = from.value;
      else if (from.tagName !== "SELECT" && !SECRET.test(from.type ?? "") && !SECRET.test(from.autocomplete ?? ""))
        to.setAttribute("value", from.value);
    }
    at.append(box);
    pending.push(...box.querySelectorAll("[data-ac-sh]"));
  }
  for (const host of hosts) host.removeAttribute("data-ac-sh");
  for (const el of root.querySelectorAll(DROP)) el.remove();
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (!KEEP_ATTR.test(attr.name) || /^\s*javascript:/i.test(attr.value))
        el.removeAttribute(attr.name);
    }
    // Images and frames keep where they pointed, without loading anything.
    if (el.tagName === "IMG" || el.tagName === "IFRAME") {
      const src = el.getAttribute("src");
      el.removeAttribute("src");
      if (src && !src.startsWith("data:")) el.setAttribute("data-src", src);
    }
  }

  let html = `<!doctype html>\n${root.outerHTML}`;
  let trimmed = false;
  if (html.length > maxChars) {
    trimmed = true;
    const forms = [...root.querySelectorAll("form")].map((f) => f.outerHTML);
    html = forms.length ? forms.join("\n") : html;
    if (html.length > maxChars)
      html = `${html.slice(0, maxChars)}\n<!-- cut at ${maxChars} characters -->`;
  }
  return { html, url: location.href, title: document.title, trimmed };
}
