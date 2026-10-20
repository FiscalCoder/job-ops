import {
  type Browser,
  connect,
  ExtensionTransport,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { ApplyClient, QueueItem } from "../lib/api";
import { errorText, TraceRecorder } from "../trace/recorder";
import { attachDriver, formUrlFor, resumeFirst } from "./drivers";
import { decisionEvent, pageCapture, watchPage } from "./run-trace";
import {
  maskValue,
  type NextAction,
  nextAction,
  type PlanEntry,
  type RunEvent,
  type RunState,
  reduce,
  type Step,
  startRun,
} from "./supervisor";
import type { FormDriver, ResumeFile } from "./trusted";

/**
 * Runs one supervised application from the side panel: opens the posting, drives the
 * supervisor, fills through the driver, logs every finished step to the server, and stops at
 * review for you to click Submit. Lives in the side panel, so closing the panel stops the run.
 */

export interface RunView {
  readonly job: QueueItem;
  readonly state: RunState;
  readonly action: NextAction;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly problems: readonly string[];
}

const REVIEW_POLL_MS = 2_000;
/** A fill still busy after this long is a stall: the trace gets a snapshot. */
const STALL_MS = 20_000;
const TAB_LOAD_TIMEOUT_MS = 30_000;
const DONE_STATES = new Set(["done", "skipped", "you-did-it"]);

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

/** Only the job's own site and Greenhouse; anything else pauses the run. */
export function allowedHost(host: string, startHost: string): boolean {
  return (
    host === startHost ||
    host === "greenhouse.io" ||
    host.endsWith(".greenhouse.io")
  );
}

export class RunController {
  private state: RunState;
  private busy = false;
  private notice: string | null = null;
  private problems: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private logged = new Set<number>();
  private resume: ResumeFile | null = null;
  private closed = false;
  private reviewTraced = false;
  private readonly stopWatching: () => void;

  private constructor(
    private readonly client: ApplyClient,
    private readonly job: QueueItem,
    private readonly runId: string,
    private readonly browser: Browser,
    private readonly driver: FormDriver,
    private readonly startHost: string,
    entries: readonly PlanEntry[],
    runOptions: { countdownSeconds: number; resumeFirst: boolean },
    private readonly onChange: (view: RunView) => void,
    private readonly trace: TraceRecorder,
    private readonly page: Page,
  ) {
    this.state = startRun(entries, runOptions);
    this.stopWatching = watchPage(page, trace);
  }

  private snapshot(reason: string): Promise<void> {
    return this.trace.snapshot(reason, pageCapture(this.page, this.driver));
  }

  static async start(options: {
    client: ApplyClient;
    job: QueueItem;
    countdownSeconds: number;
    onChange: (view: RunView) => void;
  }): Promise<RunController> {
    const { client, job } = options;
    const posting = job.target.postingUrl;
    const ats = job.target.ats ?? "greenhouse";
    if (!posting) throw new Error("This job has no posting to apply on");
    const url = formUrlFor(ats, posting);
    const trace = new TraceRecorder(client, job.jobId);
    /** Records why the run couldn't start (with a snapshot when a page is open). */
    const fail = async (message: string, page?: Page): Promise<Error> => {
      trace.event("error", message, { data: { url, ats } });
      if (page) await trace.snapshot("couldn't start", pageCapture(page, null));
      await trace.close();
      return new Error(message);
    };
    trace.event("run-starting", `Opening the ${ats} form: ${url}`, {
      data: { ats, url },
    });
    let entries: PlanEntry[];
    try {
      ({ entries } = (await client.plan(job.jobId)) as {
        entries: PlanEntry[];
      });
    } catch (error) {
      throw await fail(`Couldn't load the plan: ${errorText(error)}`);
    }
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) throw await fail("Couldn't open the posting");
    try {
      await waitForTabLoad(tab.id);
    } catch (error) {
      throw await fail(errorText(error));
    }
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(tab.id),
      defaultViewport: null,
    });
    const [page] = await browser.pages();
    const driver = page ? await attachDriver(ats, page) : null;
    if (!page || !driver) {
      const error = await fail(
        "No application form on the posting (it may have closed)",
        page,
      );
      await browser.disconnect();
      throw error;
    }
    let run: { id: string };
    try {
      run = await client.startRun(job.jobId);
    } catch (error) {
      const refused = await fail(
        `The server refused the run: ${errorText(error)}`,
        page,
      );
      await browser.disconnect();
      throw refused;
    }
    trace.setRun(run.id);
    trace.event(
      "run-started",
      `Run started on ${page.url()} with ${entries.length} plan entries`,
      {
        data: {
          url: page.url(),
          entries: entries.length,
          countdownSeconds: options.countdownSeconds,
        },
      },
    );
    const controller = new RunController(
      client,
      job,
      run.id,
      browser,
      driver,
      new URL(page.url()).host,
      entries,
      {
        countdownSeconds: options.countdownSeconds,
        resumeFirst: resumeFirst(ats),
      },
      options.onChange,
      trace,
      page,
    );
    void controller.snapshot("start");
    void controller.loop();
    return controller;
  }

  view(): RunView {
    return {
      job: this.job,
      state: this.state,
      action: nextAction(this.state),
      busy: this.busy,
      notice: this.notice,
      problems: this.problems,
    };
  }

  /** Your controls from the side panel. */
  dispatch(event: RunEvent): void {
    if (this.busy && event.type !== "pause" && event.type !== "abort") return;
    const decision = decisionEvent(
      event,
      this.state.phase === "filling"
        ? this.state.steps[this.state.cursor]
        : undefined,
    );
    if (decision)
      this.trace.event("decision", decision.message, {
        data: decision.data,
        ...(decision.stepSeq ? { stepSeq: decision.stepSeq } : {}),
      });
    this.apply(event);
    void this.loop();
  }

  private apply(event: RunEvent) {
    this.state = reduce(this.state, event);
    void this.logFinishedSteps();
  }

  private async logFinishedSteps() {
    const finished = this.state.steps.filter(
      (s) => DONE_STATES.has(s.state) && !this.logged.has(s.seq),
    );
    for (const step of finished) {
      this.logged.add(step.seq);
      await this.client
        .logAction(this.runId, toLogEntry(step))
        .catch((error: unknown) => {
          this.notice =
            "Couldn't save a step to the run log (the fill continues)";
          this.trace.event(
            "error",
            `Couldn't log step ${step.seq}: ${errorText(error)}`,
            { stepSeq: step.seq },
          );
        });
    }
  }

  private emit() {
    if (!this.closed) this.onChange(this.view());
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    this.clearTimer();
    const action = nextAction(this.state);
    this.emit();
    switch (action.kind) {
      case "countdown": {
        await this.mark(
          action.step,
          `${action.seconds}s · ${action.step.entry.source}`,
        );
        const seq = action.step.seq;
        this.timer = setTimeout(() => {
          if (
            nextAction(this.state).kind === "countdown" &&
            this.currentSeq() === seq
          ) {
            this.apply({ type: "countdown-finished" });
            void this.loop();
          }
        }, action.seconds * 1000);
        return;
      }
      case "wait-for-you":
        await this.mark(
          action.step,
          action.step.note ? "needs you" : "waiting for your click",
        );
        return;
      case "fill":
        return this.fill(action.step);
      case "review":
        await this.driver.highlight(
          null,
          "Apply Copilot: review the form, then click Submit yourself",
        );
        this.problems = [
          ...(await this.driver.problems()),
          ...(await this.emptiedFields()),
        ];
        if (!this.reviewTraced) {
          this.reviewTraced = true;
          this.trace.event(
            "review",
            this.problems.length
              ? `At review with ${this.problems.length} problem(s)`
              : "At review: waiting for you to click Submit",
            { data: { problems: this.problems } },
          );
          void this.snapshot("review");
        }
        this.emit();
        this.timer = setTimeout(
          () => void this.checkSubmitted(),
          REVIEW_POLL_MS,
        );
        return;
      case "finished":
        return this.finish();
      case "paused":
        return;
    }
  }

  /** Fields filled earlier that are empty again (a re-render or another field reset them). */
  private async emptiedFields(): Promise<string[]> {
    const filled = this.state.steps.filter(
      (s) => s.state === "done" && s.entry.type !== "file",
    );
    const empty: string[] = [];
    for (const step of filled)
      if (!(await this.driver.readBack(step.entry)).trim())
        empty.push(`${step.entry.label} is empty again: check it on the page`);
    return empty;
  }

  private currentSeq() {
    return this.state.steps[this.state.cursor]?.seq;
  }

  private async mark(step: Step, what: string) {
    await this.driver.highlight(
      step.entry.ref,
      `Apply Copilot ${step.seq}/${this.state.steps.length} · ${what}`,
    );
  }

  private async onAllowedSite(): Promise<boolean> {
    const [page] = await this.browser.pages();
    const host = page ? new URL(page.url()).host : "";
    return allowedHost(host, this.startHost);
  }

  /** A failed step: what the field shows now, and a snapshot of the page. */
  private async traceFailure(step: Step, reason: string) {
    const shown = await this.driver.readBack(step.entry).catch(() => null);
    this.trace.event("step-failed", `${step.entry.label}: ${reason}`, {
      stepSeq: step.seq,
      data: { reason, shown, wanted: step.value, problems: this.problems },
    });
    void this.snapshot(`step ${step.seq} failed: ${step.entry.label}`);
  }

  private async fill(step: Step) {
    let stall: ReturnType<typeof setTimeout> | null = null;
    this.busy = true;
    this.emit();
    try {
      if (!(await this.onAllowedSite())) {
        this.notice = "The tab left the job's site, so the run is paused.";
        this.trace.event(
          "error",
          `The tab left the job's site (now ${this.page.url()}); run paused`,
          { stepSeq: step.seq },
        );
        this.apply({ type: "fill-failed", reason: "Tab left the job's site" });
        this.apply({ type: "pause" });
        return;
      }
      await this.mark(step, "filling");
      this.trace.event("step-start", `Filling ${step.entry.label}`, {
        stepSeq: step.seq,
        data: {
          ref: step.entry.ref,
          type: step.entry.type,
          source: step.entry.source,
          value: step.value,
          attempt: (step.attempts ?? 0) + 1,
        },
      });
      stall = setTimeout(() => {
        this.trace.event(
          "stall",
          `Still filling ${step.entry.label} after ${STALL_MS / 1000}s`,
          { stepSeq: step.seq },
        );
        void this.snapshot(`stall at step ${step.seq}`);
      }, STALL_MS);
      if (step.entry.type === "file" && !this.resume)
        this.resume = await this.client.resumePdf(this.job.jobId);
      const outcome = await this.driver.fill(
        step.entry,
        step.value,
        this.resume ?? undefined,
      );
      this.problems = await this.driver.problems();
      if (outcome.ok)
        this.trace.event(
          "step-filled",
          `${step.entry.label}: ${outcome.result}`,
          {
            stepSeq: step.seq,
            ...(this.problems.length
              ? { data: { problems: this.problems } }
              : {}),
          },
        );
      else await this.traceFailure(step, outcome.reason);
      this.apply(
        outcome.ok
          ? { type: "filled", result: outcome.result }
          : { type: "fill-failed", reason: outcome.reason },
      );
    } catch (error) {
      await this.traceFailure(step, errorText(error));
      this.apply({ type: "fill-failed", reason: errorText(error) });
    } finally {
      if (stall) clearTimeout(stall);
      this.busy = false;
    }
    void this.loop();
  }

  private async checkSubmitted() {
    if (nextAction(this.state).kind !== "review") return;
    if (await this.driver.submitted()) {
      this.apply({ type: "submitted" });
      void this.loop();
      return;
    }
    this.timer = setTimeout(() => void this.checkSubmitted(), REVIEW_POLL_MS);
  }

  private async finish() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const outcome = this.state.outcome ?? "aborted";
    this.trace.event(
      "run-ended",
      outcome === "submitted"
        ? "You submitted the application"
        : "Run stopped; nothing was submitted",
      { data: { outcome } },
    );
    await this.snapshot(outcome === "submitted" ? "submitted" : "stopped");
    try {
      await this.logFinishedSteps();
      await this.client.completeRun(this.runId, outcome);
      this.notice =
        outcome === "submitted"
          ? "Marked as applied in Job Ops."
          : "Run stopped. Nothing was submitted.";
    } catch (error) {
      this.notice = `Couldn't record the end of the run: ${errorText(error)}`;
      this.trace.event("error", this.notice);
    }
    this.stopWatching();
    await this.trace.close();
    await this.driver
      .highlight(
        null,
        outcome === "submitted"
          ? "Apply Copilot: applied ✓"
          : "Apply Copilot: stopped",
      )
      .catch(() => {});
    await this.browser.disconnect().catch(() => {});
    this.onChange(this.view());
  }

  /** The side panel is closing: stop without submitting anything. */
  async stop(): Promise<void> {
    if (!this.closed) this.dispatch({ type: "abort" });
  }
}

function toLogEntry(step: Step) {
  return {
    seq: step.seq,
    actionClass: step.entry.actionClass,
    fieldRef: step.entry.ref,
    valueMasked: maskValue(step.value),
    source: step.entry.source,
    decision: step.decision ?? "approved",
    decidedBy: step.decidedBy ?? "you",
    result: step.result ?? step.state,
  };
}
