import type { CaptureReport } from "../capture/tracker";
import type { CaptureOutcome } from "./api";
import type { RunSummary } from "./worker";

/** What the extension keeps in chrome.storage.local (this browser only). */
export interface Settings {
  readonly serverUrl: string;
  readonly token: string | null;
  readonly username: string | null;
}

export const DEFAULT_SERVER = "https://apply.hueint.com";

export async function loadSettings(): Promise<Settings> {
  const { serverUrl, token, username } = await chrome.storage.local.get([
    "serverUrl",
    "token",
    "username",
  ]);
  return {
    serverUrl:
      typeof serverUrl === "string" && serverUrl ? serverUrl : DEFAULT_SERVER,
    token: typeof token === "string" ? token : null,
    username: typeof username === "string" ? username : null,
  };
}

export const saveSettings = (patch: Partial<Settings>) =>
  chrome.storage.local.set(patch);

export async function loadFailures(): Promise<Map<string, number>> {
  const { failures } = await chrome.storage.local.get("failures");
  return new Map(
    Object.entries((failures as Record<string, number> | undefined) ?? {}),
  );
}

export const saveFailures = (failures: Map<string, number>) =>
  chrome.storage.local.set({ failures: Object.fromEntries(failures) });

export async function loadLastRun(): Promise<RunSummary | null> {
  const { lastRun } = await chrome.storage.local.get("lastRun");
  return (lastRun as RunSummary | undefined) ?? null;
}

export const saveLastRun = (lastRun: RunSummary) =>
  chrome.storage.local.set({ lastRun });

/** Recent LinkedIn apply-link captures, newest first (shown in the side panel). */
export interface CaptureEntry {
  readonly at: string;
  readonly report: CaptureReport;
  readonly outcome:
    | CaptureOutcome
    | { readonly status: "error"; readonly reason: string };
}

const MAX_CAPTURES = 10;

export async function loadCaptures(): Promise<CaptureEntry[]> {
  const { captures } = await chrome.storage.local.get("captures");
  return Array.isArray(captures) ? (captures as CaptureEntry[]) : [];
}

export async function addCapture(entry: CaptureEntry): Promise<void> {
  const captures = await loadCaptures();
  await chrome.storage.local.set({
    captures: [entry, ...captures].slice(0, MAX_CAPTURES),
  });
}
