import { Autopilot, type RunEnd } from "../../src/autopilot/runner";
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
import {
  askOnBar,
  autoExpireSetting,
  renderAutopilotBar,
} from "./autopilot-view";
import { setUpClaudeSettings } from "./claude-settings";
import { setUpImport } from "./import-view";
import { kitDrawer, showKit } from "./kit-view";
import {
  applyBadge,
  companyKey,
  isNew,
  isReadyToFill,
  matchesSearch,
  NO_FILTERS,
  passesFilters,
  postedText,
  QUEUE_SORTS,
  type QueueFilters,
  type QueueSort,
  renderQueue,
} from "./queue-view";
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
/** Closes the run on screen (as its Close button does). */
let closeActiveRun: (() => void) | null = null;

const COUNTDOWN_CHOICES = ["3", "1", "0"];

async function countdownSetting(): Promise<number> {
  const { countdownSeconds } =
    await chrome.storage.local.get("countdownSeconds");
  return typeof countdownSeconds === "number" ? countdownSeconds : 3;
}

/** Settings → Filling: the countdown before each automatic step (or approve each yourself). */
async function setUpCountdown(): Promise<void> {
  const select = $<HTMLSelectElement>("settings-countdown");
  const current = await countdownSetting();
  select.replaceChildren(
    ...COUNTDOWN_CHOICES.map((v) => {
      const option = el(
        "option",
        { value: v },
        v === "0"
          ? "Wait for my approval"
          : `${v} second${v === "1" ? "" : "s"} countdown`,
      ) as HTMLOptionElement;
      option.selected = Number(v) === current;
      return option;
    }),
  );
  select.onchange = () =>
    void chrome.storage.local.set({ countdownSeconds: Number(select.value) });
}

/** Where you were in the queue before a run or the kit took the panel: back there after. */
let queueScroll = 0;
const leaveQueue = () => {
  queueScroll = window.scrollY;
};
const backToQueue = () =>
  void loadQueue().then(() =>
    requestAnimationFrame(() => window.scrollTo(0, queueScroll)),
  );

/**
 * `tabId`: fill that open tab (you're on the application already) instead of a new one;
 * `workday`: that tab is a Workday application, filled page by page.
 */
async function startFill(
  item: QueueItem,
  tabId?: number,
  paged: "workday" | "generic" | null = null,
  /** Autopilot: Claude takes over stuck fields by itself; told when the run ends. */
  auto?: { onEnd: (end: RunEnd) => void },
) {
  if (!client || activeRun) {
    auto?.onEnd("failed");
    return;
  }
  const box = $("run-box");
  if (!$("main").hidden) leaveQueue();
  box.hidden = false;
  $("main").hidden = true;
  box.replaceChildren(
    el("p", { class: "muted" }, "Opening the posting and finding the form…"),
  );
  // A Greenhouse, Ashby or Lever posting is filled from its own form, once it's looked up.
  // Not on autopilot: Greenhouse's own plan leaves out its Employment section, which the
  // page reader fills (a job per entry, Add another for the rest).
  const posting =
    paged === "generic" && tabId !== undefined && !auto
      ? await matchPosting(tabId, item)
      : null;
  const job = posting ?? item;
  const pagedHow = posting ? null : paged;
  const closeRun = () => {
    void kit.close();
    activeRun = null;
    closeActiveRun = null;
    box.hidden = true;
    $("main").hidden = false;
    // The plan shown before the run is stale (the job may now be applied): reopen it from the queue.
    $("plan").hidden = true;
    $("plan").replaceChildren();
    backToQueue();
  };
  closeActiveRun = closeRun;
  // The run re-renders its part; Ask Claude below it keeps what you typed.
  const runPart = el(
    "div",
    {},
    el("p", { class: "muted" }, "Opening the posting and finding the form…"),
  );
  // To take over by hand: the kit, folded away until you open it.
  const kit = kitDrawer(client, {
    jobId: job.jobId,
    title: job.title,
    employer: job.employer,
  });
  box.replaceChildren(runPart, kit.element, askClaude(client, job.jobId));
  // Autopilot goes on to the next job a moment after this run ends (you see how it ended).
  let ended = false;
  const endFor = (end: RunEnd, after: number) => {
    if (!auto || ended) return;
    ended = true;
    setTimeout(() => {
      closeRun();
      auto.onEnd(end);
    }, after);
  };
  try {
    const options = {
      client,
      job,
      countdownSeconds: await countdownSetting(),
      ...(auto ? { autopilot: true } : {}),
      onChange: (view: RunView) => {
        if (view.action.kind === "finished")
          endFor(
            view.state.outcome === "submitted" ? "submitted" : "aborted",
            AUTOPILOT_NEXT_MS,
          );
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
          (section) => activeRun?.fillOnly(section),
          () => activeRun?.readPageClosely(),
          async (seq, how) =>
            activeRun
              ? activeRun.fixField(seq, how)
              : "The run has ended.",
          (note) => activeRun?.tellClaude(note) ?? "The run has ended.",
        );
      },
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
    endFor("failed", AUTOPILOT_ERROR_MS);
  }
}

/** How long a finished run (or one that couldn't start) shows before autopilot moves on. */
const AUTOPILOT_NEXT_MS = 2_000;
const AUTOPILOT_ERROR_MS = 5_000;

let autopilot: Autopilot | null = null;

/** Autopilot over the queue: highest score first; you check and submit each application. */
/** How often autopilot looks whether the run on screen has ended. */
const RUN_ON_SCREEN_POLL_MS = 1_000;

async function startAutopilot() {
  if (!client || autopilot?.running || activeRun) return;
  const statusBox = $("autopilot-status");
  const askBox = $("autopilot-ask");
  askBox.replaceChildren();
  const pilot: Autopilot = new Autopilot({
    client,
    queue: async () => {
      await loadQueue();
      return queueItems.filter((item) => !hiddenCompanies.has(companyKey(item)));
    },
    fill: async (item, tabId, paged) => {
      // A run still on screen (one you started, or finished and not closed) would refuse this
      // one, and autopilot would rush on to the next job: a finished one is closed, one still
      // going is waited for.
      while (activeRun && pilot.running) {
        if (activeRun.ended) closeActiveRun?.();
        else await new Promise((r) => setTimeout(r, RUN_ON_SCREEN_POLL_MS));
      }
      return new Promise<RunEnd>((resolve) => {
        void startFill(item, tabId, paged ?? null, { onEnd: resolve });
      });
    },
    ask: (question) => askOnBar(askBox, question),
    status: (status) =>
      void autoExpireSetting().then((auto) =>
        renderAutopilotBar(
          statusBox,
          status,
          {
            stop: () => {
              pilot.stop();
              void activeRun?.stop();
            },
            skip: () => {
              pilot.skip();
              void activeRun?.stop();
            },
            // Pause: the fill on screen pauses too, so you can fix things by hand; Resume goes
            // on from there, keeping what you changed.
            pause: () => {
              pilot.pause();
              activeRun?.dispatch({ type: "pause" });
            },
            resume: () => {
              pilot.resume();
              activeRun?.dispatch({ type: "resume" });
            },
          },
          auto,
        ),
      ),
    autoExpire: autoExpireSetting,
  });
  autopilot = pilot;
  await pilot.run();
}

const isGreenhouse = (url: string) => {
  try {
    return /(^|\.)greenhouse\.io$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

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
  // Reached from a job board (startup.jobs): this posting becomes the job's link, so its
  // lookup starts here instead of guessing the company's board.
  if (pageKey(item.applicationLink ?? "") !== here)
    await client?.saveApplicationLink(item.jobId, url).catch(() => null);
  // Greenhouse's own plan leaves out its Employment section: the page reader fills it all.
  if (isGreenhouse(url)) return null;
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
  leaveQueue();
  box.hidden = false;
  $("main").hidden = true;
  const back = () => {
    closeKit = null;
    box.hidden = true;
    $("main").hidden = false;
    // The job may now be applied or skipped: its plan is stale and the queue changed.
    $("plan").hidden = true;
    $("plan").replaceChildren();
    backToQueue();
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

/** A short note at the top of the main view (what the kit just did), with an action (Undo). */
function showNotice(
  text: string,
  action?: { readonly label: string; readonly run: () => void },
) {
  const notice = $("notice");
  notice.textContent = text;
  if (action) {
    const b = el("button", { type: "button", class: "link" }, action.label);
    b.addEventListener("click", () => {
      notice.hidden = true;
      action.run();
    });
    notice.append(" ", b);
  }
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
  $("settings").hidden = true;
  $("header-actions").hidden = true;
  const error = $("login-error");
  error.hidden = !note;
  error.textContent = note ?? "";
}

async function showMain() {
  $("login").hidden = true;
  $("main").hidden = false;
  $("header-actions").hidden = false;
  const settings = await loadSettings();
  $("signed-in").textContent = settings.username
    ? `Signed in as ${settings.username} · ${hostName(settings.serverUrl)}`
    : `Signed in · ${hostName(settings.serverUrl)}`;
  void setUpCountdown();
  renderRun(await loadLastRun());
  renderCaptures(await loadCaptures());
  $("sites").hidden = await chrome.permissions.contains({
    origins: [ALL_SITES],
  });
  void claudeSettings.refresh();
  void loadBlocked();
  await loadQueuePrefs();
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

const hostName = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

// ---- the header: + Add job, Settings ----------------------------------------------------

/** What Settings covered (the queue, a run, the kit): shown again on Done. */
let underSettings: HTMLElement[] = [];

function openSettings() {
  if (!$("settings").hidden) return;
  underSettings = ["main", "run-box", "kit-box"]
    .map((id) => $(id))
    .filter((box) => !box.hidden);
  for (const box of underSettings) box.hidden = true;
  $("settings").hidden = false;
  window.scrollTo(0, 0);
}

function closeSettings() {
  $("settings").hidden = true;
  for (const box of underSettings) box.hidden = false;
  underSettings = [];
}

$("settings-open").addEventListener("click", () =>
  $("settings").hidden ? openSettings() : closeSettings(),
);
$("settings-close").addEventListener("click", closeSettings);
$("add-open").addEventListener("click", () => {
  closeSettings();
  if (activeRun || closeKit) {
    showNotice("Finish or close the application on screen first.");
    return;
  }
  $("import-card").hidden = false;
  window.scrollTo(0, 0);
  $<HTMLInputElement>("import-url").focus();
});
$("add-close").addEventListener("click", () => {
  $("import-card").hidden = true;
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
  // Shown on the folded card's heading.
  $("captures-count").textContent = entries.length
    ? `· ${entries.length} saved`
    : "";
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
  const state = $("lookups-state");
  if (!summary) {
    line.textContent =
      "Not run yet. Runs every 30 minutes while Chrome is open.";
    state.textContent = "· not run yet";
    details.hidden = true;
    return;
  }
  const when = new Date(summary.finishedAt).toLocaleString();
  // Shown on the folded card's heading.
  state.textContent = summary.error
    ? "· last run stopped"
    : `· last run ${new Date(summary.finishedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
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
  showQueue();
}

// ---- sorting and hiding (this browser's, kept between sessions) --------------------------

/** Companies you hid (companyKey → the name shown), out of the queue and Autopilot. */
let hiddenCompanies = new Map<string, string>();
/** "N hidden · Show": the hidden companies listed too, each with Unhide. */
let showingHidden = false;
let queueSort: QueueSort = "best";
let queueFilters: QueueFilters = NO_FILTERS;
/** When you last opened the panel before this time: jobs found since then are New. */
let newSince: number | null = null;

async function loadQueuePrefs() {
  const saved = await chrome.storage.local
    .get(["hiddenCompanies", "queueSort", "queueFilters", "lastQueueVisit"])
    .catch(() => ({}) as Record<string, unknown>);
  if (newSince === null && typeof saved.lastQueueVisit === "number")
    newSince = saved.lastQueueVisit;
  void chrome.storage.local
    .set({ lastQueueVisit: Date.now() })
    .catch(() => undefined);
  const filters = saved.queueFilters as Partial<QueueFilters> | undefined;
  if (filters && typeof filters === "object")
    queueFilters = {
      posted: ["1", "3", "7"].includes(String(filters.posted))
        ? (filters.posted as QueueFilters["posted"])
        : "any",
      remote: filters.remote === true,
      ready: filters.ready === true,
    };
  renderChips();
  const hidden = saved.hiddenCompanies;
  if (hidden && typeof hidden === "object")
    hiddenCompanies = new Map(
      Object.entries(hidden as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  const sort = QUEUE_SORTS.find((s) => s.value === saved.queueSort);
  if (sort) queueSort = sort.value;
  $<HTMLSelectElement>("queue-sort").value = queueSort;
}

const saveHidden = () =>
  void chrome.storage.local
    .set({ hiddenCompanies: Object.fromEntries(hiddenCompanies) })
    .catch(() => undefined);

function hideCompany(key: string, company: string) {
  hiddenCompanies.set(key, company);
  saveHidden();
  showQueue();
  showNotice(`Hid ${company} from your queue and Autopilot.`, {
    label: "Undo",
    run: () => unhideCompany(key),
  });
}

function unhideCompany(key: string) {
  hiddenCompanies.delete(key);
  saveHidden();
  if (hiddenCompanies.size === 0) showingHidden = false;
  showQueue();
}

{
  const sort = $<HTMLSelectElement>("queue-sort");
  sort.replaceChildren(
    ...QUEUE_SORTS.map((s) => el("option", { value: s.value }, s.label)),
  );
  sort.addEventListener("change", () => {
    queueSort = sort.value as QueueSort;
    void chrome.storage.local.set({ queueSort }).catch(() => undefined);
    showQueue();
  });
  $("queue-hidden").addEventListener("click", () => {
    showingHidden = !showingHidden;
    showQueue();
  });
}

/** The filter chips: posted within (one of), Remote, Ready to fill. */
const CHIPS: readonly {
  readonly label: string;
  readonly on: (f: QueueFilters) => boolean;
  readonly toggle: (f: QueueFilters) => QueueFilters;
}[] = [
  ...(["1", "3", "7"] as const).map((days) => ({
    label: days === "1" ? "Last 24h" : days === "3" ? "Last 3 days" : "Last week",
    on: (f: QueueFilters) => f.posted === days,
    toggle: (f: QueueFilters) => ({
      ...f,
      posted: f.posted === days ? ("any" as const) : days,
    }),
  })),
  {
    label: "Remote",
    on: (f) => f.remote,
    toggle: (f) => ({ ...f, remote: !f.remote }),
  },
  {
    label: "Ready to fill",
    on: (f) => f.ready,
    toggle: (f) => ({ ...f, ready: !f.ready }),
  },
];

function renderChips() {
  $("queue-filters").replaceChildren(
    ...CHIPS.map((chip) => {
      const on = chip.on(queueFilters);
      const b = el(
        "button",
        { type: "button", class: "chip", "aria-pressed": String(on) },
        chip.label,
      );
      b.addEventListener("click", () => {
        queueFilters = chip.toggle(queueFilters);
        void chrome.storage.local
          .set({ queueFilters })
          .catch(() => undefined);
        renderChips();
        showQueue();
      });
      return b;
    }),
  );
}

const filtering = () =>
  queueFilters.posted !== "any" || queueFilters.remote || queueFilters.ready;

/** The queue as your search, sort and hidden companies shape it. */
function showQueue() {
  const query = $<HTMLInputElement>("queue-search").value.trim();
  const isHidden = (item: QueueItem) => hiddenCompanies.has(companyKey(item));
  const hiddenJobs = queueItems.filter(isHidden).length;
  const shown = queueItems.filter(
    (item) =>
      matchesSearch(item, query) &&
      passesFilters(item, queueFilters) &&
      (showingHidden || !isHidden(item)),
  );
  const visible = queueItems.length - (showingHidden ? 0 : hiddenJobs);
  const fresh = shown.filter((item) => isNew(item, newSince)).length;
  $("queue-count").textContent = [
    query || filtering()
      ? `${shown.length} of ${visible} jobs`
      : `${visible} job${visible === 1 ? "" : "s"}`,
    fresh ? `${fresh} new since you last looked` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const toggle = $("queue-hidden");
  toggle.hidden = hiddenCompanies.size === 0;
  toggle.textContent = showingHidden
    ? "Hide hidden companies"
    : `${hiddenCompanies.size} hidden compan${hiddenCompanies.size === 1 ? "y" : "ies"} · Show`;
  $("queue-meta").hidden = queueItems.length === 0;
  if ((query || filtering()) && !shown.length) {
    const clear = el("button", { type: "button", class: "link" }, "Clear filters");
    clear.addEventListener("click", () => {
      queueFilters = NO_FILTERS;
      $<HTMLInputElement>("queue-search").value = "";
      void chrome.storage.local.set({ queueFilters }).catch(() => undefined);
      renderChips();
      showQueue();
    });
    $("queue").replaceChildren(
      el(
        "li",
        { class: "muted" },
        query ? `No jobs match "${query}" with these filters. ` : "No jobs with these filters. ",
        clear,
      ),
    );
    return;
  }
  renderQueue(
    $("queue"),
    shown,
    {
      row: queueRow,
      limit: (company) => limitCompany(company),
      unlimit: (limit) => unlimitCompany(limit),
      block: (company) => blockCompany(company),
      hide: hideCompany,
      unhide: unhideCompany,
    },
    { sort: queueSort, hidden: new Set(hiddenCompanies.keys()) },
  );
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
 * A small form right under the company it's about (Block, Limit, Remove limit), instead of a
 * pop-up or a form at the bottom of the panel. One at a time; Cancel or Escape closes it.
 */
function inlineForm(
  company: string,
  ...content: (HTMLElement | string)[]
): { readonly form: HTMLFormElement; readonly close: () => void } {
  for (const open of $("queue").querySelectorAll(".inline-form")) open.remove();
  const anchor = [...$("queue").querySelectorAll<HTMLElement>("[data-company]")].find(
    (li) => li.dataset.company === company,
  );
  const form = el("form", { class: "inline-form-body" }) as HTMLFormElement;
  const li = el("li", { class: "inline-form" }, form);
  const close = () => li.remove();
  const cancel = el("button", { type: "button" }, "Cancel");
  cancel.addEventListener("click", close);
  form.append(...content);
  // The form's own button (Block, Save) beside Cancel.
  form.append(
    el(
      "div",
      { class: "controls" },
      ...form.querySelectorAll<HTMLElement>("button[data-main]"),
      cancel,
    ),
  );
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  if (anchor) anchor.after(li);
  else $("queue").prepend(li);
  li.scrollIntoView({ block: "nearest" });
  form.querySelector<HTMLInputElement>("input")?.focus();
  return { form, close };
}

const mainButton = (label: string) =>
  el("button", { type: "submit", class: "primary", "data-main": "" }, label);

/**
 * "Block…" on a company: its name (shorten it to block every entity: "Amazon") and for how
 * many days; empty days block until you unblock.
 */
function blockCompany(company: string) {
  const name = el("input", {
    type: "text",
    value: company,
    "aria-label": "Company to block (any company whose name contains it)",
  }) as HTMLInputElement;
  const days = el("input", {
    type: "number",
    min: "1",
    max: "3650",
    placeholder: "Days",
    class: "days",
    "aria-label": "Days to block, from your last application there",
  }) as HTMLInputElement;
  const { form, close } = inlineForm(
    company,
    el("strong", {}, `Block ${company}`),
    el(
      "p",
      { class: "muted" },
      "Job Ops won't find its jobs, and skips the ones you have. Shorten the name to block every entity (Amazon). Empty days: until you unblock it in Settings.",
    ),
    el("div", { class: "row" }, name, days),
    mainButton("Block"),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (value.length < 2) return;
    const n = Math.round(Number(days.value));
    close();
    void submitBlock(value, n > 0 ? n : undefined);
  });
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

/** Marks a company as one application per N months (6 by default), in place. */
function limitCompany(company: string) {
  const months = el("input", {
    type: "number",
    min: "1",
    max: "60",
    value: "6",
    class: "days",
    "aria-label": "Months between applications",
  }) as HTMLInputElement;
  const { form, close } = inlineForm(
    company,
    el("strong", {}, `Limit ${company}`),
    el(
      "label",
      { class: "inline" },
      "One application every",
      months,
      "months",
    ),
    mainButton("Save"),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const n = Number(months.value);
    if (!Number.isFinite(n) || n <= 0) return;
    close();
    try {
      await (client as ApplyClient).limitCompany({
        name: company,
        maxApplications: 1,
        windowDays: Math.round(n * 30.4),
        note: "Yours",
      });
      await loadQueue();
    } catch (error) {
      handle(error);
    }
  });
}

/** Remove limit: asked in place, under the company. */
function unlimitCompany(limit: { readonly id: number; readonly name: string }) {
  const { form, close } = inlineForm(
    limit.name,
    el("strong", {}, `Remove the limit on ${limit.name}?`),
    mainButton("Remove limit"),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    close();
    void (client as ApplyClient).unlimitCompany(limit.id).then(loadQueue, handle);
  });
}

/** Job Ops' reasons, once asked for (by job). */
const reasons = new Map<string, string>();

/**
 * Job Ops' AI suitability score (0-100) for the role: click it for why (Skills x/50 ·
 * Experience x/30 · Location x/20, and the reason), shown under the row.
 */
function scoreBadge(item: QueueItem, row: HTMLElement): HTMLElement | null {
  const { score } = item;
  if (score === null) return null;
  const tone = score >= 80 ? "ok" : score >= 60 ? "warn" : "";
  const b = el(
    "button",
    {
      type: "button",
      class: `badge score ${tone}`,
      title: "Why this score",
      "aria-expanded": "false",
    },
    `AI ${Math.round(score)} ▾`,
  );
  b.addEventListener("click", async (event) => {
    event.stopPropagation();
    const open = row.querySelector(".why");
    if (open) {
      open.remove();
      b.setAttribute("aria-expanded", "false");
      return;
    }
    const why = el("div", { class: "why muted" }, "Loading why…");
    row.append(why);
    b.setAttribute("aria-expanded", "true");
    const known = reasons.get(item.jobId);
    if (known) {
      why.textContent = known;
      return;
    }
    try {
      const answer = await (client as ApplyClient).scoreReason(item.jobId);
      const text = answer.reason?.trim() || "Job Ops gave no reason for this score.";
      reasons.set(item.jobId, text);
      why.textContent = text;
    } catch (error) {
      why.textContent = `Couldn't load why: ${message(error)}`;
    }
  });
  return b;
}

/** Where to apply: the posting found, else the company's link, else the listing. */
const applyUrl = (item: QueueItem) =>
  item.target.postingUrl ?? item.applicationLink ?? item.jobUrl ?? null;

/**
 * The row's main action. Ready to fill (its form is planned): the supervised fill. A closed
 * posting: Mark expired. Else its application opens in a tab, where "Fill this page" (top of
 * the panel) fills it.
 */
function applyButton(item: QueueItem): HTMLElement {
  if (item.target.status === "closed") {
    const b = el(
      "button",
      { type: "button", title: "The posting is closed: expire it in Job Ops" },
      "Mark expired",
    );
    b.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await (client as ApplyClient).expireJob(item.jobId, "You marked it expired from the queue (closed posting)");
        showNotice(`${item.title} · ${item.employer}: marked expired in Job Ops.`);
        await loadQueue();
      } catch (error) {
        handle(error);
      }
    });
    return b;
  }
  const ready = isReadyToFill(item);
  const b = el(
    "button",
    {
      type: "button",
      class: "primary",
      title: ready
        ? "Open the posting and fill it, step by step with you"
        : "Open the application in a tab; then click Fill this page at the top",
    },
    "Apply",
  );
  b.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (ready) {
      void startFill(item);
      return;
    }
    const url = applyUrl(item);
    if (!url) {
      showNotice("No link for this job yet: use its Apply kit.");
      return;
    }
    await chrome.tabs.create({ url, active: true });
    showNotice(
      `Opened ${item.employer}'s application. When its form shows, click Fill this page at the top (on Workday, sign in first).`,
    );
  });
  return b;
}

/** "Chennai, Tamil Nadu, India" → "Chennai"; "Remote" stays. */
const placeText = (location: string | null | undefined) =>
  (location ?? "").split(",")[0]?.trim() ?? "";

/** One role in the queue: title, company, place, when posted, pay, its badges and the kit. */
function queueRow(
  item: QueueItem,
  showEmployer: boolean,
  menu?: HTMLElement,
): HTMLElement {
  const where = applyBadge(item);
  const needs = item.plan?.summary.needsYou ?? 0;
  const url = applyUrl(item);
  const facts = [
    showEmployer ? item.employer : "",
    placeText(item.location),
    postedText(item.postedAt),
    item.salary?.trim() ?? "",
  ].filter(Boolean);
  const title = url
    ? el(
        "a",
        { href: url, target: "_blank", class: "label title", title: "Open the posting" },
        item.title,
      )
    : el("span", { class: "label title" }, item.title);
  title.addEventListener("click", (event) => event.stopPropagation());
  const li = el(
    "li",
    {
      class: item.plan ? "clickable" : undefined,
      title: item.plan ? "Click to see what will be filled" : undefined,
    },
    el("div", { class: "row role" }, title, menu ?? null),
    facts.length ? el("div", { class: "muted" }, facts.join(" · ")) : null,
  );
  li.append(
    el(
      "div",
      { class: "row" },
      el(
        "div",
        { class: "badges" },
        isNew(item, newSince) ? el("span", { class: "badge new" }, "New") : null,
        scoreBadge(item, li),
        where ? el("span", { class: `badge ${where.tone}` }, where.label) : null,
        item.plan
          ? el(
              "span",
              { class: `badge ${needs ? "warn" : "ok"}` },
              needs ? `${needs} need you` : "ready to fill",
            )
          : null,
      ),
      el("div", { class: "controls" }, kitButton(item), applyButton(item)),
    ),
  );
  if (item.plan) li.addEventListener("click", () => void showPlan(item));
  return li;
}

// An open "⋯" menu closes on a click elsewhere, or Escape.
const closeMenus = (except?: EventTarget | null) => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]"))
    if (!(except instanceof Node && menu.contains(except))) menu.open = false;
};
document.addEventListener("click", (event) => closeMenus(event.target));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

$("refresh").addEventListener("click", () => void loadQueue());
$("queue-search").addEventListener("input", () => showQueue());
$("autopilot-start").addEventListener("click", () => {
  const box = $("autopilot-confirm");
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  const jobs = queueItems.filter(
    (item) => !hiddenCompanies.has(companyKey(item)) && item.target.status !== "closed",
  ).length;
  const go = el("button", { type: "button", class: "primary", id: "autopilot-go" }, "Start Autopilot");
  const cancel = el("button", { type: "button" }, "Cancel");
  go.addEventListener("click", () => {
    box.hidden = true;
    void startAutopilot();
  });
  cancel.addEventListener("click", () => {
    box.hidden = true;
  });
  box.replaceChildren(
    el(
      "p",
      {},
      `Autopilot goes through the ${jobs} job${jobs === 1 ? "" : "s"} in your queue${hiddenCompanies.size ? " (hidden companies left out)" : ""}, best score first: it opens each application, fills it, and Claude steps in where a field gets stuck. You check and submit each one yourself; Pause or Stop any time.`,
    ),
    el("div", { class: "controls" }, go, cancel),
  );
  box.hidden = false;
});

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

/** A plan entry's class in plain words. */
const HOW_FILLED: Record<string, string> = {
  auto: "fills itself",
  confirm: "you approve",
  protected: "asks you first",
};

function closePlanButton(): HTMLElement {
  const b = el(
    "button",
    { type: "button", class: "icon", "aria-label": "Close the plan", title: "Close" },
    "✕",
  );
  b.addEventListener("click", () => {
    $("plan").hidden = true;
    $("plan").replaceChildren();
  });
  return b;
}

async function showPlan(item: QueueItem) {
  if (!client) return;
  const box = $("plan");
  box.hidden = false;
  box.replaceChildren(el("p", { class: "muted" }, "Loading plan…"));
  // The plan opens above the queue: brought into view however far down you clicked.
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  try {
    const plan = (await client.plan(item.jobId)) as { entries: Entry[] };
    const entries = plan.entries.filter((e) => e.status !== "skip");
    box.replaceChildren(
      el(
        "div",
        { class: "row" },
        el("strong", {}, item.title),
        closePlanButton(),
      ),
      ...(item.target.postingUrl
        ? [
            el(
              "a",
              { href: item.target.postingUrl, target: "_blank" },
              "Open posting ↗",
            ),
          ]
        : []),
      el(
        "div",
        { class: "controls" },
        ...(item.target.status === "matched" ? [startButton(item)] : []),
        kitButton(item),
      ),
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
              e.status === "fill"
                ? (HOW_FILLED[e.actionClass] ?? e.actionClass)
                : "needs your answer",
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
    $("import-card").hidden = true;
    void loadQueue();
  },
});

void start();
