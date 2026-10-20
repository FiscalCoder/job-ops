import { RunController } from "../../src/fill/controller";
import { activeTab } from "../../src/kit/page-fill";
import { ApiError, ApplyClient, type QueueItem } from "../../src/lib/api";
import {
  type CaptureEntry,
  loadCaptures,
  loadLastRun,
  loadSettings,
  saveSettings,
} from "../../src/lib/settings";
import { jobForTab } from "../../src/lib/tab-match";
import type { RunSummary } from "../../src/lib/worker";
import { showKit } from "./kit-view";
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

/** `tabId`: fill that open tab (you're on the application already) instead of a new one. */
async function startFill(item: QueueItem, tabId?: number) {
  if (!client || activeRun) return;
  const box = $("run-box");
  box.hidden = false;
  $("main").hidden = true;
  box.replaceChildren(
    el("p", { class: "muted" }, "Opening the posting and finding the form…"),
  );
  const closeRun = () => {
    activeRun = null;
    box.hidden = true;
    $("main").hidden = false;
    // The plan shown before the run is stale (the job may now be applied): reopen it from the queue.
    $("plan").hidden = true;
    $("plan").replaceChildren();
    void loadQueue();
  };
  try {
    activeRun = await RunController.start({
      client,
      job: item,
      countdownSeconds: await countdownSetting(),
      ...(tabId === undefined ? {} : { tabId }),
      onChange: (view) =>
        renderRunView(
          box,
          view,
          (event) => activeRun?.dispatch(event),
          closeRun,
        ),
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

let closeKit: (() => Promise<void>) | null = null;

/** The apply kit for any queued job: answers to copy or fill by hand. */
async function openKit(item: QueueItem) {
  if (!client || activeRun || closeKit) return;
  const box = $("kit-box");
  box.hidden = false;
  $("main").hidden = true;
  closeKit = await showKit(box, {
    client,
    job: { jobId: item.jobId, title: item.title, employer: item.employer },
    onBack: () => {
      closeKit = null;
      box.hidden = true;
      $("main").hidden = false;
      // The job may now be applied or skipped: its plan is stale and the queue changed.
      $("plan").hidden = true;
      $("plan").replaceChildren();
      void loadQueue();
    },
  });
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
    origins: ["https://*/*"],
  });
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
    origins: ["https://*/*"],
  });
  $("sites").hidden = granted;
});

const ATS_NAMES: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
};

/** Badge for a job's posting: "On Ashby", "Not found", … */
function targetBadge(target: QueueItem["target"]): [string, string] {
  const system = ATS_NAMES[target.ats ?? ""] ?? "a supported system";
  const badges: Record<string, [string, string]> = {
    matched: ["ok", `On ${system}`],
    possible: ["warn", `Possible match on ${system}`],
    none: ["", "Not found"],
    closed: ["bad", "Closed"],
    pending: ["", "Not checked yet"],
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
  const list = $("queue");
  if (items.length === 0) {
    list.replaceChildren(
      el("li", { class: "muted" }, "No Ready jobs in Job Ops."),
    );
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const [tone, label] = targetBadge(item.target);
      const needs = item.plan?.summary.needsYou ?? 0;
      const li = el(
        "li",
        { class: item.plan ? "clickable" : undefined },
        el("div", {}, item.title),
        el("div", { class: "muted" }, item.employer),
        el(
          "div",
          { class: "row" },
          el(
            "div",
            {},
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
    }),
  );
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

/**
 * When the current tab is the application page of a queued job (say LinkedIn's Apply took you
 * there), offer to fill that page or open the job's kit, right at the top.
 */
async function checkTab() {
  const box = $("here");
  if (!client || activeRun) {
    box.hidden = true;
    return;
  }
  const tab = await activeTab();
  const item = jobForTab(tab?.url, queueItems);
  if (!item || tab?.id === undefined) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const tabId = tab.id;
  const fill = el(
    "button",
    { type: "button", class: "primary" },
    "Fill this page",
  );
  fill.addEventListener("click", () => {
    box.hidden = true;
    void startFill(item, tabId);
  });
  box.replaceChildren(
    el("strong", {}, `You're on the application for ${item.title}`),
    el("p", { class: "muted" }, item.employer),
    item.plan
      ? el("div", { class: "controls" }, fill, kitButton(item))
      : el(
          "div",
          { class: "controls" },
          el(
            "span",
            { class: "muted" },
            "No fill plan yet (Run now builds one).",
          ),
          kitButton(item),
        ),
  );
  box.hidden = false;
}

chrome.tabs.onActivated.addListener(() => void checkTab());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.status === "complete"))
    void checkTab();
});

void start();
