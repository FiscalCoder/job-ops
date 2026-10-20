import type { QueueItem } from "../lib/api";
import { isJobPage, type JobMatch, jobForAddress } from "./job-match";

/**
 * Tracked application tabs (APPLY_TRACE_AND_KIT_PLAN.md §T3): which job each tab is for.
 * - **Kept:** in session storage, so it's gone when the browser closes.
 * - **Recorded:** a tab's address only for job listings and application systems, plus tabs
 *   you opened for a job and tabs opened from those.
 * - **Dropped:** after 30 minutes without activity, or when the tab closes.
 */

const KEY = "trackedTabs";
export const IDLE_MS = 30 * 60 * 1000;
/** How far back "opened from" is followed (LinkedIn → company page → its ATS). */
const MAX_HOPS = 4;

export interface TabRecord {
  readonly url?: string;
  /** The tab this one was opened from. */
  readonly from?: number;
  /** Set once the tab is known to be for this job. */
  readonly jobId?: string;
  /** A supervised fill is running here (it records everything itself). */
  readonly supervised?: boolean;
  readonly seen: number;
}

type Book = Record<string, TabRecord>;

async function load(now = Date.now()): Promise<Book> {
  const { [KEY]: stored } = await chrome.storage.session.get(KEY);
  const book = (stored as Book | undefined) ?? {};
  return Object.fromEntries(
    Object.entries(book).filter(([, r]) => now - r.seen < IDLE_MS),
  );
}

const save = (book: Book) => chrome.storage.session.set({ [KEY]: book });

/** Changes run one after another, so two quick navigations can't overwrite each other. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(change: () => Promise<T>): Promise<T> {
  const next = queue.then(change, change);
  queue = next.catch(() => {});
  return next;
}

/** A tab's new address: kept for job pages, and for tabs already tied to a job. */
export function noteAddress(tabId: number, url: string): Promise<void> {
  return serial(async () => {
    const book = await load();
    const known = book[tabId];
    if (!known && !isJobPage(url)) return;
    await save({ ...book, [tabId]: { ...known, url, seen: Date.now() } });
  });
}

/** A tab opened from a tracked tab (Apply on LinkedIn, "Apply" on a careers page). */
export function noteOpener(tabId: number, from: number): Promise<void> {
  return serial(async () => {
    const book = await load();
    if (!book[from]) return;
    await save({
      ...book,
      [tabId]: { ...book[tabId], from, seen: Date.now() },
    });
  });
}

/** This tab is for this job (you opened it from the kit, or it was recognised). */
export function trackTab(tabId: number, jobId: string): Promise<void> {
  return serial(async () => {
    const book = await load();
    await save({
      ...book,
      [tabId]: { ...book[tabId], jobId, seen: Date.now() },
    });
  });
}

/** Marks a supervised fill starting or ending on this tab. */
export function setSupervised(tabId: number, on: boolean): Promise<void> {
  return serial(async () => {
    const book = await load();
    await save({
      ...book,
      [tabId]: { ...book[tabId], supervised: on, seen: Date.now() },
    });
  });
}

/** The tab's record, if it has one. */
export async function tabRecord(tabId: number): Promise<TabRecord | null> {
  return (await load())[tabId] ?? null;
}

export function forgetTab(tabId: number): Promise<void> {
  return serial(async () => {
    const book = await load();
    if (!book[tabId]) return;
    const { [tabId]: _gone, ...rest } = book;
    await save(rest);
  });
}

/**
 * The queued job this tab is for: its own address, a job it was tied to, or the tab it was
 * opened from (up to a few hops). What's found is remembered on the tab.
 */
export async function resolveTab(
  tabId: number,
  currentUrl: string | undefined,
  items: readonly QueueItem[],
): Promise<JobMatch | null> {
  const book = await load();
  const here = currentUrl ?? book[tabId]?.url;
  const byId = (jobId: string) => items.find((i) => i.jobId === jobId);
  const direct = here ? jobForAddress(here, items) : null;
  if (direct) {
    if (book[tabId]?.jobId !== direct.item.jobId)
      await trackTab(tabId, direct.item.jobId);
    return direct;
  }
  let id: number | undefined = tabId;
  for (let hop = 0; id !== undefined && hop < MAX_HOPS; hop++) {
    const record: TabRecord | undefined = book[id];
    const jobId =
      record?.jobId ??
      (hop > 0 && record?.url
        ? jobForAddress(record.url, items)?.item.jobId
        : undefined);
    const item = jobId ? byId(jobId) : undefined;
    if (item) {
      if (book[tabId]?.jobId !== item.jobId) await trackTab(tabId, item.jobId);
      return { item, how: "tracked" };
    }
    id = record?.from;
  }
  return null;
}
