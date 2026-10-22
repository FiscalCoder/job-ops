import { readJobText } from "../../src/kit/job-page";
import type { ApplyClient, ImportDraft } from "../../src/lib/api";
import { pageKey } from "../../src/lib/tab-match";

/**
 * "Add a job": a job's page or application form on any site, added to Job Ops by its link.
 * The page is read here in your browser (opened in a background tab when it isn't open), and
 * Job Ops' own import reads its details and adds it.
 */

/** Never read: LinkedIn is copy-only, and Job Ops doesn't read Indeed either. */
const NOT_READ = /(^|\.)(linkedin\.com|indeed\.[a-z.]+)$/i;
/** A page opened to read it: how long to let its scripts draw the job after it loads. */
const SETTLE_MS = 2_500;
const LOAD_TIMEOUT_MS = 30_000;
/** Less text than this isn't a job's page (an error page, a login wall). */
const MIN_TEXT = 200;

function el(
  tag: string,
  attrs: Record<string, string | undefined> = {},
  ...children: (Node | string)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs))
    if (value !== undefined) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function webLink(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

async function readTab(tabId: number): Promise<string> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readJobText,
  });
  return typeof result?.result === "string" ? result.result : "";
}

/** The tab has loaded a web page (not the blank page a new tab starts on). */
function loaded(tabId: number): Promise<void> {
  const done = (tab: chrome.tabs.Tab) =>
    tab.status === "complete" && /^https?:/.test(tab.url ?? "");
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listen);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("The page took too long to load")),
      LOAD_TIMEOUT_MS,
    );
    const listen = (id: number, _change: unknown, tab: chrome.tabs.Tab) => {
      if (id === tabId && done(tab)) finish();
    };
    chrome.tabs.onUpdated.addListener(listen);
    // It may have loaded before the listener was added.
    void chrome.tabs.get(tabId).then((tab) => {
      if (done(tab)) finish();
    }, finish);
  });
}

/** The page's text: from its tab when it's open, else from a background tab opened and closed. */
async function readLink(url: string): Promise<string> {
  const key = pageKey(url);
  const open = (await chrome.tabs.query({})).find(
    (t) => t.id !== undefined && t.url && pageKey(t.url) === key,
  );
  if (open?.id !== undefined) return readTab(open.id);
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Error("Couldn't open the page");
  try {
    await loaded(tab.id);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return await readTab(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

function field(label: string, value: string | null | undefined): HTMLInputElement {
  const input = el("input", { "aria-label": label }) as HTMLInputElement;
  input.value = value ?? "";
  return input;
}

export function setUpImport(options: {
  readonly client: () => ApplyClient | null;
  /** The tab you're on, as the side panel last saw it. */
  readonly currentTab: () => chrome.tabs.Tab | undefined;
  readonly onAdded: (note: string) => void;
}): void {
  const form = document.getElementById("import-form") as HTMLFormElement;
  const input = document.getElementById("import-url") as HTMLInputElement;
  const thisTab = document.getElementById("import-tab") as HTMLButtonElement;
  const box = document.getElementById("import-box") as HTMLElement;
  const say = (text: string, tone: "muted" | "error" | "ok" = "muted") =>
    box.replaceChildren(el("p", { class: tone }, text));

  /** Reads the page and shows what Job Ops made of it, for you to check and add. */
  async function read(
    url: URL,
    fromTab: number | null,
    allowed: Promise<boolean>,
  ) {
    const client = options.client();
    if (!client) return;
    if (!(await allowed.catch(() => false))) {
      say(`Allow Apply Copilot to read ${url.hostname} to add a job from it.`, "error");
      return;
    }
    say(fromTab === null ? "Opening the page and reading it…" : "Reading this page…");
    try {
      const content = fromTab === null ? await readLink(url.href) : await readTab(fromTab);
      if (content.length < MIN_TEXT) {
        say(
          "That page shows hardly any text (a login page, or the job hasn't loaded). Open the job's own page and try \"Use this tab\".",
          "error",
        );
        return;
      }
      say("Job Ops is reading the job's details…");
      const { job, warning } = await client.readJob({ url: url.href, content });
      review(client, url.href, content, job, warning);
    } catch (error) {
      say(message(error), "error");
    }
  }

  function review(
    client: ApplyClient,
    url: string,
    content: string,
    draft: ImportDraft,
    warning: string | null,
  ) {
    const title = field("Job title", draft.title);
    const employer = field("Company", draft.employer);
    const location = field("Location", draft.location);
    const add = el("button", { type: "button", class: "primary" }, "Add to Job Ops") as HTMLButtonElement;
    const cancel = el("button", { type: "button" }, "Cancel");
    const status = el("p", { class: "muted" });
    cancel.addEventListener("click", () => box.replaceChildren());
    add.addEventListener("click", async () => {
      if (!title.value.trim() || !employer.value.trim()) {
        status.className = "error";
        status.textContent = "A job title and a company are needed.";
        return;
      }
      add.disabled = true;
      status.className = "muted";
      status.textContent =
        "Adding… Job Ops tailors your resume for it first, which can take a minute.";
      try {
        const optional = (value: string | null | undefined) =>
          value?.trim() ? value.trim() : undefined;
        await client.importJob({
          title: title.value.trim(),
          employer: employer.value.trim(),
          jobUrl: url,
          applicationLink: url,
          location: optional(location.value),
          salary: optional(draft.salary),
          deadline: optional(draft.deadline),
          jobType: optional(draft.jobType),
          jobLevel: optional(draft.jobLevel),
          jobDescription: content,
        });
        box.replaceChildren();
        input.value = "";
        options.onAdded(
          `${title.value.trim()} · ${employer.value.trim()}: added to Job Ops. It joins the queue once Job Ops has scored it.`,
        );
      } catch (error) {
        add.disabled = false;
        status.className = "error";
        status.textContent = message(error);
      }
    });
    box.replaceChildren(
      el("label", {}, "Job title", title),
      el("label", {}, "Company", employer),
      el("label", {}, "Location", location),
      ...(warning ? [el("p", { class: "error" }, warning)] : []),
      el("div", { class: "controls" }, add, cancel),
      status,
    );
  }

  /**
   * Checks the link, then asks to read that one site. Chrome only asks while your click still
   * counts, so nothing is awaited before the request.
   */
  function start(url: URL | null, tabId: number | null): void {
    if (!url) {
      say(
        tabId === null
          ? "Paste the job's link (https://…)."
          : "Open the job's page in this window first.",
        "error",
      );
      return;
    }
    if (NOT_READ.test(url.hostname)) {
      say(
        "LinkedIn and Indeed pages aren't read. Open the company's own page for the job and add that.",
        "error",
      );
      return;
    }
    const allowed = chrome.permissions.request({ origins: [`${url.origin}/*`] });
    void read(url, tabId, allowed);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    start(webLink(input.value), null);
  });

  thisTab.addEventListener("click", () => {
    const tab = options.currentTab();
    const url = tab?.id === undefined ? null : webLink(tab.url ?? "");
    if (url) input.value = url.href;
    // A tab number, even without a page: says "open the job's page" rather than "paste a link".
    start(url, tab?.id ?? -1);
  });
}
