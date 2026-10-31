import {
  type Browser,
  connect,
  ExtensionTransport,
  type Frame,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { waitForTabSettled } from "../fill/controller";
import { labelKey, recipeHost } from "../fill/site-help";
import type { ApplyClient } from "../lib/api";
import { errorText, type TraceRecorder } from "../trace/recorder";
import { NEVER, type NavPage, readNavPage } from "./nav-page";

/**
 * Autopilot (AUTOPILOT_PLAN.md §C): from a job's link to its application form, in your visible
 * tab. Each page is read by plain code first (closed? form here? sign-in? one clear Apply
 * button?); only when that can't tell does Claude get the page's screenshot, its clickable
 * elements and every step so far. Never clicks LinkedIn, Indeed or anything that sends. A
 * click that opens a new tab is followed there. At most MAX_HOPS clicks.
 */

export type NavOutcome =
  | { readonly kind: "form"; readonly tabId: number; readonly url: string }
  | {
      readonly kind: "closed" | "login" | "stuck";
      readonly tabId: number;
      readonly url: string;
      readonly reason: string;
    };

const MAX_HOPS = 8;
const CLICK_SETTLE_MS = 2_500;
/** Below this, a screenshot is too small to read; above, it costs more than it tells. */
const SHOT_QUALITY = 55;
const BROKEN = /^chrome-error:|^edge-error:|^about:neterror/i;
/** The browser's own error codes on its error page ("DNS_PROBE_FINISHED_NXDOMAIN"). */
const BROKEN_CODE = /\b(DNS_PROBE_[A-Z_]+|ERR_[A-Z_]{4,})\b/;
const BROKEN_TITLE = /can'?t be reached|isn'?t working|took too long to respond|err_name_not_resolved|404 not found|page not found/i;

interface Deps {
  readonly client: ApplyClient;
  readonly jobId: string;
  readonly trace: TraceRecorder;
  /** You stopped autopilot or skipped this job. */
  readonly stopped: () => boolean;
  /** Only check the page (closed? broken?), never click: a known system's posting. */
  readonly checkOnly?: boolean;
}

async function attach(tabId: number): Promise<{ browser: Browser; page: Page | null }> {
  const browser = await connect({
    transport: await ExtensionTransport.connectTab(tabId),
    defaultViewport: null,
  });
  const [page] = await browser.pages();
  return { browser, page: page ?? null };
}

/** A tab this tab opened since `before` (the Apply button opened the form in a new tab). */
async function openedBy(tabId: number, before: ReadonlySet<number>): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.id !== undefined && !before.has(t.id) && t.openerTabId === tabId) ?? null;
}

const allTabIds = async () =>
  new Set((await chrome.tabs.query({})).flatMap((t) => (t.id === undefined ? [] : [t.id])));

/**
 * The page and every frame in it, read as one: careers pages often put the application
 * (iCIMS, Greenhouse) in a frame. Refs are "<frame>:<mark>" ("0:e3" in the page itself).
 */
async function readAll(page: Page): Promise<{ info: NavPage; frames: readonly Frame[] }> {
  const frames = [page.mainFrame(), ...page.mainFrame().childFrames()].slice(0, 6);
  const read = await Promise.all(
    frames.map((f) => f.evaluate(readNavPage).catch(() => null) as Promise<NavPage | null>),
  );
  const main = read[0];
  if (!main) throw new Error("Couldn't read the page");
  const prefix = (i: number, line: string) => `${i}:${line}`;
  const parts = read.flatMap((r, i) => (r ? [{ r, i }] : []));
  return {
    frames,
    info: {
      ...main,
      form: parts.some(({ r }) => r.form),
      login: parts.some(({ r }) => r.login),
      closed: main.closed,
      apply: parts.flatMap(({ r, i }) => r.apply.map((a) => ({ ...a, ref: prefix(i, a.ref) }))),
      outline: parts
        .flatMap(({ r, i }) =>
          r.outline
            .split("\n")
            .filter(Boolean)
            .map((l) => prefix(i, l)),
        )
        .join("\n")
        .slice(0, 12_000),
      text: parts
        .map(({ r }) => r.text)
        .join("\n")
        .slice(0, 3_000),
      fingerprint: parts.map(({ r }) => r.fingerprint).join("#"),
    },
  };
}

/** "1:e4" → the frame and its mark; a bare "e4" is in the page itself. */
function locate(frames: readonly Frame[], ref: string): { frame: Frame; mark: string } | null {
  const [index, mark] = ref.includes(":") ? ref.split(":") : ["0", ref];
  const frame = frames[Number(index)];
  return frame && mark && /^e\d+$/.test(mark) ? { frame, mark } : null;
}

/** The element's own words and link, to refuse LinkedIn, Indeed and anything that sends. */
function describe(ref: string): { text: string; href: string } | null {
  const el = document.querySelector<HTMLElement>(`[data-ac-nav="${ref}"]`);
  if (!el) return null;
  return {
    text: (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80),
    href: (el as HTMLAnchorElement).href ?? "",
  };
}

/** The saved steps' name for a site's way to its form (one per site). */
export const WAY_LABEL = "Way to the application form (autopilot)";

interface Click {
  readonly host: string;
  readonly text: string;
  /** Clicked because it was this site's saved way. */
  readonly saved: boolean;
}

const hostOf = (url: string) => {
  try {
    return recipeHost(url);
  } catch {
    return "";
  }
};

/** Each site's saved way to its form: the texts clicked, in order (loaded once per site). */
function savedWays(client: ApplyClient) {
  const known = new Map<string, Promise<string[]>>();
  return (host: string): Promise<string[]> => {
    if (!host) return Promise.resolve([]);
    let way = known.get(host);
    if (!way) {
      way = client
        .recipes(host)
        .then((recipes) => {
          const found = recipes.find((r) => r.labelKey === labelKey(WAY_LABEL));
          return found && found.worked > found.failed
            ? found.steps.filter((s) => s.action === "pick").map((s) => s.value)
            : [];
        })
        .catch(() => []);
      known.set(host, way);
    }
    return way;
  };
}

/** The element worded like a saved step, not tried yet: its ref from the outline. */
export function savedRef(outline: string, saved: readonly string[], tried: ReadonlySet<string>): string {
  const lines = outline.split("\n").map((line) => line.split(" | "));
  for (const text of saved) {
    const wanted = text.trim().toLowerCase();
    if (tried.has(wanted)) continue;
    const line = lines.find((parts) => (parts[2] ?? "").trim().toLowerCase() === wanted);
    if (line?.[0]) return line[0];
  }
  return "";
}

/**
 * The clicks that reached the form are kept as each site's way there (the next job on that site
 * needs no Claude); a saved way that led nowhere counts against it, so a stale one stops being used.
 */
async function remember(outcome: NavOutcome, clicks: readonly Click[], deps: Deps): Promise<void> {
  const hosts = [...new Set(clicks.map((c) => c.host))].filter(Boolean);
  for (const host of hosts) {
    const mine = clicks.filter((c) => c.host === host);
    const ok = outcome.kind === "form";
    if (!ok && (outcome.kind !== "stuck" || !mine.some((c) => c.saved))) continue;
    await deps.client
      .recordRecipe({
        host,
        label: WAY_LABEL,
        steps: mine.map((c) => ({ action: "pick", value: c.text.slice(0, 300) })),
        ok,
        jobId: deps.jobId,
      })
      .catch(() => {});
  }
}

export async function findForm(startTabId: number, deps: Deps): Promise<NavOutcome> {
  const clicks: Click[] = [];
  const outcome = await walk(startTabId, deps, clicks, savedWays(deps.client));
  await remember(outcome, clicks, deps);
  return outcome;
}

async function walk(
  startTabId: number,
  deps: Deps,
  clicks: Click[],
  waysFor: (host: string) => Promise<string[]>,
): Promise<NavOutcome> {
  let tabId = startTabId;
  const history: string[] = [];
  const triedTexts = new Set<string>();
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (deps.stopped()) return { kind: "stuck", tabId, url: "", reason: "You stopped it" };
    await waitForTabSettled(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.url ?? "";
    if (!tab) return { kind: "stuck", tabId, url, reason: "The tab was closed" };
    if (BROKEN.test(url) || BROKEN_TITLE.test(tab.title ?? ""))
      return { kind: "closed", tabId, url, reason: `The link is broken (${(tab.title ?? url).slice(0, 80)})` };
    const { browser, page } = await attach(tabId);
    try {
      if (!page) return { kind: "stuck", tabId, url, reason: "No page in the tab" };
      const { info, frames } = await readAll(page);
      deps.trace.event("navigate", `On ${info.url.slice(0, 140)}: ${summary(info)}`, {
        data: { url: info.url, closed: info.closed, form: info.form, login: info.login, apply: info.apply.slice(0, 3) },
      });
      // A dead link shows the browser's error page; the tab still reports the address asked for.
      if (BROKEN.test(info.url) || BROKEN_CODE.test(info.text.slice(0, 600)))
        return {
          kind: "closed",
          tabId,
          url,
          reason: `The link is broken (${info.text.match(BROKEN_CODE)?.[0] ?? info.title.slice(0, 80)})`,
        };
      if (info.form) return { kind: "form", tabId, url: info.url };
      if (info.closed)
        return { kind: "closed", tabId, url: info.url, reason: `The page says "${info.closed}"` };
      // A known system's posting, open: its run finds the form itself.
      if (deps.checkOnly) return { kind: "form", tabId, url: info.url };
      if (info.login)
        return { kind: "login", tabId, url: info.url, reason: "The site asks you to sign in or create an account" };
      if (hop === MAX_HOPS) break;

      // This site's saved way first, then the best Apply button not tried yet, then Claude.
      const host = hostOf(info.url);
      const known = savedRef(info.outline, await waysFor(host), triedTexts);
      let ref = known || (info.apply.find((a) => !triedTexts.has(a.text.toLowerCase()))?.ref ?? "");
      let by = known ? "this site's saved way" : "plain code";
      if (!ref) {
        const shot = await page.screenshot({ type: "jpeg", quality: SHOT_QUALITY, encoding: "base64" });
        const answer = await deps.client
          .navigate(deps.jobId, {
            url: info.url,
            title: info.title,
            outline: info.outline,
            text: info.text,
            history,
            screenshot: { data: String(shot), mediaType: "image/jpeg" },
          })
          .catch((error: unknown) => ({ action: "stuck" as const, ref: "", why: errorText(error), cost: 0, spent: 0 }));
        if (answer.action === "form") return { kind: "form", tabId, url: info.url };
        if (answer.action !== "click")
          return { kind: answer.action, tabId, url: info.url, reason: `Claude: ${answer.why}` };
        ref = answer.ref;
        by = `Claude (${answer.why})`;
      }
      const at = locate(frames, ref);
      const target = at ? await at.frame.evaluate(describe, at.mark).catch(() => null) : null;
      if (!at || !target || NEVER.test(`${target.text} ${target.href}`)) {
        history.push(`${ref} can't be clicked (${target ? `"${target.text}" isn't allowed` : "not on the page"})`);
        continue;
      }
      triedTexts.add(target.text.toLowerCase());
      clicks.push({ host, text: target.text, saved: Boolean(known) && ref === known });
      const before = await allTabIds();
      await at.frame.click(`[data-ac-nav="${at.mark}"]`).catch(() =>
        at.frame.evaluate(
          (m) => document.querySelector<HTMLElement>(`[data-ac-nav="${m}"]`)?.click(),
          at.mark,
        ),
      );
      await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
      const opened = await openedBy(tabId, before);
      let result: string;
      if (opened?.id !== undefined) {
        tabId = opened.id;
        await chrome.tabs.update(tabId, { active: true });
        result = `opened a new tab (${(opened.pendingUrl ?? opened.url ?? "").slice(0, 120)})`;
      } else {
        const after = await readAll(page).then((r) => r.info).catch(() => null);
        result = !after
          ? "the page moved on"
          : after.fingerprint === info.fingerprint
            ? "nothing changed"
            : `now on ${after.url.slice(0, 120)}`;
      }
      history.push(`clicked ${ref} "${target.text}" (by ${by.slice(0, 80)}) → ${result}`);
      deps.trace.event("navigate", `Clicked "${target.text}" (${by.slice(0, 120)}) → ${result}`, {
        data: { ref, text: target.text, href: target.href, by, result },
      });
    } finally {
      await browser.disconnect().catch(() => {});
    }
  }
  return {
    kind: "stuck",
    tabId,
    url: (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "",
    reason: `No form after ${MAX_HOPS} clicks: ${history.slice(-2).join("; ")}`,
  };
}

function summary(info: NavPage): string {
  if (info.form) return "the form is here";
  if (info.closed) return `looks closed ("${info.closed}")`;
  if (info.login) return "a sign-in is in the way";
  return info.apply.length
    ? `Apply buttons: ${info.apply.slice(0, 3).map((a) => `"${a.text}"`).join(", ")}`
    : "no Apply button found";
}
