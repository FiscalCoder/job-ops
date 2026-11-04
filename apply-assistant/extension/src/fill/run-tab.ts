import {
  type Browser,
  connect,
  ExtensionTransport,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { samePosting } from "../lib/tab-match";
import { setSupervised } from "../track/tabs";
import type { FormDriver } from "./trusted";

/** Opening, waiting on and attaching to the tab a run fills. */

const TAB_LOAD_TIMEOUT_MS = 30_000;

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("The posting took too long to load"));
    }, TAB_LOAD_TIMEOUT_MS);
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** A careers page may send you on (to the job's own page) right after loading. */
const REDIRECT_SETTLE_MS = 1_500;
const MAX_REDIRECTS = 3;

/** Waits for the tab's load and any redirect right after it. */
export async function waitForTabSettled(tabId: number): Promise<void> {
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, REDIRECT_SETTLE_MS));
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status !== "loading") return;
    await waitForTabLoad(tabId);
  }
}

/**
 * The tab to fill: a new one on the form, or the tab you're on (moved to the form only when
 * it shows something else, so nothing you already typed there is reloaded away).
 */
export async function openForm(
  url: string,
  tabId?: number,
): Promise<chrome.tabs.Tab> {
  if (tabId === undefined) {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id !== undefined) {
      await waitForTabLoad(tab.id);
      await waitForTabSettled(tab.id);
    }
    return tab;
  }
  const current = await chrome.tabs.get(tabId);
  if (current.url && samePosting(current.url, url)) {
    if (current.status !== "complete") await waitForTabLoad(tabId);
    return (await chrome.tabs.update(tabId, { active: true })) ?? current;
  }
  const loading = waitForTabLoad(tabId);
  const moved = await chrome.tabs.update(tabId, { url, active: true });
  await loading;
  await waitForTabSettled(tabId);
  return moved ?? current;
}

/**
 * Lets go of the form's tab. Puppeteer detaches Chrome's debugger without handling errors, so
 * on a tab you already closed it logged "No tab with given id"; Chrome detaches by itself then.
 */
export async function release(browser: Browser, tabId: number): Promise<void> {
  await setSupervised(tabId, false);
  const open = await chrome.tabs.get(tabId).then(
    () => true,
    () => false,
  );
  if (open) await browser.disconnect().catch(() => {});
}

/** Puppeteer's error for a frame the page replaced (it navigated) while being read. */
export const DETACHED = /detached frame/i;

export interface Attached {
  readonly browser: Browser;
  readonly page: Page | undefined;
  readonly driver: FormDriver | null;
}

/** Connects to the tab and finds the form; lets go of the tab if that fails. */
export async function attachTab(
  tabId: number,
  attach: (page: Page) => Promise<FormDriver | null>,
): Promise<Attached> {
  const browser = await connect({
    transport: await ExtensionTransport.connectTab(tabId),
    defaultViewport: null,
  });
  try {
    const [page] = await browser.pages();
    return { browser, page, driver: page ? await attach(page) : null };
  } catch (error) {
    await release(browser, tabId);
    throw error;
  }
}

/** Only the job's own site and Greenhouse; anything else pauses the run. */
export function allowedHost(host: string, startHost: string): boolean {
  return (
    host === startHost ||
    host === "greenhouse.io" ||
    host.endsWith(".greenhouse.io")
  );
}
