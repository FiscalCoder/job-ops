import {
  type Browser,
  connect,
  ExtensionTransport,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { ApplyClient, QueueItem } from "../lib/api";
import { GreenhouseDriver, type ResumeFile } from "./driver";
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

  private constructor(
    private readonly client: ApplyClient,
    private readonly job: QueueItem,
    private readonly runId: string,
    private readonly browser: Browser,
    private readonly driver: GreenhouseDriver,
    private readonly startHost: string,
    entries: readonly PlanEntry[],
    countdownSeconds: number,
    private readonly onChange: (view: RunView) => void,
  ) {
    this.state = startRun(entries, { countdownSeconds });
  }

  static async start(options: {
    client: ApplyClient;
    job: QueueItem;
    countdownSeconds: number;
    onChange: (view: RunView) => void;
  }): Promise<RunController> {
    const { client, job } = options;
    const url = job.greenhouse.ghUrl;
    if (!url) throw new Error("This job has no Greenhouse posting");
    const plan = (await client.plan(job.jobId)) as { entries: PlanEntry[] };
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) throw new Error("Couldn't open the posting");
    await waitForTabLoad(tab.id);
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(tab.id),
      defaultViewport: null,
    });
    const [page] = await browser.pages();
    const driver = page ? await GreenhouseDriver.attach(page) : null;
    if (!page || !driver) {
      await browser.disconnect();
      throw new Error(
        "No application form on the posting (it may have closed)",
      );
    }
    const run = await client.startRun(job.jobId);
    const controller = new RunController(
      client,
      job,
      run.id,
      browser,
      driver,
      new URL(page.url()).host,
      plan.entries,
      options.countdownSeconds,
      options.onChange,
    );
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
      await this.client.logAction(this.runId, toLogEntry(step)).catch(() => {
        this.notice =
          "Couldn't save a step to the run log (the fill continues)";
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

  private async fill(step: Step) {
    this.busy = true;
    this.emit();
    try {
      if (!(await this.onAllowedSite())) {
        this.notice = "The tab left the job's site, so the run is paused.";
        this.apply({ type: "fill-failed", reason: "Tab left the job's site" });
        this.apply({ type: "pause" });
        return;
      }
      await this.mark(step, "filling");
      if (step.entry.type === "file" && !this.resume)
        this.resume = await this.client.resumePdf(this.job.jobId);
      const outcome = await this.driver.fill(
        step.entry,
        step.value,
        this.resume ?? undefined,
      );
      this.problems = await this.driver.problems();
      this.apply(
        outcome.ok
          ? { type: "filled", result: outcome.result }
          : { type: "fill-failed", reason: outcome.reason },
      );
    } catch (error) {
      this.apply({
        type: "fill-failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
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
    try {
      await this.logFinishedSteps();
      await this.client.completeRun(this.runId, outcome);
      this.notice =
        outcome === "submitted"
          ? "Marked as applied in Job Ops."
          : "Run stopped. Nothing was submitted.";
    } catch (error) {
      this.notice = `Couldn't record the end of the run: ${error instanceof Error ? error.message : String(error)}`;
    }
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
