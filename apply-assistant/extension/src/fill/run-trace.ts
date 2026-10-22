import type {
  ConsoleMessage,
  Frame,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { captureDom, MAX_DOM_CHARS } from "../trace/dom";
import type { Capture, TraceRecorder } from "../trace/recorder";
import type { RunEvent, Step } from "./supervisor";
import type { FormDriver } from "./trusted";

/**
 * What a supervised run adds to the trace besides its steps: the page's navigations, console
 * errors and failed requests, and snapshots (form DOM + screenshot) at the moments that matter.
 */

/** Per run, so a noisy page can't flood the trace. */
const MAX_PAGE_EVENTS = 60;
const IGNORED_TYPES = new Set(["image", "font", "media", "stylesheet", "ping"]);
const API_TYPES = new Set(["xhr", "fetch", "document"]);

/** Address without query or fragment (they can carry tokens). */
export function plainUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 200);
  }
}

/** Listens to the page for the run's trace; returns a function that stops listening. */
export function watchPage(page: Page, recorder: TraceRecorder): () => void {
  let count = 0;
  const pageEvent = (kind: string, message: string, data: unknown) => {
    if (count >= MAX_PAGE_EVENTS) return;
    count += 1;
    recorder.event(kind, message, { source: "page", data });
    if (count === MAX_PAGE_EVENTS)
      recorder.event(
        "trace-problem",
        `Page events capped at ${MAX_PAGE_EVENTS} for this run`,
      );
  };
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame())
      recorder.event("navigation", `Page is now ${plainUrl(frame.url())}`, {
        source: "page",
      });
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    pageEvent("console-error", message.text().slice(0, 500), {
      at: plainUrl(message.location().url ?? ""),
    });
  };
  const onRequestFailed = (request: HTTPRequest) => {
    const reason = request.failure()?.errorText ?? "failed";
    if (
      IGNORED_TYPES.has(request.resourceType()) ||
      reason === "net::ERR_ABORTED"
    )
      return;
    pageEvent(
      "request-failed",
      `${request.method()} ${plainUrl(request.url())}: ${reason}`,
      {
        type: request.resourceType(),
      },
    );
  };
  const onResponse = (response: HTTPResponse) => {
    const request = response.request();
    if (response.status() < 400 || !API_TYPES.has(request.resourceType()))
      return;
    pageEvent(
      "http-error",
      `${request.method()} ${plainUrl(response.url())} → ${response.status()}`,
      { status: response.status(), type: request.resourceType() },
    );
  };
  page.on("framenavigated", onNavigated);
  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  return () => {
    page.off("framenavigated", onNavigated);
    page.off("console", onConsole);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  };
}

/** Form DOM (from the driver's frame when there is one) plus a JPEG of the tab. */
export function pageCapture(page: Page, driver: FormDriver | null) {
  return async (): Promise<Capture> => {
    const dom = await (driver
      ? driver.dom()
      : page.mainFrame().evaluate(captureDom, MAX_DOM_CHARS)
    ).catch(() => null);
    const screenshot = await page
      .screenshot({ type: "jpeg", quality: 55, encoding: "base64" })
      .catch(() => null);
    return {
      html: dom?.html ?? null,
      url: dom?.url ?? page.url(),
      screenshot: typeof screenshot === "string" ? screenshot : null,
    };
  };
}

const VERB: Partial<Record<RunEvent["type"], string>> = {
  approve: "approved",
  "approve-remaining-auto": "approved all remaining automatic steps from",
  edit: "edited",
  skip: "skipped",
  "i-did-it": "filled it yourself on",
  "let-claude": "asked Claude to work",
  pause: "paused at",
  resume: "resumed at",
  abort: "stopped the run at",
};

/** Your decisions from the side panel, as trace events (null for internal events). */
export function decisionEvent(
  event: RunEvent,
  step: Step | undefined,
): { message: string; data: unknown; stepSeq?: number } | null {
  const verb = VERB[event.type];
  if (!verb) return null;
  const where = step ? `step ${step.seq} (${step.entry.label})` : "review";
  return {
    message: `You ${verb} ${where}`,
    // What the plan proposed, so the Progress page can tell a real change from a re-confirm.
    data: step
      ? {
          ...event,
          planned: step.value,
          actionClass: step.entry.actionClass,
          source: step.entry.source,
        }
      : event,
    ...(step ? { stepSeq: step.seq } : {}),
  };
}
