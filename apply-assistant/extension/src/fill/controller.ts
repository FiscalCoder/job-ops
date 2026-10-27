import {
  type Browser,
  connect,
  ExtensionTransport,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { ApplyClient, QueueItem } from "../lib/api";
import { pageKey } from "../lib/tab-match";
import { errorText, TraceRecorder } from "../trace/recorder";
import { setSupervised, trackTab } from "../track/tabs";
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
import {
  type FillOutcome,
  type FormDriver,
  type ResumeFile,
  sleep,
  TrustedDriver,
} from "./trusted";
import { GenericDriver } from "./generic-driver";
import { labelKey, recipeHost, type SiteHelp } from "./site-help";
import {
  type Chooser,
  type EntriesToAdd,
  WorkdayDriver,
} from "./workday-driver";

/** A form filled page by page as you reach each page: Workday, or any company's own site. */
type PagedDriver = WorkdayDriver | GenericDriver;
const isPaged = (driver: FormDriver): driver is PagedDriver =>
  driver instanceof WorkdayDriver || driver instanceof GenericDriver;

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
  /**
   * Filled page by page (Workday, any company's site): the page being filled, whether it's the
   * last (Workday's Review), and which kind of site.
   */
  readonly page: {
    readonly step: string;
    readonly last: boolean;
    readonly system: "workday" | "generic";
  } | null;
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

/**
 * The tab to fill: a new one on the form, or the tab you're on (moved to the form only when
 * it shows something else, so nothing you already typed there is reloaded away).
 */
async function openForm(url: string, tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId === undefined) {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id !== undefined) await waitForTabLoad(tab.id);
    return tab;
  }
  const current = await chrome.tabs.get(tabId);
  if (current.url && pageKey(current.url) === pageKey(url)) {
    if (current.status !== "complete") await waitForTabLoad(tabId);
    return (await chrome.tabs.update(tabId, { active: true })) ?? current;
  }
  const loading = waitForTabLoad(tabId);
  const moved = await chrome.tabs.update(tabId, { url, active: true });
  await loading;
  return moved ?? current;
}

/**
 * Lets go of the form's tab. Puppeteer detaches Chrome's debugger without handling errors, so
 * on a tab you already closed it logged "No tab with given id"; Chrome detaches by itself then.
 */
async function release(browser: Browser, tabId: number): Promise<void> {
  await setSupervised(tabId, false);
  const open = await chrome.tabs.get(tabId).then(
    () => true,
    () => false,
  );
  if (open) await browser.disconnect().catch(() => {});
}

interface StartOptions {
  readonly client: ApplyClient;
  readonly job: QueueItem;
  readonly countdownSeconds: number;
  readonly onChange: (view: RunView) => void;
}

/** Records why the run couldn't start (with a snapshot when a page is open). */
async function failStart(
  trace: TraceRecorder,
  message: string,
  context: Record<string, string>,
  page?: Page,
): Promise<Error> {
  trace.event("error", message, { data: context });
  if (page) await trace.snapshot("couldn't start", pageCapture(page, null));
  await trace.close();
  return new Error(message);
}

/** Workday's last page: nothing to fill, you check everything and submit. */
const FINAL_STEP = /^review$/i;
/** Workday swaps a page's content in place: give the new one a moment to finish. */
const PAGE_SETTLE_MS = 1_500;

/** The server's plan for the page on screen (none on Workday's final Review page). */
async function planPagedPage(
  client: ApplyClient,
  jobId: string,
  driver: PagedDriver,
): Promise<PlanEntry[]> {
  if (driver.system === "workday" && FINAL_STEP.test(await driver.step()))
    return [];
  type PagePlan = { entries: PlanEntry[]; add?: EntriesToAdd[] };
  const plan = (await client.planPage(
    jobId,
    await driver.readPage(),
  )) as PagePlan;
  if (!plan.add?.length) return plan.entries;
  // My Experience: one entry per job and degree on your resume, then the page is planned again.
  await driver.addEntries(plan.add);
  const again = (await client.planPage(
    jobId,
    await driver.readPage(),
  )) as PagePlan;
  return again.entries;
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
  /** Workday: the wizard step the current steps belong to. */
  private pageStep = "";
  private readonly stopWatching: () => void;

  private constructor(
    private readonly client: ApplyClient,
    private readonly job: QueueItem,
    private readonly runId: string,
    private readonly browser: Browser,
    private readonly driver: FormDriver,
    private readonly startHost: string,
    private readonly tabId: number,
    entries: readonly PlanEntry[],
    runOptions: { countdownSeconds: number; resumeFirst: boolean },
    private readonly onChange: (view: RunView) => void,
    private readonly trace: TraceRecorder,
    private readonly page: Page,
  ) {
    this.state = startRun(entries, runOptions);
    this.stopWatching = watchPage(page, trace);
    chrome.tabs.onRemoved.addListener(this.onTabRemoved);
  }

  private snapshot(reason: string): Promise<void> {
    return this.trace.snapshot(reason, pageCapture(this.page, this.driver));
  }

  static async start(
    options: StartOptions & {
      /** Fill this already-open tab (moved to the form first if needed) instead of a new one. */
      tabId?: number;
    },
  ): Promise<RunController> {
    const { client, job } = options;
    const posting = job.target.postingUrl;
    const ats = job.target.ats ?? "greenhouse";
    if (!posting) throw new Error("This job has no posting to apply on");
    const url = formUrlFor(ats, posting);
    const trace = new TraceRecorder(client, job.jobId);
    const context = { url, ats };
    trace.event("run-starting", `Opening the ${ats} form: ${url}`, {
      data: context,
    });
    let entries: PlanEntry[];
    try {
      ({ entries } = (await client.plan(job.jobId)) as {
        entries: PlanEntry[];
      });
    } catch (error) {
      throw await failStart(
        trace,
        `Couldn't load the plan: ${errorText(error)}`,
        context,
      );
    }
    let tab: chrome.tabs.Tab;
    try {
      tab = await openForm(url, options.tabId);
    } catch (error) {
      throw await failStart(trace, errorText(error), context);
    }
    if (tab.id === undefined)
      throw await failStart(trace, "Couldn't open the posting", context);
    return RunController.launch({
      ...options,
      trace,
      context,
      tabId: tab.id,
      attach: (page) => attachDriver(ats, page),
      plan: async () => entries,
      resumeFirst: resumeFirst(ats),
    });
  }

  /**
   * Fills the application in the tab you're on (Workday after you sign in, or any company's own
   * page), one page at a time: each page is planned when it opens, and you continue yourself.
   */
  static async startPaged(
    options: StartOptions & { tabId: number; system: "workday" | "generic" },
  ): Promise<RunController> {
    const { client, job, tabId, system } = options;
    const url = (await chrome.tabs.get(tabId)).url ?? "";
    const trace = new TraceRecorder(client, job.jobId);
    const context = { url, ats: system };
    trace.event(
      "run-starting",
      `Filling the ${system === "workday" ? "Workday application" : "application on the company's site"}: ${url}`,
      { data: context },
    );
    await chrome.tabs.update(tabId, { active: true });
    const chooser: Chooser = async (label, wanted, choices) => {
      const answer = await client
        .choose(job.jobId, { label, wanted, options: choices })
        .catch(() => null);
      const value = answer?.value;
      return (typeof value === "string" ? value : value?.[0]) ?? null;
    };
    return RunController.launch({
      ...options,
      trace,
      context,
      attach: async (page) => {
        if (system === "workday") {
          const driver = await WorkdayDriver.attach(page);
          if (driver) {
            driver.chooser = chooser;
            driver.searchTerms = async (label, wanted) =>
              (await client.searchTerms(job.jobId, { label, wanted })).terms;
          }
          return driver;
        }
        const driver = await GenericDriver.attach(page);
        if (driver) driver.chooser = chooser;
        return driver;
      },
      plan: (driver) => planPagedPage(client, job.jobId, driver as PagedDriver),
      // Workday fills My Experience from the resume, so it goes before anything typed.
      resumeFirst: true,
    });
  }

  /** Attaches to the form's tab, plans, starts the run on the server, and begins filling. */
  private static async launch(options: {
    client: ApplyClient;
    job: QueueItem;
    countdownSeconds: number;
    onChange: (view: RunView) => void;
    trace: TraceRecorder;
    context: Record<string, string>;
    tabId: number;
    attach: (page: Page) => Promise<FormDriver | null>;
    plan: (driver: FormDriver) => Promise<PlanEntry[]>;
    resumeFirst: boolean;
  }): Promise<RunController> {
    const { client, job, trace, context, tabId } = options;
    await trackTab(tabId, job.jobId);
    // The run records this tab itself; manual-application recording stays out of it.
    await setSupervised(tabId, true);
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(tabId),
      defaultViewport: null,
    });
    const [page] = await browser.pages();
    const driver = page ? await options.attach(page) : null;
    // Any system: this site's saved steps and Claude, for fields the driver can't fill itself.
    if (page && driver instanceof TrustedDriver)
      driver.help = await siteHelp(client, job.jobId, recipeHost(page.url()));
    if (!page || !driver) {
      const error = await failStart(
        trace,
        "No application form on the page (it may have closed)",
        context,
        page,
      );
      await release(browser, tabId);
      throw error;
    }
    let entries: PlanEntry[];
    let run: { id: string };
    try {
      entries = await options.plan(driver);
      run = await client.startRun(job.jobId);
    } catch (error) {
      const refused = await failStart(
        trace,
        `Couldn't start the run: ${errorText(error)}`,
        context,
        page,
      );
      await release(browser, tabId);
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
      tabId,
      entries,
      {
        countdownSeconds: options.countdownSeconds,
        resumeFirst: options.resumeFirst,
      },
      options.onChange,
      trace,
      page,
    );
    if (isPaged(driver)) controller.pageStep = await driver.step();
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
      page: this.wizard
        ? {
            step: this.pageStep,
            last:
              this.wizard.system === "workday" &&
              FINAL_STEP.test(this.pageStep),
            system: this.wizard.system,
          }
        : null,
    };
  }

  private get wizard(): PagedDriver | null {
    return isPaged(this.driver) ? this.driver : null;
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
      if (learnable(step)) await this.remember(step);
    }
  }

  /** Your answer to a form question, kept for the next form that asks it. */
  private async remember(step: Step) {
    const typed = step.decision === "you-did-it";
    const value = typed
      ? (await this.driver.readBack(step.entry).catch(() => "")).trim()
      : step.value;
    if (!value || (Array.isArray(value) && value.length === 0)) return;
    await this.client
      .learn({
        jobId: this.job.jobId,
        label: step.entry.label,
        type: step.entry.type,
        value,
        how: typed ? "typed" : "edited",
      })
      .catch((error: unknown) =>
        this.trace.event(
          "error",
          `Couldn't remember your answer to step ${step.seq}: ${errorText(error)}`,
          { stepSeq: step.seq },
        ),
      );
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
        if (this.wizard)
          this.timer = setTimeout(() => void this.watchPage(), REVIEW_POLL_MS);
        return;
      case "fill":
        return this.fill(action.step);
      case "review":
        await this.driver.highlight(
          null,
          this.wizard?.system === "generic"
            ? "Apply Copilot: check this page, then continue or submit yourself"
            : this.morePages()
              ? "Apply Copilot: check this page, then click Save and Continue"
              : "Apply Copilot: review the form, then click Submit yourself",
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
              : this.morePages()
                ? `Page "${this.pageStep}" done: waiting for you to click Save and Continue`
                : "At review: waiting for you to click Submit",
            { data: { problems: this.problems, page: this.pageStep } },
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

  /** Page by page, before Workday's final page: you continue to the next page yourself. */
  private morePages(): boolean {
    const wizard = this.wizard;
    if (!wizard) return false;
    return wizard.system === "generic" || !FINAL_STEP.test(this.pageStep);
  }

  /** Workday moved to another page: the step you're on now, when it changed. */
  private async movedTo(): Promise<string | null> {
    const wizard = this.wizard;
    const step = (await wizard?.step()) ?? "";
    if (step && step !== this.pageStep) return step;
    // Some sites swap in the next part in place, with the same address and heading.
    if (wizard instanceof GenericDriver && (await wizard.swapped()))
      return step || this.pageStep || "this page";
    return null;
  }

  /** "Fill this page": read the page on screen again and fill it (when it moved unnoticed). */
  refillPage(): void {
    const wizard = this.wizard;
    if (!wizard || this.busy || this.closed || this.tabClosed) return;
    this.clearTimer();
    this.trace.event("decision", "You asked to fill the page on screen");
    void (async () =>
      this.nextPage((await wizard.step()) || this.pageStep || "this page"))();
  }

  /** While a step waits for you on Workday: you may have filled the rest and moved on. */
  private async watchPage(): Promise<void> {
    if (
      this.tabClosed ||
      this.busy ||
      nextAction(this.state).kind !== "wait-for-you"
    )
      return;
    const moved = await this.movedTo();
    if (moved) return this.nextPage(moved);
    this.timer = setTimeout(() => void this.watchPage(), REVIEW_POLL_MS);
  }

  /** You clicked Save and Continue (or Back): plan the page now on screen and fill it. */
  private async nextPage(step: string): Promise<void> {
    const wizard = this.wizard;
    if (!wizard || this.closed) return;
    this.clearTimer();
    this.busy = true;
    this.notice = null;
    this.problems = [];
    this.pageStep = step;
    this.reviewTraced = false;
    this.emit();
    await this.logFinishedSteps();
    const firstSeq = Math.max(0, ...this.state.steps.map((s) => s.seq)) + 1;
    const begin = (entries: readonly PlanEntry[]) => ({
      ...startRun(entries, {
        countdownSeconds: this.state.countdownSeconds,
        resumeFirst: true,
        firstSeq,
      }),
      autoApproved: this.state.autoApproved,
    });
    try {
      await sleep(PAGE_SETTLE_MS);
      const entries = await planPagedPage(this.client, this.job.jobId, wizard);
      this.state = begin(entries);
      this.trace.event(
        "page",
        `On ${wizard.system === "workday" ? "Workday page" : "page"} "${step}" with ${entries.length} plan entries`,
        { data: { step, entries: entries.length } },
      );
      void this.snapshot(`page: ${step}`);
    } catch (error) {
      this.notice = `Couldn't plan the "${step}" page (${errorText(error)}): fill it yourself, then continue.`;
      this.trace.event("error", this.notice, { data: { step } });
      this.state = begin([]);
    } finally {
      this.busy = false;
    }
    void this.loop();
  }

  private currentSeq() {
    return this.state.steps[this.state.cursor]?.seq;
  }

  private async mark(step: Step, what: string) {
    const position = this.state.steps.indexOf(step) + 1;
    await this.driver.highlight(
      step.entry.ref,
      `Apply Copilot ${position}/${this.state.steps.length} · ${what}`,
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

  private tabClosed = false;

  /** The form's tab closed mid-run: nothing more can be filled; you say how it ended. */
  private readonly onTabRemoved = (tabId: number) => {
    if (tabId !== this.tabId || this.closed) return;
    this.tabClosed = true;
    this.clearTimer();
    this.trace.event("error", "The form's tab was closed during the run");
    this.notice = `The form's tab was closed. If you submitted, click "I submitted it"; otherwise Abort.`;
    if (this.state.phase === "filling") this.apply({ type: "pause" });
    this.emit();
  };

  private async fill(step: Step) {
    if (this.tabClosed) return;
    // You moved on before this page was finished: work on the page you're on.
    const moved = await this.movedTo();
    if (moved) return this.nextPage(moved);
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
      let outcome = step.operate
        ? await this.operate(step)
        : await this.driver.fill(
            step.entry,
            step.value,
            this.resume ?? undefined,
          );
      // Not filled the usual way: this site's saved steps, then Claude's.
      if (!outcome.ok && !step.operate)
        outcome =
          (await this.driver
            .rescue?.(step.entry, step.value, outcome.reason)
            .catch(() => null)) ?? outcome;
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

  /** "Let Claude do it": Claude works the field on the page; Pause or Abort stops it. */
  private operate(step: Step): Promise<FillOutcome> {
    if (!this.driver.operate)
      return Promise.resolve({
        ok: false,
        reason: "Claude can't work this form",
      });
    const jobId = this.job.jobId;
    return this.driver.operate(
      step.entry,
      step.value,
      step.note ?? step.result ?? "",
      {
        turn: (body) => this.client.operate(jobId, body),
        stop: async (session) => {
          await this.client.stopOperate(jobId, session);
        },
      },
      () => this.state.paused || this.closed || this.tabClosed,
    );
  }

  private async checkSubmitted() {
    if (this.tabClosed || nextAction(this.state).kind !== "review") return;
    // The confirmation page first: after you submit, it's a new page that isn't a form.
    if (await this.driver.submitted()) {
      this.apply({ type: "submitted" });
      void this.loop();
      return;
    }
    const moved = await this.movedTo();
    if (moved) return this.nextPage(moved);
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
    // The whole trail reaches the server before the run is marked finished there.
    await this.trace.flush();
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
    chrome.tabs.onRemoved.removeListener(this.onTabRemoved);
    await this.trace.close();
    await this.driver
      .highlight(
        null,
        outcome === "submitted"
          ? "Apply Copilot: applied ✓"
          : "Apply Copilot: stopped",
      )
      .catch(() => {});
    await release(this.browser, this.tabId);
    this.onChange(this.view());
  }

  /** The side panel is closing: stop without submitting anything. */
  async stop(): Promise<void> {
    if (!this.closed) this.dispatch({ type: "abort" });
  }
}

/** Answers from the bank, your resume or Job Ops are fixed at their source, not learned. */
const FIXED_SOURCE = /^(bank:|resume:|jobops:|rule:)/;

/** Your edit or own answer to a form question, worth reusing on the next form. */
export function learnable(step: Step): boolean {
  const { entry } = step;
  const yours =
    (step.decision === "edited" && step.state === "done") ||
    step.decision === "you-did-it";
  return (
    yours &&
    entry.type !== "file" &&
    entry.actionClass !== "protected" &&
    entry.section !== "demographic" &&
    entry.section !== "compliance" &&
    !FIXED_SOURCE.test(entry.source)
  );
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

/** This site's saved steps and Claude, for fields a driver can't fill by itself. */
async function siteHelp(
  client: ApplyClient,
  jobId: string,
  host: string,
): Promise<SiteHelp> {
  const saved = await client.recipes(host).catch(() => []);
  const recipes = new Map(saved.map((r) => [r.labelKey, r]));
  return {
    recipes,
    act: async (ask) => (await client.act(jobId, ask)).steps,
    record: async (label, steps, ok) => {
      await client.recordRecipe({ host, label, steps, ok, jobId });
      const key = labelKey(label);
      const before = recipes.get(key);
      recipes.set(key, {
        labelKey: key,
        steps: ok ? steps : (before?.steps ?? steps),
        worked: (before?.worked ?? 0) + (ok ? 1 : 0),
        failed: (before?.failed ?? 0) + (ok ? 0 : 1),
      });
    },
  };
}
