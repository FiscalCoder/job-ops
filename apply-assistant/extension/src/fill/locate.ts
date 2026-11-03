import type { ElementHandle, Frame, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";

/**
 * One way to find an element, wherever the page keeps it: the page itself, inside web
 * components (open shadow roots, nested ones too), or another frame. Every lookup that finds
 * nothing the usual way falls back to this, so a selector Claude or a saved step gives
 * ("#spl-form-element_10", "spl-autocomplete >>> input") reaches a field inside a component.
 *
 * In the page it's window.__ac, installed by installLocator (any frame, any time; idempotent).
 * Code that runs inside the page uses it when it's there and its own lookup found nothing.
 */
export interface Locator {
  /** The page and every open shadow root in it. */
  roots(): (Document | ShadowRoot)[];
  /** Every match, in the page and inside components ("a >>> b": b inside a's component). */
  all(selector: string, scope?: Element | null): Element[];
  /** The first match: the page's own first, then inside components. */
  one(selector: string, scope?: Element | null): Element | null;
  /** The parent, through a component's boundary (an element at a shadow root's top: its host). */
  parent(el: Element): Element | null;
  /** True when b is a or inside it, components included. */
  contains(a: Element, b: Element): boolean;
  /** el.closest, through components' boundaries. */
  closest(el: Element, selector: string): Element | null;
  /** The innermost element at a point (inside a component, not its host). */
  fromPoint(x: number, y: number): Element | null;
  /** The element with the focus, inside components too. */
  focused(): Element | null;
  /** Shown on screen (a list in a fixed-position popup too). */
  visible(el: Element): boolean;
  /** Marks the element so the extension can take hold of it ("pierce/[data-ac-hit='n']"). */
  mark(el: Element): string;
}

/** Installs window.__ac in this frame. Runs inside the page: self-contained. */
export function installLocator(): void {
  const w = window as unknown as {
    __ac?: Locator;
    __acDeep?: (s: string) => Element | null;
    __acDeepAll?: (s: string) => Element[];
  };
  if (w.__ac) return;
  const shadowRoots = (from: Document | ShadowRoot | Element): ShadowRoot[] => {
    const found: ShadowRoot[] = [];
    const visit = (node: Document | ShadowRoot | Element) => {
      if (node instanceof Element && node.shadowRoot) {
        found.push(node.shadowRoot);
        visit(node.shadowRoot);
      }
      for (const el of node.querySelectorAll("*"))
        if (el.shadowRoot) {
          found.push(el.shadowRoot);
          visit(el.shadowRoot);
        }
    };
    visit(from);
    return found;
  };
  const safeAll = (root: ParentNode, selector: string): Element[] => {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };
  /** One selector part, in a scope and every component inside it. */
  const allIn = (scope: Document | Element, selector: string): Element[] => {
    const hits = [
      ...(scope instanceof Element && safeMatches(scope, selector) ? [scope] : []),
      ...safeAll(scope, selector),
      ...shadowRoots(scope).flatMap((root) => safeAll(root, selector)),
    ];
    return [...new Set(hits)];
  };
  const safeMatches = (el: Element, selector: string) => {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  };
  const parent = (el: Element): Element | null =>
    el.parentElement ??
    ((el.getRootNode() as ShadowRoot | Document) instanceof ShadowRoot
      ? (el.getRootNode() as ShadowRoot).host
      : null);
  let hits = 0;
  const locator: Locator = {
    roots: () => [document, ...shadowRoots(document)],
    all: (selector, scope) => {
      // "a >>> b": b inside a (its component included), as Puppeteer writes it.
      const parts = selector.split(">>>").map((p) => p.trim()).filter(Boolean);
      let found: Element[] = [scope ?? document.documentElement];
      for (const [i, part] of parts.entries())
        found = [
          ...new Set(
            found.flatMap((at) =>
              allIn(i === 0 && !scope ? document : at, part).filter((el) => el !== at || i === 0),
            ),
          ),
        ];
      return found;
    },
    one: (selector, scope) => {
      if (!selector.includes(">>>")) {
        try {
          const own = (scope ?? document).querySelector(selector);
          if (own) return own;
        } catch {
          return null;
        }
      }
      return locator.all(selector, scope)[0] ?? null;
    },
    parent,
    contains: (a, b) => {
      for (let at: Element | null = b; at; at = parent(at)) if (at === a) return true;
      return false;
    },
    closest: (el, selector) => {
      for (let at: Element | null = el; at; at = parent(at))
        if (safeMatches(at, selector)) return at;
      return null;
    },
    fromPoint: (x, y) => {
      let el = document.elementFromPoint(x, y);
      for (let depth = 0; el?.shadowRoot && depth < 10; depth++) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      return el;
    },
    focused: () => {
      let el = document.activeElement;
      for (let depth = 0; el?.shadowRoot?.activeElement && depth < 10; depth++)
        el = el.shadowRoot.activeElement;
      return el;
    },
    visible: (el) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        (el as HTMLElement).checkVisibility?.({ visibilityProperty: true }) !== false
      );
    },
    mark: (el) => {
      const mark = `h${++hits}`;
      el.setAttribute("data-ac-hit", mark);
      return `[data-ac-hit="${mark}"]`;
    },
  };
  w.__ac = locator;
  w.__acDeep ??= (s) => locator.all(s).find((el) => el.getRootNode() instanceof ShadowRoot) ?? null;
  w.__acDeepAll ??= (s) => locator.all(s).filter((el) => el.getRootNode() instanceof ShadowRoot);
}

/** Installs the locator in a frame (once; a frame that's gone is left alone). */
export async function ensureLocator(frame: Frame): Promise<void> {
  await frame.evaluate(installLocator).catch(() => undefined);
}

/** Puppeteer's own deep handle for a mark the locator made (it reaches into components). */
const pierced = (frame: Frame, mark: string) =>
  frame.$(`pierce/${mark}`).catch(() => null) as Promise<ElementHandle<Element> | null>;

/**
 * The element for a selector: the frame's own lookup, then inside components, then (when
 * `inBox`) only inside the field's marked area (data-ac-box="1"). Null when nothing matches.
 */
export async function deepFind(
  frame: Frame,
  selector: string,
  inBox = false,
): Promise<ElementHandle<Element> | null> {
  if (!inBox) {
    const own = await frame.$(selector).catch(() => null);
    if (own) return own as ElementHandle<Element>;
  }
  await ensureLocator(frame);
  const mark = await frame
    .evaluate(
      (sel, boxed) => {
        const ac = (window as unknown as { __ac?: Locator }).__ac;
        if (!ac) return null;
        const box = boxed ? ac.one("[data-ac-box='1']") : null;
        if (boxed && !box) return null;
        const hit = ac
          .all(sel)
          .find((el) => !box || ac.contains(box, el));
        return hit ? ac.mark(hit) : null;
      },
      selector,
      inBox,
    )
    .catch(() => null);
  return mark ? pierced(frame, mark) : null;
}

/**
 * The element in any frame of the page: this frame first, then the others (a form inside an
 * iframe, an iframe inside the form). Null when no frame has it.
 */
export async function findAnywhere(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<{ frame: Frame; handle: ElementHandle<Element> } | null> {
  for (const f of [frame, ...page.frames().filter((x) => x !== frame && !x.detached)]) {
    const handle = await deepFind(f, selector);
    if (handle) return { frame: f, handle };
  }
  return null;
}

/**
 * The visible choices of every list open in the frame, inside components too: [handle,
 * label]. A list in a fixed-position popup counts (offsetParent is null there).
 */
export async function deepChoices(
  frame: Frame,
  selector: string,
): Promise<{ handle: ElementHandle<Element>; label: string }[]> {
  await ensureLocator(frame);
  const marks = await frame
    .evaluate((sel) => {
      const ac = (window as unknown as { __ac?: Locator }).__ac;
      if (!ac) return [] as [string, string][];
      return ac
        .all(sel)
        .filter((el) => ac.visible(el))
        .map((el) => [ac.mark(el), (el.textContent ?? "").replace(/\s+/g, " ").trim()] as [string, string])
        .filter(([, label]) => label);
    }, selector)
    .catch(() => [] as [string, string][]);
  const found: { handle: ElementHandle<Element>; label: string }[] = [];
  for (const [mark, label] of marks) {
    const handle = await pierced(frame, mark);
    if (handle) found.push({ handle, label });
  }
  return found;
}

/**
 * Fields Claude found that the reader didn't, by its selectors: each one that finds exactly one
 * visible form control on the page (inside components too) that isn't a field the reader found
 * already (marked data-ac-ref) nor a button, marked as the reader marks its fields, so every
 * lookup after finds it the usual way. [Claude's selector, the mark's selector]. Runs inside the
 * page, after installLocator.
 */
export function liveControls(selectors: readonly string[]): [string, string][] {
  const ac = (window as unknown as { __ac?: Locator }).__ac;
  if (!ac) return [];
  const CONTROL =
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [contenteditable='true'], [contenteditable=''], [role=combobox], [role=textbox], [role=listbox], [role=radiogroup], [role=checkbox]";
  const kept: [string, string][] = [];
  for (const selector of selectors) {
    const found = ac.all(selector);
    const el = found[0];
    if (
      found.length !== 1 ||
      !el ||
      !el.matches(CONTROL) ||
      el.closest("[data-ac-ref]") ||
      ((el as HTMLInputElement).type !== "file" && !ac.visible(el))
    )
      continue;
    // "acs…" inside a component (found through its shadow root, as the reader's are).
    const shadow = el.getRootNode() instanceof ShadowRoot;
    const mark = `${shadow ? "acsc" : "acc"}${kept.length}x${Date.now() % 100_000}`;
    el.setAttribute("data-ac-ref", mark);
    kept.push([selector, `[data-ac-ref="${mark}"]`]);
  }
  return kept;
}

/**
 * The Save buttons of entries open for editing (a job or degree opened with Edit or Add, with
 * its own Save): marked, with their names. Only a button named Save, Done, Update or OK (of
 * the entry, experience, education…), around fields of which at least one is filled, in a box
 * holding fewer fields than the whole page; never the form's own submit button, nor one that
 * names the application, submits, continues or deletes. Runs inside the page, after
 * installLocator.
 */
export function entrySaves(): [string, string][] {
  const ac = (window as unknown as { __ac?: Locator }).__ac;
  if (!ac) return [];
  const FIELDS = "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea";
  const SAVE = /^(save|done|update|ok|apply changes|confirm)( (changes|entry|experience|education|position|job|degree|details))?$/i;
  const NEVER = /\b(application|submit|apply now|continue|next|delete|remove|cancel|send)\b/i;
  const ENTRY =
    /experience|employment|work|job|position|company|employer|education|degree|school|universit|college|qualification|certif|project|reference|language/i;
  // The form's fields: not a site search or a header's.
  const all = ac
    .all(FIELDS)
    .filter(
      (f) =>
        (ac.visible(f) || (f as HTMLInputElement).type === "file") &&
        !ac.closest(f, "header, nav, footer, [role=search], #ac-badge"),
    );
  const fieldsIn = (box: Element) => all.filter((f) => ac.contains(box, f));
  const filled = (f: Element) => {
    const input = f as HTMLInputElement;
    return input.type === "checkbox" || input.type === "radio" ? input.checked : !!input.value?.trim();
  };
  const found: [string, string][] = [];
  for (const b of ac.all("button, [role=button], input[type=button], input[type=submit]")) {
    if (!ac.visible(b)) continue;
    const name = (
      b.getAttribute("aria-label") ||
      (b as HTMLInputElement).value ||
      b.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!SAVE.test(name) || NEVER.test(name)) continue;
    // The page's own form submit: yours.
    const form = (b as HTMLButtonElement).form;
    if (form && form.querySelectorAll(FIELDS).length >= all.length) continue;
    // The entry: up from the button to the first box with fields in it.
    let box: Element | null = ac.parent(b);
    for (let hops = 0; box && hops < 12 && !fieldsIn(box).length; hops++) box = ac.parent(box);
    if (!box) continue;
    const mine = fieldsIn(box);
    // A small part of the form (one entry), something filled in it.
    if (!mine.length || mine.length > all.length * 0.6 || !mine.some(filled)) continue;
    // And an entry: a job, degree… by its words, its fields' names or its boxes' own names.
    const names: string[] = [box.textContent ?? ""];
    for (let at: Element | null = box, hops = 0; at && hops < 5; at = ac.parent(at), hops++)
      names.push(at.tagName, at.id, at.getAttribute("data-test") ?? "", at.getAttribute("class") ?? "");
    for (const f of mine)
      names.push(f.getAttribute("aria-label") ?? "", f.getAttribute("name") ?? "", f.getAttribute("placeholder") ?? "");
    if (!ENTRY.test(names.join(" "))) continue;
    found.push([ac.mark(b), name.slice(0, 60)]);
  }
  return found;
}

/** liveControls in a frame: Claude's selector → the field's mark; none when it can't be read. */
export async function checkControls(
  frame: Frame,
  selectors: readonly string[],
): Promise<Map<string, string>> {
  if (!selectors.length) return new Map();
  await ensureLocator(frame);
  return new Map(
    await frame.evaluate(liveControls, selectors).catch(() => [] as [string, string][]),
  );
}
