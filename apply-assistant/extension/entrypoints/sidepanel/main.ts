import { RunController, type RunView } from "../../src/fill/controller";
import { ALL_SITES, activeTab } from "../../src/kit/page-fill";
import {
  ApiError,
  ApplyClient,
  type BlockedCompany,
  type QueueItem,
} from "../../src/lib/api";
import {
  type CaptureEntry,
  loadCaptures,
  loadLastRun,
  loadSettings,
  saveSettings,
} from "../../src/lib/settings";
import { jobForTab, pageKey } from "../../src/lib/tab-match";
import type { RunSummary } from "../../src/lib/worker";
import { looksSubmitted } from "../../src/track/confirm";
import { isSupportedPosting, pagedFill } from "../../src/track/job-match";
import { resolveTab } from "../../src/track/tabs";
import { renderHere } from "./here-view";
import { askClaude } from "./ask-claude";
import { setUpClaudeSettings } from "./claude-settings";
import { setUpImport } from "./import-view";
import { showKit } from "./kit-view";
import { postedText, renderQueue } from "./queue-view";
import { renderRun as renderRunView } from "./run-view";

// Side panel: sign in, run lookups, see the queue and each job's plan.
// Everything is rendered with textContent.

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function el(
  tag: string,
  attrs: Record<string, string | undefined> = {},
  ...children: (Node | string | null)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs))
    if (value !== undefined) node.setAttribute(key, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

let client: ApplyClient | null = null;
let activeRun: RunController | null = null;

const COUNTDOWN_CHOICES = ["3", "1", "0"];

async function countdownSetting(): Promise<number> {
  const { countdownSeconds } =
    await chrome.storage.local.get("countdownSeconds");
  return typeof countdownSeconds === "number" ? countdownSeconds : 3;
}

function countdownPicker(current: number): HTMLElement {
  const select = el(
    "select",
    { "aria-label": "Countdown before automatic steps" },
    ...COUNTDOWN_CHOICES.map((v) => {
      const option = el(
        "option",
        { value: v },
        v === "0" ? "approve every step" : `${v}s countdown`,
      ) as HTMLOptionElement;
      option.selected = Number(v) === current;
      return option;
    }),
  ) as HTMLSelectElement;
  select.addEventListener(
    "change",
    () =>
      void chrome.storage.local.set({ countdownSeconds: Number(select.value) }),
  );
  return select;
}

/**
 * `tabId`: fill that open tab (you're on the application already) instead of a new one;
 * `workday`: that tab is a Workday application, filled page by page.
 */
async function startFill(
  item: QueueItem,
  tabId?: number,
  paged: "workday" | "generic" | null = null,
) {
  if (!client || activeRun) return;
  const box = $("run-box");
  box.hidden = false;
  $("main").hidden = true;
  box.replaceChildren(
    el("p", { class: "muted" }, "Opening the posting and finding the form…"),
  );
  // A Greenhouse, Ashby or Lever posting is filled from its own form, once it's looked up.
  const posting =
    paged === "generic" && tabId !== undefined
      ? await matchPosting(tabId, item)
      : null;
  const job = posting ?? item;
  const pagedHow = posting ? null : paged;
  const closeRun = () => {
    activeRun = null;
    box.hidden = true;
    $("main").hidden = false;
    // The plan shown before the run is stale (the job may now be applied): reopen it from the queue.
    $("plan").hidden = true;
    $("plan").replaceChildren();
    void loadQueue();
  };
  // The run re-renders its part; Ask Claude below it keeps what you typed.
  const runPart = el(
    "div",
    {},
    el("p", { class: "muted" }, "Opening the posting and finding the form…"),
  );
  box.replaceChildren(runPart, askClaude(client, job.jobId));
  try {
    const options = {
      client,
      job,
      countdownSeconds: await countdownSetting(),
      onChange: (view: RunView) =>
        renderRunView(
          runPart,
          view,
          (event) => activeRun?.dispatch(event),
          closeRun,
          (entry, instruction) =>
            (client as ApplyClient).tellAgent(job.jobId, {
              ref: entry.ref,
              instruction,
              // Page by page there's no stored form: the field as the page showed it.
              ...(pagedHow
                ? {
                    field: {
                      label: entry.label,
                      type: entry.type,
                      options: entry.optionValues ?? [],
                    },
                  }
                : {}),
            }),
          () => activeRun?.refillPage(),
          (seq) => activeRun?.fillFrom(seq),
        ),
    };
    activeRun =
      pagedHow && tabId !== undefined
        ? await RunController.startPaged({
            ...options,
            tabId,
            system: pagedHow,
          })
        : await RunController.start({
            ...options,
            ...(tabId === undefined ? {} : { tabId }),
          });
  } catch (error) {
    activeRun = null;
    box.replaceChildren(
      el("p", { class: "error" }, message(error)),
      el("button", { type: "button" }, "Back"),
    );
    box.querySelector("button")?.addEventListener("click", closeRun);
  }
}

const POSTING_WAIT_MS = 20_000;
const POSTING_POLL_MS = 2_000;

/**
 * A Greenhouse, Ashby or Lever posting the job isn't matched to yet (its apply link was only just
 * captured from LinkedIn): looks it up now, so its form plan fills it rather than the generic
 * filler. Waits for the link to reach Job Ops, then for one lookup made with it.
 */
async function matchPosting(
  tabId: number,
  item: QueueItem,
): Promise<QueueItem | null> {
  const url = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "";
  if (!isSupportedPosting(url)) return null;
  const here = pageKey(url);
  const deadline = Date.now() + POSTING_WAIT_MS;
  for (;;) {
    const current = queueItems.find((i) => i.jobId === item.jobId) ?? item;
    const linkSaved = pageKey(current.applicationLink ?? "") === here;
    // This job's lookups only, and never past the deadline: a slow site can't hold the run.
    await Promise.race([
      chrome.runtime
        .sendMessage({ type: "run-lookups", jobId: item.jobId })
        .catch(() => null),
      new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline - Date.now())),
      ),
    ]);
    await loadQueue();
    const matched = jobForTab(url, queueItems);
    if (matched?.jobId === item.jobId && matched.plan) return matched;
    if (linkSaved || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, POSTING_POLL_MS));
  }
}

let closeKit: (() => Promise<void>) | null = null;

/** The apply kit for any queued job: answers to copy or fill by hand. */
async function openKit(item: QueueItem) {
  if (!client || activeRun || closeKit) return;
  const box = $("kit-box");
  box.hidden = false;
  $("main").hidden = true;
  const back = () => {
    closeKit = null;
    box.hidden = true;
    $("main").hidden = false;
    // The job may now be applied or skipped: its plan is stale and the queue changed.
    $("plan").hidden = true;
    $("plan").replaceChildren();
    void loadQueue();
  };
  const fillable = item.plan !== null && item.target.status === "matched";
  closeKit = await showKit(box, {
    client,
    job: { jobId: item.jobId, title: item.title, employer: item.employer },
    onBack: back,
    onDone: (note) => {
      back();
      showNotice(`${item.title} · ${item.employer}: ${note}`);
    },
    ...(fillable
      ? {
          onFill: () => {
            closeKit = null;
            box.hidden = true;
            void startFill(item);
          },
        }
      : {}),
    // The application you opened from the kit (Workday: after you sign in), filled in place.
    onFillHere: async () => {
      const tab = await activeTab();
      const paged = pagedFill(tab?.url ?? "");
      if (tab?.id === undefined || !paged)
        return "Open the application form in this window (on Workday, sign in and start it), then click Fill this page there.";
      closeKit = null;
      box.hidden = true;
      void startFill(item, tab.id, paged);
      return null;
    },
  });
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** A short note at the top of the main view (what the kit just did). */
function showNotice(text: string) {
  const notice = $("notice");
  notice.textContent = text;
  notice.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 8_000);
}

function kitButton(item: QueueItem): HTMLElement {
  const b = el("button", { type: "button" }, "Apply kit");
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    void openKit(item);
  });
  return b;
}

// Closing the panel ends supervision; the run stops without submitting anything.
window.addEventListener("pagehide", () => {
  void activeRun?.stop();
  void closeKit?.();
});

const loginForm = () => $<HTMLFormElement>("login-form");
const field = (name: string) =>
  loginForm().elements.namedItem(name) as HTMLInputElement;

async function start() {
  const settings = await loadSettings();
  field("server").value = settings.serverUrl;
  if (settings.username) field("username").value = settings.username;
  if (!settings.token) return showLogin();
  client = new ApplyClient(settings.serverUrl, settings.token);
  await showMain();
}

function showLogin(note?: string) {
  $("login").hidden = false;
  $("main").hidden = true;
  $("signout").hidden = true;
  const error = $("login-error");
  error.hidden = !note;
  error.textContent = note ?? "";
}

async function showMain() {
  $("login").hidden = true;
  $("main").hidden = false;
  $("signout").hidden = false;
  renderRun(await loadLastRun());
  renderCaptures(await loadCaptures());
  $("sites").hidden = await chrome.permissions.contains({
    origins: [ALL_SITES],
  });
  void claudeSettings.refresh();
  void loadBlocked();
  await loadQueue();
}

function handle(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    void saveSettings({ token: null });
    showLogin("Your session expired. Sign in again.");
    return;
  }
  $("last-run").textContent = message(error);
}

loginForm().addEventListener("submit", async (event) => {
  event.preventDefault();
  const serverUrl = field("server").value.trim().replace(/\/+$/, "");
  const username = field("username").value.trim();
  try {
    const token = await new ApplyClient(serverUrl, null).login(
      username,
      field("password").value,
    );
    await saveSettings({ serverUrl, token, username });
    field("password").value = "";
    client = new ApplyClient(serverUrl, token);
    await showMain();
  } catch (error) {
    showLogin(
      error instanceof ApiError && error.status === 401
        ? "Wrong username or password."
        : message(error),
    );
  }
});

$("signout").addEventListener("click", async () => {
  await saveSettings({ token: null });
  client = null;
  showLogin();
});

function captureLine(entry: CaptureEntry): string {
  const host = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  const { outcome } = entry;
  switch (outcome.status) {
    case "saved":
      return `${outcome.employer} · ${outcome.title} → ${host(outcome.link)} (saved)`;
    case "unchanged":
      return `${outcome.employer} · ${outcome.title} → ${host(outcome.link)} (already saved)`;
    case "unknown-job":
      return `${host(entry.report.applyUrl)}: not a job in your Job Ops list`;
    case "rejected":
    case "error":
      return `${host(entry.report.applyUrl)}: not saved (${outcome.reason})`;
  }
}

function renderCaptures(entries: readonly CaptureEntry[]) {
  $("captures").replaceChildren(
    ...(entries.length
      ? entries.map((e) => el("li", {}, captureLine(e)))
      : [el("li", { class: "muted" }, "None yet.")]),
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.captures)
    renderCaptures((changes.captures.newValue as CaptureEntry[]) ?? []);
});

function renderRun(summary: RunSummary | null) {
  const line = $("last-run");
  const details = $("run-details");
  if (!summary) {
    line.textContent =
      "Not run yet. Runs every 30 minutes while Chrome is open.";
    details.hidden = true;
    return;
  }
  const when = new Date(summary.finishedAt).toLocaleString();
  const count = summary.lines.length;
  line.textContent = summary.error
    ? `Last run ${when} stopped: ${summary.error}`
    : `Last run ${when}: ${count} lookup${count === 1 ? "" : "s"}${
        summary.skipped ? `, ${summary.skipped} waiting to retry` : ""
      }.`;
  $("run-lines").replaceChildren(
    ...summary.lines.map((l) => el("li", {}, `${l.employer}: ${l.outcome}`)),
  );
  details.hidden = count === 0;
}

$("run").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("run");
  button.disabled = true;
  button.textContent = "Running…";
  try {
    const summary = (await chrome.runtime.sendMessage({
      type: "run-lookups",
    })) as RunSummary | null;
    renderRun(summary);
    await loadQueue();
  } catch (error) {
    handle(error);
  } finally {
    button.disabled = false;
    button.textContent = "Run now";
  }
});

$("allow-sites").addEventListener("click", async () => {
  const granted = await chrome.permissions.request({
    origins: [ALL_SITES],
  });
  $("sites").hidden = granted;
});

const ATS_NAMES: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
};

/** Badge for a job's posting: "On Ashby", "Not on Greenhouse/Ashby/Lever", … */
function targetBadge(target: QueueItem["target"]): [string, string] {
  const system = ATS_NAMES[target.ats ?? ""] ?? "a supported system";
  const badges: Record<string, [string, string]> = {
    matched: ["ok", `On ${system}`],
    possible: ["warn", `Possible match on ${system}`],
    // Not a failure: the company takes applications elsewhere (Workday, its own site), filled
    // page by page once you open it.
    none: ["", "Not on Greenhouse/Ashby/Lever"],
    closed: ["bad", "Closed"],
    pending: ["", "Lookup pending"],
  };
  return badges[target.status] ?? ["", target.status];
}

async function loadQueue() {
  if (!client) return;
  let items: QueueItem[];
  try {
    items = await client.queue();
  } catch (error) {
    handle(error);
    return;
  }
  queueItems = items;
  void checkTab();
  renderQueue($("queue"), items, {
    row: queueRow,
    limit: (company) => void limitCompany(company),
    unlimit: (limit) => {
      if (!window.confirm(`Remove the limit on ${limit.name}?`)) return;
      void (client as ApplyClient)
        .unlimitCompany(limit.id)
        .then(loadQueue, handle);
    },
    block: (company) => void blockCompany(company),
  });
}

/** The blocked companies (Job Ops' own list), each with Unblock. */
async function loadBlocked() {
  if (!client) return;
  let blocked: readonly BlockedCompany[];
  try {
    blocked = await client.blockedCompanies();
  } catch (error) {
    handle(error);
    return;
  }
  $("blocked-count").textContent = blocked.length ? `(${blocked.length})` : "";
  $("blocked").replaceChildren(
    ...(blocked.length
      ? blocked.map((company) => {
          const unblock = el(
            "button",
            { type: "button", class: "link" },
            "Unblock",
          );
          unblock.addEventListener("click", () => void unblockCompany(company));
          return el(
            "li",
            {},
            el(
              "div",
              { class: "row" },
              el(
                "span",
                {},
                company.name,
                company.until
                  ? el(
                      "span",
                      { class: "muted" },
                      ` · until ${shortDay(company.until)}`,
                    )
                  : null,
              ),
              unblock,
            ),
            company.skippedJobs
              ? el(
                  "div",
                  { class: "muted" },
                  `${company.skippedJobs} job${company.skippedJobs === 1 ? "" : "s"} skipped; back on Unblock`,
                )
              : null,
          );
        })
      : [el("li", { class: "muted" }, "None blocked.")]),
  );
}

const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "Block…" on a company: fills in the Blocked companies form, where you can shorten the name
 * ("Amazon" for every Amazon entity: any company whose name contains it is blocked) and set
 * how many days.
 */
function blockCompany(company: string) {
  const card = $<HTMLDetailsElement>("blocked-card");
  card.open = true;
  $<HTMLInputElement>("block-name").value = company;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  $<HTMLInputElement>("block-days").focus();
}

async function submitBlock(name: string, days: number | undefined) {
  try {
    const result = await (client as ApplyClient).blockCompany(name, days);
    await Promise.all([loadBlocked(), loadQueue()]);
    showNotice(
      `Blocked "${result.name}"${result.until ? ` until ${shortDay(result.until)}` : ""}: ${plural(result.skippedJobs, "job")} skipped.`,
    );
  } catch (error) {
    handle(error);
  }
}

async function unblockCompany(company: BlockedCompany) {
  try {
    const result = await (client as ApplyClient).unblockCompany(company.name);
    await Promise.all([loadBlocked(), loadQueue()]);
    showNotice(
      `Unblocked "${result.name}": ${plural(result.restoredJobs, "job")} back.`,
    );
  } catch (error) {
    handle(error);
  }
}

$("block-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("block-name");
  const daysInput = $<HTMLInputElement>("block-days");
  const name = input.value.trim();
  if (name.length < 2) return;
  // Empty: blocked until you unblock it.
  const days = Math.round(Number(daysInput.value));
  input.value = "";
  daysInput.value = "";
  void submitBlock(name, days > 0 ? days : undefined);
});

/** Marks a company as one application per N months (asks how many; 6 by default). */
async function limitCompany(company: string) {
  const answer = window.prompt(
    `${company} takes one application from you every how many months?`,
    "6",
  );
  const months = Number(answer);
  if (!answer || !Number.isFinite(months) || months <= 0) return;
  try {
    await (client as ApplyClient).limitCompany({
      name: company,
      maxApplications: 1,
      windowDays: Math.round(months * 30.4),
      note: "Yours",
    });
    await loadQueue();
  } catch (error) {
    handle(error);
  }
}

/** Job Ops' AI suitability score (0-100) for the role. */
function scoreBadge(score: number | null): HTMLElement | null {
  if (score === null) return null;
  const tone = score >= 80 ? "ok" : score >= 60 ? "warn" : "";
  return el(
    "span",
    { class: `badge ${tone}`, title: "Job Ops' AI suitability score" },
    `AI ${Math.round(score)}`,
  );
}

/** One role in the queue: title, when posted, its badges and the kit. */
function queueRow(item: QueueItem, showEmployer: boolean): HTMLElement {
  const [tone, label] = targetBadge(item.target);
  const needs = item.plan?.summary.needsYou ?? 0;
  const posted = postedText(item.postedAt);
  const li = el(
    "li",
    { class: item.plan ? "clickable" : undefined },
    el("div", {}, item.title),
    showEmployer || posted
      ? el(
          "div",
          { class: "muted" },
          [showEmployer ? item.employer : "", posted]
            .filter(Boolean)
            .join(" · "),
        )
      : null,
    el(
      "div",
      { class: "row" },
      el(
        "div",
        {},
        scoreBadge(item.score),
        item.score === null ? null : " ",
        el("span", { class: `badge ${tone}` }, label),
        " ",
        item.plan
          ? el(
              "span",
              { class: `badge ${needs ? "warn" : "ok"}` },
              needs ? `${needs} need you` : "plan ready",
            )
          : null,
      ),
      kitButton(item),
    ),
  );
  if (item.plan) li.addEventListener("click", () => void showPlan(item));
  return li;
}

$("refresh").addEventListener("click", () => void loadQueue());

interface Entry {
  readonly label: string;
  readonly status: string;
  readonly value: string | string[] | null;
  readonly reason?: string;
  readonly actionClass: string;
}

const valueText = (entry: Entry) =>
  Array.isArray(entry.value) ? entry.value.join(", ") : (entry.value ?? "");

function startButton(item: QueueItem): HTMLElement {
  const b = el(
    "button",
    { type: "button", class: "primary" },
    "Start supervised fill",
  );
  b.addEventListener("click", () => void startFill(item));
  return b;
}

async function showPlan(item: QueueItem) {
  if (!client) return;
  const box = $("plan");
  box.hidden = false;
  box.replaceChildren(el("p", { class: "muted" }, "Loading plan…"));
  try {
    const plan = (await client.plan(item.jobId)) as { entries: Entry[] };
    const entries = plan.entries.filter((e) => e.status !== "skip");
    box.replaceChildren(
      el(
        "div",
        { class: "row" },
        el("strong", {}, item.title),
        item.target.postingUrl
          ? el(
              "a",
              { href: item.target.postingUrl, target: "_blank" },
              "Open posting ↗",
            )
          : null,
      ),
      ...(item.target.status === "matched"
        ? [
            el(
              "div",
              { class: "controls" },
              countdownPicker(await countdownSetting()),
              startButton(item),
              kitButton(item),
            ),
          ]
        : [el("div", { class: "controls" }, kitButton(item))]),
      ...entries.map((e) =>
        el(
          "div",
          { class: "entry" },
          el(
            "div",
            {},
            `${e.label} `,
            el(
              "span",
              { class: `badge ${e.status === "fill" ? "ok" : "warn"}` },
              e.status === "fill" ? e.actionClass : "needs you",
            ),
          ),
          el(
            "div",
            { class: "value muted" },
            e.status === "fill" ? valueText(e) : (e.reason ?? ""),
          ),
        ),
      ),
    );
  } catch (error) {
    box.replaceChildren(el("p", { class: "error" }, message(error)));
  }
}

// ---- the page you're on ----------------------------------------------------------------

let queueItems: QueueItem[] = [];

/** Confirmation pages you answered "Not yet" on (tab + address). */
const dismissed = new Set<string>();
let checking = 0;
/** The tab you're on, for "Add a job" → "Use this tab". */
let shownTab: chrome.tabs.Tab | undefined;

/**
 * When the current tab belongs to a queued job (its LinkedIn or Naukri page, the company page
 * you reached from there, or its application form), say so at the top: Fill this page where
 * it can be filled, the Apply kit, and "Mark Applied?" on a confirmation page.
 */
async function checkTab() {
  const box = $("here");
  const turn = ++checking;
  if (!client || activeRun) {
    box.hidden = true;
    return;
  }
  const tab = await activeTab();
  shownTab = tab;
  const match =
    tab?.id === undefined
      ? null
      : await resolveTab(tab.id, tab.url, queueItems);
  if (turn !== checking) return; // a newer check is running
  if (!match || tab?.id === undefined) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const tabId = tab.id;
  const seenKey = `${tabId} ${tab.url ?? ""}`;
  const submitted =
    !dismissed.has(seenKey) && (await looksSubmitted(tab)) === true;
  if (turn !== checking) return;
  // A job's posting with a plan is filled from its plan; any other page of it page by page.
  const paged =
    match.how === "posting" && match.item.plan
      ? null
      : pagedFill(tab.url ?? "");
  renderHere(
    box,
    match,
    submitted,
    {
      kitButton,
      fill: () => {
        box.hidden = true;
        void startFill(match.item, tabId, paged);
      },
      markApplied: async () => {
        await (client as ApplyClient).kitOutcome(match.item.jobId, "applied");
        box.hidden = true;
        showNotice(
          `${match.item.title} · ${match.item.employer}: Marked Applied in Job Ops.`,
        );
        await loadQueue();
      },
      dismiss: () => {
        dismissed.add(seenKey);
        void checkTab();
      },
    },
    paged,
  );
}

chrome.tabs.onActivated.addListener(() => void checkTab());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.status === "complete"))
    void checkTab();
});

const claudeSettings = setUpClaudeSettings(() => client);

setUpImport({
  client: () => client,
  currentTab: () => shownTab,
  onAdded: (note) => {
    showNotice(note);
    void loadQueue();
  },
});

void start();
