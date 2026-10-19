import { ApplyClient } from "../src/lib/api";
import {
  loadFailures,
  loadSettings,
  saveFailures,
  saveLastRun,
} from "../src/lib/settings";
import { type RunSummary, runLookups } from "../src/lib/worker";

/** Lookups every 30 minutes while Chrome is open, and on demand from the side panel. */

const ALARM = "lookups";
const EVERY_MINUTES = 30;
const PAUSE_MS = 400;

let running: Promise<RunSummary | null> | null = null;

async function runOnce(): Promise<RunSummary | null> {
  const settings = await loadSettings();
  if (!settings.token) return null;
  const failures = await loadFailures();
  const summary = await runLookups({
    client: new ApplyClient(settings.serverUrl, settings.token),
    fetch: (...args) => fetch(...args),
    pause: () => new Promise((r) => setTimeout(r, PAUSE_MS)),
    now: () => new Date(),
    recentFailures: failures,
  });
  await saveFailures(failures);
  await saveLastRun(summary);
  return summary;
}

/** One pass at a time; a second request while running gets the same result. */
function runNow(): Promise<RunSummary | null> {
  running ??= runOnce().finally(() => {
    running = null;
  });
  return running;
}

export default defineBackground(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  chrome.alarms.create(ALARM, {
    periodInMinutes: EVERY_MINUTES,
    delayInMinutes: 1,
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void runNow();
  });
  chrome.runtime.onMessage.addListener(
    (message: { type?: string }, _sender, reply) => {
      if (message?.type !== "run-lookups") return false;
      runNow().then(reply, (error: unknown) => reply({ error: String(error) }));
      return true;
    },
  );
});
