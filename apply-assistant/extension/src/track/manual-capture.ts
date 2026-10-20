import { plainUrl } from "../fill/run-trace";
import { ApplyClient, type QueueItem } from "../lib/api";
import { loadSettings } from "../lib/settings";
import { captureDom, MAX_DOM_CHARS } from "../trace/dom";
import { TraceRecorder } from "../trace/recorder";
import { type FormPage, type WatchMessage, watchForm } from "./inspect";
import { resolveTab, tabRecord } from "./tabs";

/**
 * Records manual applications (background). On a tab that belongs to a queued job (never
 * LinkedIn, and only on sites the extension may read), each new form page gets:
 * - its fields with your answers (password and one-time-code values are never read);
 * - a page snapshot;
 * - a screenshot when the tab is in front.
 * Each answer you change, and each Next / Continue / Submit click with the whole page, are
 * also recorded. A tab running a supervised fill is skipped: the run records itself.
 */

const SETTLE_MS = 1_500;
const QUEUE_TTL_MS = 5 * 60 * 1000;
/** A page needs at least this many visible fields (or an upload) to count as a form. */
const MIN_FIELDS = 2;

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const lastPage = new Map<number, string>();
const recorders = new Map<string, TraceRecorder>();
let queueCache: { at: number; items: QueueItem[] } | null = null;

async function client(): Promise<ApplyClient | null> {
  const settings = await loadSettings();
  return settings.token
    ? new ApplyClient(settings.serverUrl, settings.token)
    : null;
}

async function queue(api: ApplyClient): Promise<QueueItem[]> {
  if (queueCache && Date.now() - queueCache.at < QUEUE_TTL_MS)
    return queueCache.items;
  const items = await api.queue();
  queueCache = { at: Date.now(), items };
  return items;
}

function recorder(api: ApplyClient, jobId: string): TraceRecorder {
  const existing = recorders.get(jobId);
  if (existing) return existing;
  const created = new TraceRecorder(api, jobId);
  recorders.set(jobId, created);
  return created;
}

const isLinkedIn = (url: string) =>
  /^https?:\/\/([^/]+\.)?linkedin\.com\//i.test(url);

/** The job and recorder for a tab we may record, or null. */
async function target(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // No address means Chrome hides it: a site the extension may not read.
  if (!tab?.url || !/^https?:/.test(tab.url) || isLinkedIn(tab.url))
    return null;
  if ((await tabRecord(tabId))?.supervised) return null;
  const api = await client();
  if (!api) return null;
  const match = await resolveTab(
    tabId,
    tab.url,
    await queue(api).catch(() => []),
  );
  if (!match) return null;
  return {
    tab,
    api,
    jobId: match.item.jobId,
    rec: recorder(api, match.item.jobId),
  };
}

const visible = (page: FormPage) => page.fields.filter((f) => !f.hidden);
const isForm = (page: FormPage) =>
  visible(page).length >= MIN_FIELDS ||
  page.fields.some((f) => f.type === "file");

/** Fields identify a form page; answers don't (so typing doesn't make a new page). */
const pageKey = (page: FormPage) =>
  `${plainUrl(page.url)}|${page.heading}|${visible(page)
    .map((f) => `${f.automationId || f.id || f.name}:${f.label}`)
    .join(",")}`;

/** Page snapshot of one frame, plus a screenshot when the tab is in front. */
function snapshot(
  rec: TraceRecorder,
  tab: chrome.tabs.Tab,
  frameId: number,
  reason: string,
) {
  void rec.snapshot(reason, async () => {
    const [dom] = await chrome.scripting.executeScript({
      target: { tabId: tab.id as number, frameIds: [frameId] },
      func: captureDom,
      args: [MAX_DOM_CHARS],
    });
    const shot = tab.active
      ? await chrome.tabs
          .captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 })
          .catch(() => null)
      : null;
    return {
      html: dom?.result?.html ?? null,
      url: dom?.result?.url ?? tab.url ?? null,
      screenshot: shot ? shot.replace(/^data:image\/jpeg;base64,/, "") : null,
    };
  });
}

/** Looks at the tab's settled page: a new form page is recorded. */
async function inspect(tabId: number): Promise<void> {
  const found = await target(tabId);
  if (!found) return;
  const { tab, rec } = found;
  const frames = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: watchForm,
      args: [true],
    })
    .catch(() => []);
  const best = frames
    .filter((f) => f.result && isForm(f.result))
    .sort(
      (a, b) =>
        visible(b.result as FormPage).length -
        visible(a.result as FormPage).length,
    )[0];
  if (!best?.result) return;
  const key = pageKey(best.result);
  if (lastPage.get(tabId) === key) return;
  lastPage.set(tabId, key);
  const page = best.result;
  const where = new URL(page.url).host;
  rec.event(
    "manual-page",
    `Form page on ${where}${page.heading ? `: ${page.heading}` : ""} (${visible(page).length} fields)`,
    { data: { ...page, url: plainUrl(page.url) } },
  );
  snapshot(rec, tab, best.frameId, `manual: ${page.heading || where}`);
}

function schedule(tabId: number) {
  const pending = timers.get(tabId);
  if (pending) clearTimeout(pending);
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      void inspect(tabId).catch(() => {});
    }, SETTLE_MS),
  );
}

async function onMessage(
  message: WatchMessage,
  sender: chrome.runtime.MessageSender,
) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  const found = await target(tabId);
  if (!found) return;
  const { tab, rec } = found;
  if (message.type === "manual-field") {
    const { field } = message;
    rec.event(
      "manual-field",
      `You filled "${field.label || field.name || field.id}"`,
      {
        data: { field, url: plainUrl(message.url) },
      },
    );
    return;
  }
  const filled = message.page.fields.filter(
    (f) => !f.hidden && (Array.isArray(f.value) ? f.value.length : f.value),
  ).length;
  rec.event(
    "manual-step",
    `You clicked "${message.button}" with ${filled} fields filled`,
    {
      data: {
        button: message.button,
        ...message.page,
        url: plainUrl(message.page.url),
      },
    },
  );
  // The page as you left it (its answers are final now).
  snapshot(rec, tab, sender.frameId ?? 0, `manual: before "${message.button}"`);
  // The next page may reuse the same fields; look again once it settles.
  lastPage.delete(tabId);
  schedule(tabId);
}

export function listenForManualApplications(): void {
  const settled = (details: { tabId: number; frameId: number }) => {
    if (details.frameId === 0 && details.tabId >= 0) schedule(details.tabId);
  };
  chrome.webNavigation.onCompleted.addListener(settled);
  chrome.webNavigation.onHistoryStateUpdated.addListener(settled);
  chrome.runtime.onMessage.addListener((message: { type?: string }, sender) => {
    if (message?.type === "manual-field" || message?.type === "manual-step")
      void onMessage(message as WatchMessage, sender).catch(() => {});
    return false;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    lastPage.delete(tabId);
    const pending = timers.get(tabId);
    if (pending) clearTimeout(pending);
    timers.delete(tabId);
  });
}
