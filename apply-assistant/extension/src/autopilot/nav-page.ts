/**
 * Autopilot's reading of a page on the way from a job's link to its form (AUTOPILOT_PLAN.md §C2):
 * is the posting closed, is the form here, is a sign-in in the way, which buttons look like
 * Apply. Plain code first; Claude only when this can't tell. Runs inside the page, so
 * `readNavPage` stays self-contained (its patterns are repeated below for tests and callers).
 */

export interface NavPage {
  readonly url: string;
  readonly title: string;
  /** What the page says that means the posting is closed, if anything. */
  readonly closed: string | null;
  /** The application form is here. */
  readonly form: boolean;
  /** A sign-in or create-account wall is in the way. */
  readonly login: boolean;
  /** Elements worded like Apply (best first), by their mark. */
  readonly apply: readonly { readonly ref: string; readonly text: string }[];
  /** One line per clickable element: "e3 | button | Apply now | https://…". */
  readonly outline: string;
  /** The page's visible text, shortened. */
  readonly text: string;
  /** A short fingerprint of the page, to notice when a click changed nothing. */
  readonly fingerprint: string;
}

/** Wording of a closed, expired or missing posting. */
export const CLOSED =
  /no longer (available|accepting|open|active|exists)|(job|position|posting|vacancy|role|requisition|opening) (has been|is|was) (closed|filled|removed|expired|deleted|unpublished)|(has|have) (expired|been filled)|not accepting (new )?applications|applications (are|have) closed|page (not found|doesn'?t exist|cannot be found)|job not found|(posting|job) (is )?(no longer|not) available|\b(404|410)\b.*(not found|gone)|this job is unavailable/i;

/** Worded like Apply. */
export const APPLY =
  /^(apply( now| today| here| online| for (this|the) (job|position|role|opening))?|apply on (the )?(company|employer)('?s)? (site|website)|start (your |an )?application|i'?m interested|submit (your )?(cv|resume|interest))$/i;

/** Never clicked: someone else's apply flow, or anything that sends. */
export const NEVER =
  /linkedin|indeed|easy apply|with (google|facebook|seek)|^save|share|submit application|send application|refer a friend/i;

export function readNavPage(): NavPage {
  const CLOSED_IN =
    /no longer (available|accepting|open|active|exists)|(job|position|posting|vacancy|role|requisition|opening) (has been|is|was) (closed|filled|removed|expired|deleted|unpublished)|(has|have) (expired|been filled)|not accepting (new )?applications|applications (are|have) closed|page (not found|doesn'?t exist|cannot be found)|job not found|(posting|job) (is )?(no longer|not) available|\b(404|410)\b.*(not found|gone)|this job is unavailable/i;
  const APPLY_IN =
    /^(apply( now| today| here| online| for (this|the) (job|position|role|opening))?|apply on (the )?(company|employer)('?s)? (site|website)|start (your |an )?application|i'?m interested|submit (your )?(cv|resume|interest))$/i;
  const NEVER_IN =
    /linkedin|indeed|easy apply|with (google|facebook|seek)|^save|share|submit application|send application|refer a friend/i;
  const MAX_ELEMENTS = 120;
  const squash = (t: string | null | undefined) =>
    (t ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1 && getComputedStyle(el).visibility !== "hidden";
  };

  const body = document.body;
  const text = squash(body?.innerText ?? body?.textContent).slice(0, 3_000);
  const headings = [...document.querySelectorAll("h1, h2, [role='alert']")]
    .map((h) => squash(h.textContent))
    .join(" · ");
  // Closed wording in the title, a heading or near the top: not a sentence deep in the text.
  const closedMatch = `${document.title} · ${headings} · ${text.slice(0, 1_200)}`.match(
    CLOSED_IN,
  );
  const closed = closedMatch ? closedMatch[0] : null;

  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>("input, select, textarea"),
  ].filter(
    (i) =>
      !/^(hidden|submit|button|search|reset|image)$/i.test(i.type) &&
      !i.closest("header, nav, footer") &&
      (shown(i) || i.type === "file"),
  );
  const email = inputs.some(
    (i) => i.type === "email" || /e-?mail/i.test(`${i.name} ${i.id} ${i.getAttribute("autocomplete") ?? ""}`),
  );
  const file = inputs.some((i) => i.type === "file");
  const password = inputs.some((i) => i.type === "password");
  const signIn = /sign in|log ?in|create (an )?account|forgot (your )?password/i.test(
    `${headings} ${text.slice(0, 1_500)}`,
  );
  const login = password && signIn && !file;
  const form = !login && inputs.length >= 3 && (email || file);

  const clickables = [
    ...document.querySelectorAll<HTMLElement>(
      "a[href], button, [role='button'], [role='link'], input[type='submit'], input[type='button']",
    ),
  ].filter(shown);
  // Fresh marks each read: a page that redrew keeps no stale ones.
  for (const old of document.querySelectorAll("[data-ac-nav]"))
    old.removeAttribute("data-ac-nav");
  const lines: string[] = [];
  const apply: { ref: string; text: string; score: number }[] = [];
  clickables.slice(0, MAX_ELEMENTS).forEach((el, index) => {
    const ref = `e${index + 1}`;
    el.setAttribute("data-ac-nav", ref);
    const label = squash(
      el.innerText || el.textContent || el.getAttribute("aria-label") || (el as HTMLInputElement).value || el.title,
    ).slice(0, 80);
    const href = (el as HTMLAnchorElement).href ?? "";
    const role =
      el.getAttribute("role") ?? (el.tagName === "A" ? "link" : "button");
    lines.push(`${ref} | ${role} | ${label}${href ? ` | ${href.slice(0, 120)}` : ""}`);
    if (APPLY_IN.test(label) && !NEVER_IN.test(`${label} ${href}`))
      apply.push({
        ref,
        text: label,
        // A button beats a link; one in the page's main part beats one in its header.
        score: (el.tagName === "A" ? 0 : 1) + (el.closest("header, nav") ? 0 : 2),
      });
  });
  apply.sort((a, b) => b.score - a.score);

  return {
    url: location.href,
    title: document.title.slice(0, 200),
    closed,
    form,
    login,
    apply: apply.map(({ ref, text: t }) => ({ ref, text: t })),
    outline: lines.join("\n").slice(0, 12_000),
    text,
    fingerprint: `${location.href}|${inputs.length}|${text.length}|${text.slice(0, 200)}`,
  };
}
