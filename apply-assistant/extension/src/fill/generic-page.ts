/**
 * Reading any company's own application page (no known system): its fields, labels, kinds,
 * choices, entries shown as cards and buttons that reveal hidden fields. The functions marked
 * "runs inside the page" are sent to the page as they are, so they stay self-contained.
 */
export type GenericKind =
  | "text"
  | "textarea"
  | "dropdown"
  | "search"
  | "radio"
  | "checkbox"
  | "date"
  | "file";

export interface GenericField {
  readonly ref: string;
  readonly key: string;
  readonly label: string;
  readonly kind: GenericKind;
  readonly required: boolean;
  readonly options: readonly string[];
  /** The repeated group it sits in (iCIMS: one fieldset per job, "Professional Experience (2)"). */
  readonly block?: { readonly id: string; readonly heading: string };
  /** What it shows now (a block the site filled from your uploaded resume). */
  readonly value?: string;
  /** Its placeholder, name and the heading above it: what Claude's page map reads. */
  readonly context?: string;
  /** The most characters a text box takes (its maxlength): answers are written to fit. */
  readonly maxLength?: number;
}

/** A dropdown's prompt, not a choice ("— Make a Selection —", "Select…"). */
export const PLACEHOLDER =
  /^[\s—–\-.…]*(make a selection|select( one| an option)?|choose( one| an option)?|please (select|choose)( one)?|none selected|type to search|no \w+ available)[\s—–\-.…]*$/i;


export interface GenericPage {
  readonly system: "generic";
  readonly step: string;
  readonly fields: readonly GenericField[];
  readonly sections: readonly never[];
  /** Sections offering "+ Add …" for an entry ("Education Details"), even with none yet. */
  readonly addable?: readonly string[];
  /**
   * Entries the page shows as summaries already (a job or degree it read from your resume,
   * with an Edit button), not as fields: they count as filled.
   */
  readonly cards?: readonly { readonly heading: string; readonly text: string }[];
  /**
   * Buttons that show fields kept hidden until clicked: an entry's Edit, a collapsed section.
   * ref is its mark ([data-ac-reveal="rN"]); collapsed: it says it's closed (aria-expanded).
   */
  readonly revealers?: readonly {
    readonly ref: string;
    readonly label: string;
    readonly heading: string;
    readonly collapsed: boolean;
  }[];
}

/** The page's step: where you are and its heading; runs inside the page. */
export function genericStep(): string {
  const heading = [...document.querySelectorAll("h1, h2")]
    .find((h) => (h as HTMLElement).offsetParent !== null)
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  // At most 200 characters, as the server takes it: the address cut, the heading kept.
  return `${location.pathname.slice(0, 76)}${heading ? ` · ${heading.slice(0, 120)}` : ""}`;
}

/** The page's fields; runs inside the page, so it stays self-contained. */
export function readGenericPage(): GenericPage {
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const SKIP = /^(hidden|submit|button|reset|image|password|search)$/i;
  const CAPTCHA = /recaptcha|hcaptcha|turnstile/i;
  // Words a widget calls itself, not the question ("textbox", "Drop or select (.pdf)").
  const GENERIC =
    /^(textbox|text|input|search|select|combobox|listbox|choose( files?)?|upload( files?)?|attach( files?)?|browse|add files?|select files?|drop or select\b.*)$/i;
  const meaningful = (t: string | null | undefined) =>
    t && !GENERIC.test(t.trim()) ? t.trim() : "";
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };
  /** The elements it names as its label; screen-reader-only ones ("0 files selected") only if nothing else. */
  const labelledBy = (el: Element | null | undefined) => {
    // Inside a web component, the label is in its own shadow root.
    const root = el?.getRootNode();
    const byId = (id: string) =>
      (root instanceof ShadowRoot ? root.getElementById(id) : null) ??
      document.getElementById(id);
    const named = (el?.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? byId(id) : null))
      .filter((e): e is HTMLElement => e !== null);
    const visible = named.filter(shown);
    return (visible.length ? visible : named).map(text).join(" ").trim();
  };
  /**
   * No label at all (Rippling's custom questions): the text just above the field, from the
   * nearest earlier block that isn't another field.
   */
  const questionAbove = (el: HTMLElement): string => {
    let node: Element | null = el;
    for (let depth = 0; node && depth < 5; depth++) {
      let prev = node.previousElementSibling;
      for (let hops = 0; prev && hops < 2; hops++) {
        if (prev.querySelector("input, select, textarea, [role='combobox']"))
          return "";
        const said = text(prev).replace(/\s*\*$/, "");
        if (said && !/^\d+\s*\/\s*\d+$/.test(said)) return said;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  };
  /**
   * A label tied to the field by its name in the label's id, not by `for` (Zoho Recruit:
   * `id="crc-label-rec-form_2111…"` for `name="rec-form_2111…"`).
   */
  const labelNamed = (el: HTMLElement): string => {
    const name = el.getAttribute("name") || el.id;
    if (!name) return "";
    const found = [
      ...document.querySelectorAll(`[id$="${CSS.escape(name)}"]`),
    ].find(
      (e) =>
        e !== el &&
        /label/i.test(e.id) &&
        !e.querySelector("input, select, textarea"),
    );
    return found ? text(found).replace(/\s*\*$/, "") : "";
  };
  /**
   * The label of the row the field is alone in: the nearest ancestor holding only this field
   * whose label-like element comes before it (Zoho's City, State, Zip lists).
   */
  const rowLabel = (el: HTMLElement): string => {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (node.querySelectorAll("input:not([type=hidden]), select, textarea").length > 1)
        return "";
      const label = [...node.querySelectorAll("label, [class*='label' i]")].find(
        (e) =>
          !e.contains(el) &&
          !e.querySelector("input, select, textarea") &&
          e.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const said = label ? meaningful(text(label).replace(/\s*\*$/, "")) : "";
      if (said) return said;
    }
    return "";
  };
  /**
   * A field inside a web component with no label of its own there (SmartRecruiters'
   * `<spl-input id="first-name-input">`): the component's label, its question, or its id.
   */
  const hostLabel = (el: HTMLElement): string => {
    const root = el.getRootNode();
    if (!(root instanceof ShadowRoot)) return "";
    const host = root.host as HTMLElement;
    return (
      meaningful(host.getAttribute("label")) ||
      meaningful(host.getAttribute("aria-label")) ||
      labelledBy(host) ||
      questionAbove(host) ||
      host.id
        .replace(/[-_](input|field|element)?[-_]?\d*$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase())
    );
  };
  const labelOf = (el: HTMLElement): string => {
    const input = el as HTMLInputElement;
    const own = input.labels?.[0] ?? el.closest("label");
    const box = el.closest(
      "fieldset, [role='group'], [role='radiogroup'], .field, [class*='field' i], [class*='question' i]",
    );
    const group =
      input.type === "radio" || (input.type === "checkbox" && input.name)
        ? text(box?.querySelector("legend, [class*='label' i], label"))
        : "";
    return (
      group ||
      labelledBy(el) ||
      labelledBy(own) ||
      meaningful(text(own)) ||
      meaningful(el.getAttribute("aria-label")) ||
      meaningful(text(box?.querySelector("label, legend"))) ||
      // Last: an upload whose own label is its button's word ("Attach") is named by its group.
      labelledBy(box) ||
      questionAbove(el) ||
      meaningful(el.getAttribute("placeholder")) ||
      // Before the field's own name ("rec-form_2111…"): a label found by that name, or its row's.
      labelNamed(el) ||
      rowLabel(el) ||
      hostLabel(el) ||
      el.getAttribute("name") ||
      ""
    ).slice(0, 300);
  };
  // New marks after those already on the page: a redrawn field mustn't take a kept one's.
  let counter =
    Math.max(
      -1,
      ...[...document.querySelectorAll("[data-ac-ref]")].map(
        (e) => Number(e.getAttribute("data-ac-ref")?.slice(2)) || 0,
      ),
    ) + 1;
  const refOf = (el: HTMLElement, group: string | null): string => {
    if (group) return `input[name="${group.replace(/["\\]/g, "\\$&")}"]`;
    if (
      el.id &&
      document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1
    )
      return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (
      name &&
      document.querySelectorAll(`[name="${CSS.escape(name)}"]`).length === 1
    )
      return `[name="${name.replace(/["\\]/g, "\\$&")}"]`;
    const mark = el.getAttribute("data-ac-ref") ?? `ac${counter++}`;
    el.setAttribute("data-ac-ref", mark);
    return `[data-ac-ref="${mark}"]`;
  };
  const optionLabel = (input: HTMLInputElement) =>
    text(input.labels?.[0]) ||
    text(input.closest("label")) ||
    input.getAttribute("aria-label") ||
    input.value;
  // Kept in step with PLACEHOLDER (this runs inside the page, on its own).
  const PROMPT =
    /^[\s—–\-.…]*(make a selection|select( one| an option)?|choose( one| an option)?|please (select|choose)( one)?|none selected|type to search|no \w+ available)[\s—–\-.…]*$/i;
  const fieldsets = [...document.querySelectorAll("fieldset")];
  /** The fieldset with a heading it sits in: a job or degree on iCIMS. */
  const fieldsetBlockOf = (el: HTMLElement) => {
    const box = el.closest("fieldset");
    const legend = box?.querySelector(":scope > legend");
    // "Professional Experience (2)* required." → "Professional Experience (2)"
    const heading = text(legend).replace(/\s*\*.*$/, "").trim();
    if (!box || !heading) return undefined;
    return {
      id: box.id || legend?.id || `fieldset-${fieldsets.indexOf(box)}`,
      heading: heading.slice(0, 200),
    };
  };
  // Numbered entries without a fieldset (Greenhouse: "company-name-0", "current-role-0_1" in a
  // form headed "Employment"): the entry is the number, the heading the section's above it.
  const SECTION = /experience|employment|work history|education|academic/i;
  const ENTRY = /[-_](\d{1,2})(?:_\d+)?$/;
  const entryOf = (el: Element) =>
    [el.id, el.getAttribute("name") ?? ""]
      .map((s) => ENTRY.exec(s)?.[1])
      .find((n) => n !== undefined);
  const numberedBlockOf = (el: HTMLElement) => {
    const entry = entryOf(el);
    if (entry === undefined) return undefined;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++) {
      // Up to the section only: a named field without a number means the whole form.
      const unnumbered = [
        ...node.querySelectorAll("input, select, textarea"),
      ].some(
        (f) =>
          (f.id || f.getAttribute("name")) &&
          f.getAttribute("type") !== "hidden" &&
          entryOf(f) === undefined,
      );
      if (unnumbered) return undefined;
      const head = [
        ...node.querySelectorAll(
          "h2, h3, h4, h5, h6, legend, p, label:not([for]), strong",
        ),
      ].find(
        (h) =>
          h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
          text(h).length < 40 &&
          SECTION.test(text(h)),
      );
      if (head) return { id: `${text(head)}-${entry}`, heading: text(head) };
      node = node.parentElement;
    }
    return undefined;
  };
  /** The job or degree a field belongs to: a fieldset with a heading, or a numbered entry. */
  const blockOf = (el: HTMLElement) => fieldsetBlockOf(el) ?? numberedBlockOf(el);
  /** What a field shows now: typed text, the picked option, a dropdown's shown pick. */
  const valueOf = (el: HTMLElement, tag: string): string => {
    const input = el as HTMLInputElement;
    if (input.type === "radio" || input.type === "checkbox") return "";
    if (input.type === "file") return "";
    const raw =
      tag === "select"
        ? [...(el as unknown as HTMLSelectElement).selectedOptions]
            .filter((o) => o.value !== "")
            .map((o) => o.text)
            .join(", ")
        : tag === "input" || tag === "textarea"
          ? input.value
          : text(el);
    const value = raw.replace(/\s+/g, " ").trim();
    return PROMPT.test(value) ? "" : value.slice(0, 300);
  };

  /** The nearest heading above a field (a few levels up), for Claude's page map. */
  const HEADING_TAGS = "h1, h2, h3, h4, h5, h6, legend, label:not([for]), strong";
  const headingAbove = (el: HTMLElement): string => {
    let node: Element | null = el;
    for (let depth = 0; node && depth < 6; depth++) {
      let prev = node.previousElementSibling;
      for (let hops = 0; prev && hops < 3; hops++) {
        const head = prev.matches(HEADING_TAGS) ? prev : prev.querySelector(HEADING_TAGS);
        const said = text(head);
        if (said && said.length < 60) return said;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  };
  const contextOf = (el: HTMLElement): string =>
    [
      el.getAttribute("placeholder") ? `placeholder: ${el.getAttribute("placeholder")}` : "",
      el.getAttribute("name") ? `name: ${el.getAttribute("name")}` : "",
      headingAbove(el) ? `under: ${headingAbove(el)}` : "",
      (el as HTMLInputElement).readOnly ? "read-only" : "",
    ]
      .filter(Boolean)
      .join("; ")
      .slice(0, 300);

  /** Every open shadow root on the page (web components), nested ones too. */
  const shadowRoots = (): ShadowRoot[] => {
    const roots: ShadowRoot[] = [];
    const visit = (root: Document | ShadowRoot) => {
      for (const host of root.querySelectorAll("*"))
        if (host.shadowRoot) {
          roots.push(host.shadowRoot);
          visit(host.shadowRoot);
        }
    };
    visit(document);
    return roots;
  };
  // For the rest of the run on this page: finds a field inside a web component by its ref,
  // when the page's own lookup finds nothing (every lookup falls back to these).
  const w = window as unknown as {
    __acDeep?: (s: string) => Element | null;
    __acDeepAll?: (s: string) => Element[];
  };
  w.__acDeep = (selector) => {
    for (const root of shadowRoots()) {
      const hit = root.querySelector(selector);
      if (hit) return hit;
    }
    return null;
  };
  w.__acDeepAll = (selector) =>
    shadowRoots().flatMap((root) => [...root.querySelectorAll(selector)]);
  // Fields inside web components are marked "acs…" (found through their shadow roots).
  let shadowCounter =
    Math.max(
      -1,
      ...shadowRoots().flatMap((root) =>
        [...root.querySelectorAll("[data-ac-ref^='acs']")].map(
          (e) => Number(e.getAttribute("data-ac-ref")?.slice(3)) || 0,
        ),
      ),
    ) + 1;
  const shadowRef = (el: HTMLElement, group: string | null): string => {
    const marks = group
      ? [
          ...(el.getRootNode() as ShadowRoot).querySelectorAll<HTMLElement>(
            `input[name="${group.replace(/["\\]/g, "\\$&")}"]`,
          ),
        ]
      : [el];
    const mark = el.getAttribute("data-ac-ref") ?? `acs${shadowCounter++}`;
    for (const m of marks) m.setAttribute("data-ac-ref", mark);
    return `[data-ac-ref="${mark}"]`;
  };

  const fields: GenericField[] = [];
  const seen = new Set<string>();
  const FIELD = "input, select, textarea, [role='combobox']:not(input)";
  const consider = (el: HTMLElement, shadow: boolean): void => {
    const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && SKIP.test(input.type)) return;
    if (el.closest("header, nav, footer, #ac-badge")) return;
    // A help chat's own inputs (Oracle's chatbot takes files): not the application.
    if (el.closest("[class*='chat' i], [id*='chat' i]")) return;
    if (/one-time-code/i.test(el.getAttribute("autocomplete") ?? "")) return;
    if (input.disabled) return;
    // Read-only, except a date picker's box (Keka's "Date of Joining"): set through its picker.
    const datePicker =
      input.readOnly &&
      /date|calendar/i.test(
        `${input.className} ${input.parentElement?.className ?? ""}`,
      );
    if (input.readOnly && !datePicker) return;
    // A dropdown's stand-in for the browser's "required" check (react-select), and captcha tokens.
    if (el.getAttribute("aria-hidden") === "true" && input.type !== "file")
      return;
    if (CAPTCHA.test(`${el.id} ${el.getAttribute("name") ?? ""}`)) return;
    // Hidden fields aren't for you, except uploads (their input hides behind a button).
    const visible = el.offsetParent !== null || el.getClientRects().length > 0;
    if (!visible && input.type !== "file") return;
    const group =
      (input.type === "radio" || input.type === "checkbox") && input.name
        ? input.name
        : null;
    const ref = shadow ? shadowRef(el, group) : refOf(el, group);
    if (seen.has(ref)) return;
    seen.add(ref);
    const members = group
      ? [
          ...(shadow
            ? (el.getRootNode() as ShadowRoot)
            : document
          ).querySelectorAll<HTMLInputElement>(ref),
        ]
      : [input];
    let kind: GenericKind;
    let options: string[] = [];
    if (input.type === "file") kind = "file";
    else if (tag === "select") {
      kind = "dropdown";
      options = [...(el as unknown as HTMLSelectElement).options]
        .filter((o) => o.value !== "" && !o.disabled)
        .map((o) => o.text.trim())
        .filter((o) => o !== "" && !PROMPT.test(o));
    } else if (tag === "textarea") kind = "textarea";
    else if (input.type === "radio") {
      kind = "radio";
      options = members.map(optionLabel);
    } else if (input.type === "checkbox") {
      kind = "checkbox";
      options = members.length > 1 ? members.map(optionLabel) : [];
    } else if (input.type === "date" || input.type === "month" || datePicker)
      kind = "date";
    else if (tag !== "input") kind = "dropdown";
    else if (
      el.getAttribute("role") === "combobox" ||
      /^(list|both)$/.test(el.getAttribute("aria-autocomplete") ?? "") ||
      input.list
    )
      kind = "search";
    else kind = "text";
    const label = labelOf(el);
    const required =
      members.some((m) => m.required) ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$/.test(label);
    const block = blockOf(el);
    const value = valueOf(el, tag);
    const maxLength =
      tag === "input" || tag === "textarea" ? (el as HTMLInputElement).maxLength : -1;
    fields.push({
      ref,
      key: el.getAttribute("name") || el.id || ref,
      label: label.replace(/\s*\*\s*$/, "").trim(),
      kind,
      required,
      options: options.map((o) => o.slice(0, 300)).slice(0, 500),
      ...(block ? { block } : {}),
      ...(value ? { value } : {}),
      ...(contextOf(el) ? { context: contextOf(el) } : {}),
      ...(maxLength > 0 && maxLength < 100_000 ? { maxLength } : {}),
    });
  };
  for (const el of document.querySelectorAll<HTMLElement>(FIELD)) {
    if (fields.length >= 200) break;
    consider(el, false);
  }
  // Fields inside web components (SmartRecruiters' <spl-input>): read the same way, after the
  // page's own.
  for (const root of shadowRoots())
    for (const el of root.querySelectorAll<HTMLElement>(FIELD)) {
      if (fields.length >= 200) break;
      consider(el, true);
    }
  // Buttons that show hidden fields, and entries shown as summaries with an Edit, on the page
  // and inside web components. Never one that submits, saves, deletes or leaves.
  const composedParent = (el: Element): Element | null =>
    el.parentElement ??
    (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);
  const nameOf = (b: Element) =>
    (b.getAttribute("aria-label")?.trim() || text(b)).replace(/\s+/g, " ").slice(0, 120);
  const shownBox = (b: Element) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const headingNear = (el: Element): string => {
    for (let at: Element | null = el, hops = 0; at && hops < 12; at = composedParent(at), hops++) {
      const head = at.querySelector?.("h1, h2, h3, h4, [role=heading], [data-test='section-title']");
      if (head && text(head)) return text(head).slice(0, 80);
    }
    return "";
  };
  const CONTROLS = "input:not([type=hidden]), select, textarea";
  const NEVER = /\b(submit|apply|save|send|continue|next|finish|delete|remove|cancel|upload|sign ?in|log ?in|back)\b/i;
  const REVEAL = /^(edit|change|modify|update|show|expand|view|open|more details|add details)\b/i;
  const clickable = [document, ...shadowRoots()].flatMap((root) => [
    ...root.querySelectorAll<HTMLElement>("button, [role=button], a:not([href]), a[href^='#'], summary"),
  ]);
  const revealers: { ref: string; label: string; heading: string; collapsed: boolean }[] = [];
  // Marks already given stay; a new one never takes a number another button has.
  let nextReveal =
    Math.max(
      -1,
      ...clickable.map((b) => Number(b.getAttribute("data-ac-reveal")?.slice(1) ?? -1)),
    ) + 1;
  const cards: { heading: string; text: string }[] = [];
  for (const b of clickable) {
    if (revealers.length >= 30 || !shownBox(b) || b.closest("header, nav, footer, #ac-badge")) continue;
    const label = nameOf(b);
    const collapsed =
      b.getAttribute("aria-expanded") === "false" &&
      !b.hasAttribute("aria-haspopup") &&
      !/^(combobox|listbox|option)$/.test(b.getAttribute("role") ?? "");
    if (!label || NEVER.test(label) || (!collapsed && !REVEAL.test(label))) continue;
    const mark = b.getAttribute("data-ac-reveal") ?? `r${nextReveal++}`;
    b.setAttribute("data-ac-reveal", mark);
    revealers.push({ ref: `[data-ac-reveal="${mark}"]`, label, heading: headingNear(b), collapsed });
    // An entry's Edit: the card around it (no fields in it) is an entry filled already.
    if (!/^edit\b/i.test(label)) continue;
    let card: Element | null = composedParent(b);
    for (let hops = 0; card && hops < 8; hops++) {
      const words = text(card);
      if (words.length > 25 || card.querySelector(CONTROLS)) break;
      card = composedParent(card);
    }
    if (card && !card.querySelector(CONTROLS) && text(card).length <= 3_000)
      cards.push({ heading: headingNear(card), text: `${label} · ${text(card)}`.slice(0, 600) });
  }
  const heading = [...document.querySelectorAll("h1, h2")]
    .find((h) => (h as HTMLElement).offsetParent !== null)
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return {
    system: "generic",
    // As genericStep: at most 200 characters.
    step: `${location.pathname.slice(0, 76)}${heading ? ` · ${heading.slice(0, 120)}` : ""}`,
    fields,
    sections: [],
    addable: [
      ...new Set(
        [...document.querySelectorAll<HTMLElement>("a, button, [role=button]")]
          .filter((b) => b.offsetParent !== null || b.getClientRects().length > 0)
          .map((b) =>
            /^add (?:more |another |new )?(.{3,60})$/i
              // An icon button's own name ("Add experience entry") when its text is just "Add".
              .exec(
                (/^\W*add\W*$/i.test(text(b)) ? (b.getAttribute("aria-label") ?? "") : text(b)).replace(
                  /^[^a-z]+/i,
                  "",
                ),
              )?.[1]
              ?.replace(/[()]/g, "")
              .trim(),
          )
          .filter(
            (name): name is string =>
              !!name && /experience|employment|work history|education|academic/i.test(name),
          ),
      ),
    ].slice(0, 10),
    ...(cards.length ? { cards: cards.slice(0, 40) } : {}),
    ...(revealers.length ? { revealers } : {}),
  };
}

/**
 * After a dropdown opened: the search box it opened, focused (true), or none. Its own box, the
 * one it points to (aria-owns / aria-controls), or one just beside it. Runs inside the page.
 */
export function focusSearchBox(ref: string): boolean {
  const field = (document.querySelector<HTMLElement>(ref) ?? ((window as unknown as { __acDeep?: (s: string) => Element | null }).__acDeep?.(ref) as HTMLElement | null | undefined) ?? null);
  if (!field) return false;
  // Only a box that says it's a search ("— Type to Search —"), never a neighbouring field.
  const isSearch = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement &&
    el !== field &&
    /^(text|search)$/.test(el.type) &&
    el.getClientRects().length > 0 &&
    (el.getAttribute("role") === "combobox" ||
      /search|filter/i.test(
        `${el.type} ${el.className} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""}`,
      ));
  if (isSearch(document.activeElement)) return true;
  const owned = ["aria-owns", "aria-controls"]
    .map((name) => field.getAttribute(name))
    .flatMap((ids) => (ids ?? "").split(/\s+/))
    .map((id) => (id ? document.getElementById(id) : null));
  const near = [field.nextElementSibling, field.parentElement, ...owned];
  for (const box of near) {
    const found = [box, ...(box?.querySelectorAll("input") ?? [])].find(isSearch);
    if (found) {
      found.focus();
      return true;
    }
  }
  return false;
}

export type DomKind =
  | "file"
  | "select"
  | "radio"
  | "checkbox"
  | "date"
  | "combobox"
  | "custom"
  | "text";

/** What kind of control a ref finds; runs inside the page. */
export function domKind(el: Element): DomKind {
  const input = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return "select";
  if (tag === "textarea") return "text";
  if (tag !== "input") return "custom";
  if (input.type === "file") return "file";
  if (input.type === "radio") return "radio";
  if (input.type === "checkbox") return "checkbox";
  if (input.type === "date" || input.type === "month") return "date";
  // A read-only box a date picker writes into (Keka's "Date of Joining").
  if (
    input.readOnly &&
    /date|calendar/i.test(`${input.className} ${input.parentElement?.className ?? ""}`)
  )
    return "date";
  if (
    el.getAttribute("role") === "combobox" ||
    /^(list|both)$/.test(el.getAttribute("aria-autocomplete") ?? "") ||
    input.list
  )
    return "combobox";
  return "text";
}

/** What a field shows now ("" when empty); runs inside the page. */
export function shownValue(selector: string): string {
  const text = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const all = (() => { const light = [...document.querySelectorAll<HTMLElement>(selector)]; return light.length ? light : (((window as unknown as { __acDeepAll?: (s: string) => Element[] }).__acDeepAll?.(selector) ?? []) as HTMLElement[]); })();
  const el = all[0];
  if (!el) return "";
  const input = el as HTMLInputElement;
  if (el.tagName === "SELECT") {
    const select = el as unknown as HTMLSelectElement;
    return [...select.selectedOptions]
      .filter((o) => o.value !== "")
      .map((o) => o.text.trim())
      .join(", ");
  }
  if (input.type === "radio" || input.type === "checkbox") {
    // No <label> (Phenom's "I currently work here"): its aria-label or the text beside it,
    // before its value ("true").
    const label = (i: HTMLInputElement) =>
      text(i.labels?.[0]) ||
      text(i.closest("label")) ||
      i.getAttribute("aria-label")?.trim() ||
      text(i.nextElementSibling) ||
      i.value;
    return all
      .map((i) => i as HTMLInputElement)
      .filter((i) => i.checked)
      .map(label)
      .join(", ");
  }
  if (input.type === "file")
    return [...(input.files ?? [])].map((f) => f.name).join(", ");
  // A dropdown showing its prompt ("— Make a Selection —") shows nothing picked (as PLACEHOLDER).
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
    // What it shows on screen when its own text is empty: a web component's button shows what
    // the page puts into its slots (SmartRecruiters' country code: a flag "India" and "+91").
    const rendered = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof Element)) return "";
      if (node.tagName === "IMG") return ` ${node.getAttribute("alt") ?? ""} `;
      const kids =
        node instanceof HTMLSlotElement
          ? node.assignedNodes({ flatten: true })
          : [...(node.shadowRoot?.childNodes ?? node.childNodes)];
      return kids.map(rendered).join(" ");
    };
    const said = text(el) || rendered(el).replace(/\s+/g, " ").replace(/\+ (\d)/g, "+$1").trim();
    return /^[\s—–\-.…]*(make a selection|select( one| an option)?|choose( one| an option)?|please (select|choose)( one)?|none selected|type to search|no \w+ available)[\s—–\-.…]*$/i.test(
      said,
    )
      ? ""
      : said;
  }
  if (input.value) return input.value;
  // A searchable dropdown shows its picks beside the (emptied) input, often a level or two up
  // (react-select: a sibling of the input's own container; a typeahead's tokens). Every pick
  // of a multi-select, without its remove button. Stops at the next field.
  let box = el.parentElement;
  for (let depth = 0; box && depth < 5; depth++, box = box.parentElement) {
    if (
      box.querySelectorAll("input:not([aria-hidden='true']), select, textarea")
        .length > 1
    )
      break;
    const found = [
      ...box.querySelectorAll(
        "[class*='singleValue' i], [class*='single-value' i], [class*='selected' i], [class*='chip' i], [class*='tag' i], [class*='token' i]",
      ),
    ].filter((p) => !p.closest("button"));
    const picks = found.filter(
      (p) => !found.some((o) => o !== p && o.contains(p)),
    );
    if (picks.length)
      return picks
        .map((p) => {
          const copy = p.cloneNode(true) as Element;
          for (const extra of copy.querySelectorAll(
            "button, .sr-only, .visually-hidden, [aria-hidden='true']",
          ))
            extra.remove();
          return text(copy);
        })
        .filter(Boolean)
        .join(", ");
  }
  return "";
}
