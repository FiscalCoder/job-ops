import { ApplyClient } from "../lib/api";
import { addCapture, loadSettings } from "../lib/settings";
import {
  followed,
  linkedInJobIdOf,
  type PendingCapture,
  startCapture,
  toReport,
} from "./tracker";

/**
 * Browser wiring for LinkedIn apply-link capture. Remembers which LinkedIn job each tab shows
 * (from the address only), follows the tab LinkedIn's Apply button opens until it settles on
 * the company's page, then sends that link to the server.
 */

const TAB_JOBS = "linkedinTabJobs";
/** The tab counts as settled when it hasn't navigated for this long... */
const SETTLE_MS = 4_000;
/** ...or at the latest after this. */
const MAX_FOLLOW_MS = 20_000;
const LINKEDIN = { url: [{ hostSuffix: "linkedin.com" }] };

interface Following {
  pending: PendingCapture;
  settle: ReturnType<typeof setTimeout>;
  cap: ReturnType<typeof setTimeout>;
}

const following = new Map<number, Following>();

// The service worker may sleep between you opening a job and clicking Apply: session storage.
async function tabJobs(): Promise<Record<string, string>> {
  const { [TAB_JOBS]: jobs } = await chrome.storage.session.get(TAB_JOBS);
  return (jobs as Record<string, string> | undefined) ?? {};
}

async function rememberTabJob(tabId: number, url: string) {
  const jobs = await tabJobs();
  const id = linkedInJobIdOf(url);
  const next = { ...jobs };
  if (id) next[tabId] = id;
  else delete next[tabId];
  await chrome.storage.session.set({ [TAB_JOBS]: next });
}

/** Called when a captured link is saved (the background looks the job up again). */
let onSaved: () => void = () => {};

async function report(pending: PendingCapture) {
  const captured = toReport(pending);
  if (!captured) return;
  const settings = await loadSettings();
  if (!settings.token) return;
  const client = new ApplyClient(settings.serverUrl, settings.token);
  const outcome = await client.capture(captured).catch((error: unknown) => ({
    status: "error" as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
  await addCapture({ at: new Date().toISOString(), report: captured, outcome });
  if (outcome.status === "saved") onSaved();
}

function finish(tabId: number) {
  const entry = following.get(tabId);
  if (!entry) return;
  following.delete(tabId);
  clearTimeout(entry.settle);
  clearTimeout(entry.cap);
  void report(entry.pending);
}

function follow(tabId: number, pending: PendingCapture) {
  const existing = following.get(tabId);
  if (existing) clearTimeout(existing.settle);
  following.set(tabId, {
    pending,
    settle: setTimeout(() => finish(tabId), SETTLE_MS),
    cap: existing?.cap ?? setTimeout(() => finish(tabId), MAX_FOLLOW_MS),
  });
}

export function listenForLinkedInApplies(saved?: () => void): void {
  if (saved) onSaved = saved;
  const onLinkedInPage = (details: {
    tabId: number;
    frameId: number;
    url: string;
  }) => {
    if (details.frameId === 0) void rememberTabJob(details.tabId, details.url);
  };
  chrome.webNavigation.onCommitted.addListener(onLinkedInPage, LINKEDIN);
  chrome.webNavigation.onHistoryStateUpdated.addListener(
    onLinkedInPage,
    LINKEDIN,
  );

  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void tabJobs().then((jobs) => {
      const pending = startCapture(
        details.url,
        jobs[details.sourceTabId] ?? null,
      );
      if (pending) follow(details.tabId, pending);
    });
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    const entry = following.get(details.tabId);
    if (entry && details.frameId === 0)
      follow(details.tabId, followed(entry.pending, details.url));
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    finish(tabId);
    void tabJobs().then((jobs) => {
      if (!(tabId in jobs)) return;
      const { [tabId]: _closed, ...rest } = jobs;
      return chrome.storage.session.set({ [TAB_JOBS]: rest });
    });
  });
}
