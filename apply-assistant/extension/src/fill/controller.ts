import type {
  Browser,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { ApplyClient, QueueItem } from "../lib/api";
import { isWorkdayApply } from "../track/job-match";
import { errorText, TraceRecorder } from "../trace/recorder";
import { setSupervised, trackTab } from "../track/tabs";
import { attachDriver, formUrlFor, resumeFirst } from "./drivers";
import { GenericDriver } from "./generic-driver";
import { KeptAnswers } from "./kept-answers";
import {
  chosen,
  describeChoice,
  FINAL_STEP,
  helpPicking,
  isPaged,
  learnable,
  type Closely,
  type PageChoice,
  type PagedDriver,
  planPagedPage,
  siteHelp,
  toLogEntry,
} from "./run-page";
import {
  type Attached,
  allowedHost,
  attachTab,
  DETACHED,
  openForm,
  release,
  waitForTabSettled,
} from "./run-tab";
import { decisionEvent, pageCapture, watchPage } from "./run-trace";
import { recipeHost, unlearn } from "./site-help";
import {
  changedSince,
  type FillFrom,
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
  failed,
  type FillOutcome,
  type FormDriver,
  type ResumeFile,
  sleep,
  TrustedDriver,
} from "./trusted";
import { WorkdayDriver } from "./workday-driver";

// Kept importable from here, where they used to live.
export { allowedHost, openForm, waitForTabSettled } from "./run-tab";
export { learnable } from "./run-page";

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
  /** Filled fields worth a look before you submit ("Notice period: Claude was unsure (40%)…"). */
  readonly checks: readonly string[];
  /**
   * Filled page by page (Workday, any company's site): the page being filled, whether it's the
   * last (Workday's Review), and which kind of site.
   */
  readonly page: {
    readonly step: string;
    readonly last: boolean;
    readonly system: "workday" | "generic";
  } | null;
  /** Every field of the page's plan, in fill order ("Fix a field" picks one of them). */
  readonly fields: readonly string[];
}

/** The entries in the order a run fills them. */
const inFillOrder = (entries: readonly PlanEntry[], resumeFirst: boolean) =>
  startRun(entries, { countdownSeconds: 0, resumeFirst }).steps.map((s) => s.entry);

const REVIEW_POLL_MS = 2_000;
/** A fill still busy after this long is a stall: the trace gets a snapshot. */
const STALL_MS = 20_000;
const DONE_STATES = new Set(["done", "skipped", "you-did-it"]);

interface StartOptions {
  readonly client: ApplyClient;
  readonly job: QueueItem;
  readonly countdownSeconds: number;
  readonly onChange: (view: RunView) => void;
  /** Autopilot: a field the fill can't set goes to Claude on the page by itself, once. */
  readonly autopilot?: boolean;
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

/** Claude's operate budget for the application is used up (the server's limit messages). */
const BUDGET_SPENT = /budget|cost limit/i;
/**
 * Only you can type these: a captcha, or a code sent to your email or phone. Claude never
 * tries them, and the page isn't read closely for them.
 */
const YOURS_TO_TYPE =
  /captcha|verification code|one[- ]time (pass(word|code)?|code)|\botp\b|security code|code (we|was) sent/i;
/** The page drew the field again mid-fill (its frame or context went away): worth one retry. */
const REDRAWN =
  /cannot find context|execution context was destroyed|detached frame|node is detached|target closed/i;
const REDRAW_SETTLE_MS = 800;

/** Workday swaps a page's content in place: give the new one a moment to finish. */
const PAGE_SETTLE_MS = 1_500;

/** Claude works a field by itself at most this often: a first try, then one with its result. */
const MAX_CLAUDE_TRIES = 2;

export class RunController {
  private state: RunState;
  private busy = false;
  private notice: string | null = null;
  private problems: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private logged = new Set<number>();
  /** Claude's choices still showing as you review: remembered once you submit. */
  private readonly keptAnswers = new KeptAnswers();
  private resume: ResumeFile | null = null;
  private closed = false;

  /** The run is over (submitted, aborted or stopped); its view may still be on screen. */
  get ended(): boolean {
    return this.closed;
  }
  private reviewTraced = false;
  /** Workday: the wizard step the current steps belong to. */
  private pageStep = "";
  /** The resume upload goes first (systems that fill fields from it). */
  private readonly resumeFirst: boolean;
  /** Autopilot: unanswered fields go to Claude, drafts are approved, optional ones skipped. */
  private readonly autopilot: boolean;
  /** Pages Claude has read closely (by step): once per page, by itself or when you ask. */
  private readonly readClosely = new Set<string>();
  /** Claude's read of a generic form's page, started with it: its plan, once it's back. */
  private early: { readonly step: string; readonly entries: PlanEntry[] } | null = null;
  /** How often each step went to Claude by itself: at most MAX_CLAUDE_TRIES (no loops). */
  private readonly escalated = new Map<number, number>();
  /** Claude's budget for this application is spent: no more hand-overs. */
  private claudeSpent = false;
  /** Autopilot checked this page's filled fields once at review (redone what didn't hold). */
  private rechecked = false;
  /** The site's plan is done and the page was read for fields it doesn't cover. */
  private restRead = false;
  private readonly stopWatching: () => void;

  private constructor(
    private readonly client: ApplyClient,
    private readonly job: QueueItem,
    private readonly runId: string,
    private readonly browser: Browser,
    /** The site's driver; the generic one once the site's plan is done (the rest of the page). */
    private driver: FormDriver,
    /** The site being filled: moves with you (Fill this page) and into Workday's application. */
    private startHost: string,
    private readonly tabId: number,
    entries: readonly PlanEntry[],
    runOptions: {
      countdownSeconds: number;
      resumeFirst: boolean;
      autopilot?: boolean;
    },
    private readonly onChange: (view: RunView) => void,
    private readonly trace: TraceRecorder,
    private readonly page: Page,
  ) {
    this.state = startRun(entries, runOptions);
    this.pageEntries = this.state.steps.map((s) => s.entry);
    this.resumeFirst = runOptions.resumeFirst;
    this.autopilot = runOptions.autopilot ?? false;
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
    // Its system's driver first; no form of that kind on the page (Okta's own careers page
    // behind a Greenhouse posting): the generic reader, planning the page as it is.
    let generic = false;
    return RunController.launch({
      ...options,
      trace,
      context,
      tabId: tab.id,
      attach: async (page) => {
        const driver = await attachDriver(ats, page);
        if (driver) return driver;
        const fallback = await GenericDriver.attach(page);
        if (!fallback) return null;
        generic = true;
        helpPicking(fallback, client, job.jobId);
        trace.event(
          "fallback",
          `No ${ats} form on ${page.url()}: reading the page's own form instead`,
          { data: { ats, url: page.url() } },
        );
        return fallback;
      },
      plan: (driver) =>
        generic
          ? planPagedPage(client, job.jobId, driver as PagedDriver)
          : Promise.resolve(entries),
      // Read from the page, the resume goes first, as on any company's page.
      resumeFirst: () => generic || resumeFirst(ats),
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
    return RunController.launch({
      ...options,
      trace,
      context,
      attach: async (page) => {
        if (system === "workday") {
          const driver = await WorkdayDriver.attach(page);
          if (driver) helpPicking(driver, client, job.jobId);
          return driver;
        }
        const driver = await GenericDriver.attach(page);
        if (driver) helpPicking(driver, client, job.jobId);
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
    /** Decided once the form is attached (the driver found decides it). */
    resumeFirst: boolean | (() => boolean);
    autopilot?: boolean;
  }): Promise<RunController> {
    const { client, job, trace, context, tabId } = options;
    await trackTab(tabId, job.jobId);
    // The run records this tab itself; manual-application recording stays out of it.
    await setSupervised(tabId, true);
    let attached: Attached;
    try {
      attached = await attachTab(tabId, options.attach).catch(
        async (error: unknown) => {
          // The page moved on while being read (a redirect): read it again once it settles.
          if (!DETACHED.test(errorText(error))) throw error;
          await waitForTabSettled(tabId);
          return attachTab(tabId, options.attach);
        },
      );
    } catch (error) {
      await setSupervised(tabId, false);
      throw await failStart(
        trace,
        `Couldn't read the form: ${errorText(error)}`,
        context,
      );
    }
    const { browser, page, driver } = attached;
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
        resumeFirst:
          typeof options.resumeFirst === "function"
            ? options.resumeFirst()
            : options.resumeFirst,
        autopilot: options.autopilot ?? false,
      },
      options.onChange,
      trace,
      page,
    );
    if (isPaged(driver)) {
      controller.pageStep = await driver.step();
      controller.readAlongside();
    }
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
      checks: this.state.steps
        .filter((s) => s.state === "done" && s.entry.check)
        .map((s) => `${s.entry.label}: ${s.entry.check}`),
      page: this.wizard
        ? {
            step: this.pageStep,
            last:
              this.wizard.system === "workday" &&
              FINAL_STEP.test(this.pageStep),
            system: this.wizard.system,
          }
        : null,
      fields: this.pageEntries.map((e) => e.label),
    };
  }

  /** The page's whole plan (not just the steps of a "Fill from" or "Fix a field" pass). */
  private pageEntries: readonly PlanEntry[] = [];

  private get wizard(): PagedDriver | null {
    return isPaged(this.driver) ? this.driver : null;
  }

  /** What each open field showed when you paused (by step number). */
  private shownAtPause: Map<number, string> | null = null;

  /** The fields not filled yet and what each shows now. */
  private async shownOpenFields(): Promise<Map<number, string>> {
    const shown = new Map<number, string>();
    for (const step of this.state.steps.slice(this.state.cursor)) {
      if (step.state === "running" || step.entry.type === "file") continue;
      const value = await this.driver.readBack(step.entry).catch(() => null);
      if (value !== null) shown.set(step.seq, value);
    }
    return shown;
  }

  /**
   * Resume after a pause: fields you changed meanwhile are yours and aren't filled over; the
   * run goes on from the first one still open.
   */
  private async resumeKeepingYourChanges(before: Map<number, string>) {
    this.busy = true;
    this.emit();
    try {
      const changed = changedSince(before, await this.shownOpenFields());
      if (changed.length) {
        const labels = this.state.steps
          .filter((s) => changed.includes(s.seq))
          .map((s) => s.entry.label);
        this.trace.event(
          "decision",
          `You changed ${changed.length} field(s) while paused; kept as yours: ${labels.join(", ").slice(0, 300)}`,
          { data: { seqs: changed } },
        );
        this.apply({ type: "changed-by-you", seqs: changed });
      }
    } finally {
      this.busy = false;
    }
    this.apply({ type: "resume" });
    void this.loop();
  }

  /** Your controls from the side panel. */
  dispatch(event: RunEvent): void {
    if (event.type === "resume" && this.shownAtPause && !this.busy) {
      const before = this.shownAtPause;
      this.shownAtPause = null;
      this.trace.event("decision", "You resumed the run");
      void this.resumeKeepingYourChanges(before);
      return;
    }
    if (event.type === "pause" && !this.state.paused)
      void this.shownOpenFields().then((shown) => {
        if (this.state.paused) this.shownAtPause = shown;
      });
    // Skip while the field is being filled: it's skipped now; what the fill is doing on the page
    // ends first (Claude stops at once), then the run goes on (fill() continues it).
    const skipMidway =
      event.type === "skip" &&
      this.busy &&
      this.state.steps[this.state.cursor]?.state === "running";
    if (
      this.busy &&
      !skipMidway &&
      event.type !== "pause" &&
      event.type !== "abort" &&
      event.type !== "submitted"
    )
      return;
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
    if (skipMidway) {
      this.notice = "Skipped. The next field starts once the page finishes what it was doing.";
      this.emit();
      return;
    }
    void this.loop();
  }

  /** You skipped this step while it was being filled: its result no longer counts. */
  private leftBehind(step: Step): boolean {
    return this.currentSeq() !== step.seq;
  }

  private apply(event: RunEvent) {
    this.state = reduce(this.state, event);
    void this.logFinishedSteps();
  }

  private async logFinishedSteps() {
    const finished = this.state.steps.filter(
      (s) => DONE_STATES.has(s.state) && !this.logged.has(s.seq),
    );
    // All claimed before the first wait: a second call meanwhile mustn't log them again.
    for (const step of finished) this.logged.add(step.seq);
    for (const step of finished) {
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
    // Claude's read of the page came back: taken between fields (never while paused).
    if (this.early && !this.busy && !this.state.paused && (await this.takeEarly())) return;
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
        // Autopilot: a required field with no answer of yours goes to Claude with your saved
        // answers; an optional one is left empty; Claude's drafted answers and consents are
        // approved (you check the page before you submit).
        if (this.autopilotDecides(action.step)) return this.loop();
        await this.mark(
          action.step,
          action.step.note ? "needs you" : "waiting for your click",
        );
        this.timer = setTimeout(() => void this.watchPage(), REVIEW_POLL_MS);
        return;
      case "fill":
        return this.fill(action.step);
      case "review":
        if (await this.fillTheRest()) return this.loop();
        if (await this.recheck()) return this.loop();
        if (await this.saveEntries()) return this.loop();
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
        this.timer = setTimeout(() => void this.watchPaused(), REVIEW_POLL_MS);
        return;
    }
  }

  /** Paused or waiting on a step: you may have submitted the form yourself meanwhile. */
  private async submittedMeanwhile(): Promise<boolean> {
    if (this.tabClosed || this.busy || !(await this.driver.submitted()))
      return false;
    this.apply({ type: "submitted" });
    void this.loop();
    return true;
  }

  private async watchPaused(): Promise<void> {
    if (nextAction(this.state).kind !== "paused") return;
    if (await this.submittedMeanwhile()) return;
    this.timer = setTimeout(() => void this.watchPaused(), REVIEW_POLL_MS);
  }

  /**
   * A company's page led into Workday's application (Danaher → myworkdayjobs.com): Workday's
   * own driver from here (its wizard, Add for each job, its dropdowns). True when it switched.
   */
  private async toWorkday(): Promise<boolean> {
    const generic = this.driver;
    if (!(generic instanceof GenericDriver) || !isWorkdayApply(this.page.url()))
      return false;
    const workday = await WorkdayDriver.attach(this.page).catch(() => null);
    if (!workday) return false;
    helpPicking(workday, this.client, this.job.jobId);
    workday.help = generic.help;
    this.driver = workday;
    this.startHost = new URL(this.page.url()).host;
    this.trace.event(
      "driver",
      `Now on Workday's application (${this.startHost}): Workday's own filler from here`,
    );
    return true;
  }

  /**
   * A field the site's driver (Greenhouse, Ashby, Lever) couldn't fill, tried by the generic
   * driver on the same input: its typed search, Enter, the plan's fallbacks. Null when there's
   * no site driver or no input in the field's box.
   */
  private async genericTry(
    step: Step,
    reason: string,
  ): Promise<FillOutcome | null> {
    const site = this.driver;
    if (
      !(site instanceof TrustedDriver) ||
      site instanceof GenericDriver ||
      step.entry.type === "file"
    )
      return null;
    const generic = GenericDriver.on(site.where());
    helpPicking(generic, this.client, this.job.jobId);
    const ref = await generic.refInside(site.boxSelector(step.entry.ref));
    if (!ref) return null;
    const outcome = await generic
      .fill({ ...step.entry, ref }, step.value)
      .catch((error: unknown) => failed(error));
    this.trace.event(
      "generic-try",
      `${step.entry.label}: the site's filler couldn't (${reason.slice(0, 120)}); the generic one ${outcome.ok ? `did: ${outcome.result}` : `couldn't either: ${outcome.reason}`}`,
      { stepSeq: step.seq, data: { ref, ok: outcome.ok } },
    );
    return outcome.ok
      ? { ok: true, result: `${outcome.result} (generic filler)` }
      : { ok: false, reason: `${reason}; the generic filler: ${outcome.reason}` };
  }

  /**
   * The site's plan is done (Greenhouse, Ashby, Lever): the page is read for fields it doesn't
   * cover and that are still empty (Greenhouse's Employment), and those are filled from the
   * page, as a company's own page is; the run goes on with the generic driver. Once per run.
   */
  private async fillTheRest(): Promise<boolean> {
    const site = this.driver;
    if (
      this.restRead ||
      this.wizard ||
      this.state.paused ||
      !(site instanceof TrustedDriver)
    )
      return false;
    this.restRead = true;
    await site.markCovered(this.state.steps.map((s) => s.entry.ref));
    const generic = GenericDriver.on(site.where());
    generic.onlyOpen = true;
    helpPicking(generic, this.client, this.job.jobId);
    generic.help = site.help;
    let entries: PlanEntry[];
    try {
      entries = (
        await planPagedPage(this.client, this.job.jobId, generic)
      ).filter((e) => e.status !== "skip");
    } catch (error) {
      this.trace.event(
        "error",
        `Couldn't read the rest of the page: ${errorText(error)}`,
      );
      return false;
    } finally {
      generic.onlyOpen = false;
    }
    if (!entries.length) return false;
    this.trace.event(
      "rest-of-page",
      `The site's plan is done; ${entries.length} more field(s) it doesn't cover are filled from the page: ${entries.map((e) => e.label).join(", ").slice(0, 300)}`,
      { data: { fields: entries.length } },
    );
    await this.logFinishedSteps();
    this.driver = generic;
    this.pageStep = await generic.step();
    this.restartWith(entries);
    return true;
  }

  /** Pages whose open entries were saved: once each. */
  private readonly entriesSaved = new Set<string>();

  /**
   * At review, once per page: entries opened for editing (with Edit or Add) and filled are
   * saved with their own Save, so they aren't lost; the page's main Save or Submit stays yours.
   * True when one was saved (the page is looked at again).
   */
  private async saveEntries(): Promise<boolean> {
    const wizard = this.wizard;
    const step = this.pageStep;
    if (!(wizard instanceof GenericDriver) || !step || this.entriesSaved.has(step)) return false;
    this.entriesSaved.add(step);
    const saved = await wizard.saveEntries().catch(() => [] as string[]);
    if (!saved.length) return false;
    this.trace.event(
      "decision",
      `Saved ${saved.length} entr${saved.length === 1 ? "y" : "ies"} with ${saved.length === 1 ? "its" : "their"} own button (${saved.join(", ")}); the page's main Save or Submit is yours`,
      { data: { saved } },
    );
    void this.snapshot("entries saved");
    return true;
  }

  /**
   * Once per page at review, in every run: fields filled earlier that are empty again or that
   * the page marks invalid ("End date must be in the past") are filled once more, plain code
   * first and then Claude, who is told what went wrong. True when it started that.
   */
  private async recheck(): Promise<boolean> {
    if (this.rechecked || this.state.paused) return false;
    this.rechecked = true;
    const wrong: { step: Step; why: string }[] = [];
    for (const step of this.state.steps) {
      // Only answers of yours: a question you or Claude settled without one isn't redone
      // (Claude would pick for you).
      if (
        step.state !== "done" ||
        step.entry.type === "file" ||
        step.value === null
      )
        continue;
      const why = (await this.driver.readBack(step.entry).catch(() => "x")).trim()
        ? await this.driver.invalid?.(step.entry.ref)
        : "empty again after it was filled";
      if (why) wrong.push({ step, why });
    }
    if (!wrong.length) return false;
    const help = this.driver instanceof TrustedDriver ? this.driver.help : null;
    for (const { step } of wrong) await unlearn(help, step.entry.label, step.result);
    this.trace.event(
      "recheck",
      `Filling ${wrong.length} field(s) again: ${wrong.map((w) => `${w.step.entry.label} (${w.why})`).join("; ").slice(0, 400)}`,
      { data: { fields: wrong.map((w) => ({ seq: w.step.seq, why: w.why })) } },
    );
    await this.logFinishedSteps();
    this.restartWith(wrong.map((w) => w.step.entry));
    // What went wrong goes with each field (Claude sees it if plain code fails again).
    this.state = {
      ...this.state,
      steps: this.state.steps.map((s, i) => ({
        ...s,
        note: `Filled before, but ${wrong[i]?.why ?? "it didn't hold"}`,
      })),
    };
    return true;
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
    // Signing in reloaded the page: the form is in a new frame.
    if (wizard instanceof GenericDriver && (await wizard.findFormFrame()))
      return (await wizard.step()) || "this page";
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
    // The page you're on is the one to fill, whichever site it's on now.
    this.startHost = new URL(this.page.url()).host;
    void (async () => {
      if (wizard instanceof GenericDriver) await wizard.findFormFrame();
      await this.nextPage((await wizard.step()) || this.pageStep || "this page");
    })();
  }

  /**
   * "Fill from…": start again at the field you chose; the fields before it stay as they are.
   * Page by page, the page on screen is read and planned afresh first (so what you or the site
   * changed meanwhile is seen); on a single form, the run's own steps go again from there.
   */
  fillFrom(seq: number): void {
    const step = this.state.steps.find((s) => s.seq === seq);
    if (!step || this.busy || this.closed || this.tabClosed) return;
    const from = this.fromStep(step);
    this.trace.event(
      "decision",
      `You asked to fill from step ${seq} (${step.entry.label})`,
      { stepSeq: seq, data: { ...from } },
    );
    this.fillAgain({ kind: "from", from });
  }

  /** A step as a place to fill from (the same field in a fresh plan of the page). */
  private fromStep(step: Step): FillFrom {
    return {
      ref: step.entry.ref,
      label: step.entry.label,
      nth: this.state.steps.filter(
        (s) => s.seq < step.seq && s.entry.label === step.entry.label,
      ).length,
    };
  }

  /**
   * "Claude: read this page": Claude reads the whole form (its HTML) closely, the page is
   * planned again with what it saw, and filled again (fields that are right already stay so).
   */
  readPageClosely(note?: string): void {
    const wizard = this.wizard;
    if (!wizard || this.busy || this.closed || this.tabClosed) return;
    this.clearTimer();
    this.trace.event(
      "decision",
      note
        ? `You told Claude: ${note.slice(0, 300)}`
        : "You asked Claude to read the page closely",
      note ? { data: { note } } : {},
    );
    void (async () => {
      if (wizard instanceof GenericDriver) await wizard.findFormFrame();
      const step = (await wizard.step()) || this.pageStep || "this page";
      this.readClosely.add(step);
      await this.nextPage(step, undefined, "html+screenshot", note);
    })();
  }

  /**
   * "Tell Claude": what to do on this page ("the resume goes in the Resume box, not the profile
   * photo"). Claude reads the whole page (its HTML and a screenshot) with your words, which come
   * before what the labels suggest, and the page is planned and filled again. An error to show,
   * or null.
   */
  tellClaude(note: string): string | null {
    const text = note.trim();
    if (text.length < 2) return "Say what Claude should do on this page.";
    if (!this.wizard)
      return "This form is filled from its posting's plan: use Fix a field, or Tell agent on a step.";
    if (this.closed || this.tabClosed) return "The run has ended.";
    if (this.busy) return "Wait for the step in progress (or Pause), then tell Claude.";
    this.readPageClosely(text);
    return null;
  }

  /**
   * A field still not filled after the site's driver, the generic one and saved steps: once per
   * page, Claude reads the whole form closely and the page is planned again from that field
   * (the fields before it stay). Before Claude works the field itself (escalate). False when
   * the page was read closely already, or this run can't.
   */
  private readCloselyFrom(step: Step): boolean {
    const page = this.pageStep;
    if (
      !this.wizard ||
      !page ||
      this.readClosely.has(page) ||
      this.claudeSpent ||
      this.state.paused ||
      YOURS_TO_TYPE.test(`${step.entry.label} ${step.entry.ref}`) ||
      step.entry.widget === "captcha"
    )
      return false;
    this.readClosely.add(page);
    this.trace.event(
      "decision",
      `"${step.entry.label}" got stuck: Claude reads the whole page closely, and the page is planned again from there`,
      { stepSeq: step.seq },
    );
    return true;
  }

  /** "Only this section": fills that section's fields (a job, a degree) and nothing else. */
  fillOnly(section: string): void {
    if (this.busy || this.closed || this.tabClosed) return;
    this.trace.event("decision", `You asked to fill only "${section}"`, {
      data: { section },
    });
    this.fillAgain({ kind: "only", section });
  }

  /**
   * "Fix a field": that one field again, the rest left as they are. `seq` is the step you picked,
   * or "focused" for the field you're on in the page. With Claude, it works the field on the
   * page itself, told what you said was wrong; else it's filled again the usual way.
   */
  async fixField(
    field: number | "focused",
    how: { readonly claude: boolean; readonly said?: string },
  ): Promise<string | null> {
    if (this.busy || this.closed || this.tabClosed) return "Wait for the step in progress.";
    const entries = this.pageEntries;
    const entry = field === "focused" ? await this.focusedEntry() : entries[field];
    if (!entry)
      return field === "focused"
        ? "Click the field on the page first (one this page's plan has), then pick it again."
        : "That field isn't on this page's plan.";
    const said = how.said?.trim() ?? "";
    // An upload Claude is told is wrong (the resume in a profile photo): Claude can't pick
    // files, so it's emptied and left out of this page's fills; the right one is yours.
    if (entry.type === "file" && how.claude) return this.leaveUpload(entry, said);
    const shown = (await this.driver.readBack(entry).catch(() => "")).slice(0, 300);
    this.trace.event(
      "decision",
      `You asked to fix "${entry.label}"${how.claude ? " with Claude" : ""}${said ? `: ${said.slice(0, 200)}` : ""}`,
      { data: { ref: entry.ref, claude: how.claude, said, shown } },
    );
    this.fillAgain({
      kind: "field",
      field: {
        ref: entry.ref,
        label: entry.label,
        nth: entries
          .slice(0, entries.indexOf(entry))
          .filter((e) => e.label === entry.label).length,
      },
      ...(how.claude
        ? {
            claude: [
              said ? `You said it's wrong: ${said}` : "You said it's wrong; check it and fix it.",
              shown ? `It shows now: ${shown}` : "",
            ]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
    });
    return null;
  }

  /** Uploads you said are wrong on this page: emptied, and never filled again here. */
  private leftAlone = new Set<string>();

  private async leaveUpload(entry: PlanEntry, said: string): Promise<null> {
    const cleared = (await this.driver.clearFile?.(entry.ref)) ?? false;
    this.leftAlone.add(entry.ref);
    this.pageEntries = this.pageEntries.filter((e) => e.ref !== entry.ref);
    this.trace.event(
      "decision",
      `You said the upload "${entry.label}" is wrong${said ? `: ${said.slice(0, 200)}` : ""}; ${cleared ? "emptied it" : "couldn't empty it"} and left it out of this page`,
      { data: { ref: entry.ref, cleared, said } },
    );
    this.notice = cleared
      ? `Emptied "${entry.label}" and won't fill it again on this page. If the page still shows the file, remove it there. Put the resume where it belongs with the kit, or Fill this page after.`
      : `Couldn't empty "${entry.label}": remove the file on the page. It won't be filled again on this page.`;
    this.emit();
    return null;
  }

  /** The page plan's field you clicked (or are in) on the page, if any. */
  private async focusedEntry(): Promise<PlanEntry | undefined> {
    const entries = this.pageEntries;
    const ref = await this.driver.focusedOf?.(entries.map((e) => e.ref));
    return ref ? entries.find((e) => e.ref === ref) : undefined;
  }

  /** "Fix a field" by Claude: the field's new step goes to Claude at once, with what you said. */
  private claudeTakes(choice?: PageChoice): void {
    if (choice?.kind !== "field" || choice.claude === undefined) return;
    const step = this.state.steps[this.state.cursor];
    if (!step) return;
    this.state = {
      ...this.state,
      steps: this.state.steps.map((s) =>
        s === step ? { ...s, note: choice.claude } : s,
      ),
    };
    this.apply({ type: "let-claude" });
  }

  private fillAgain(choice: PageChoice): void {
    this.clearTimer();
    const wizard = this.wizard;
    if (wizard) {
      void (async () => {
        if (wizard instanceof GenericDriver) await wizard.findFormFrame();
        await this.nextPage(
          (await wizard.step()) || this.pageStep || "this page",
          choice,
        );
      })();
      return;
    }
    void (async () => {
      await this.logFinishedSteps();
      this.restartWith(
        chosen(
          // One field: from the whole plan (the steps now may be a "Fill from" pass's).
          choice.kind === "field"
            ? this.pageEntries
            : this.state.steps.map((s) => s.entry),
          choice,
          this.resumeFirst,
        ),
      );
      this.claudeTakes(choice);
      void this.loop();
    })();
  }

  /** The run goes on with these entries as new steps (numbered after those before). */
  private restartWith(entries: readonly PlanEntry[]): void {
    this.state = {
      ...startRun(entries, {
        countdownSeconds: this.state.countdownSeconds,
        resumeFirst: this.resumeFirst,
        firstSeq: Math.max(0, ...this.state.steps.map((s) => s.seq)) + 1,
      }),
      autoApproved: this.state.autoApproved,
    };
    this.notice = null;
    this.shownAtPause = null;
  }

  /** While a step waits for you: you may have filled the rest and moved on, or submitted. */
  private async watchPage(): Promise<void> {
    if (
      this.tabClosed ||
      this.busy ||
      nextAction(this.state).kind !== "wait-for-you"
    )
      return;
    if (await this.submittedMeanwhile()) return;
    const moved = await this.movedTo();
    if (moved) return this.nextPage(moved);
    this.timer = setTimeout(() => void this.watchPage(), REVIEW_POLL_MS);
  }

  /**
   * You clicked Save and Continue (or Back): plan the page now on screen and fill it, from the
   * field you chose when you asked to fill from one.
   */
  private async nextPage(
    step: string,
    choice?: PageChoice,
    closely: Closely = false,
    /** What you told Claude about this page. */
    note?: string,
    /** Planned already (Claude's read alongside): these to fill; `all`, the page's whole plan. */
    preplanned?: { readonly entries: PlanEntry[]; readonly all: PlanEntry[] },
  ): Promise<void> {
    if (!this.wizard || this.closed) return;
    this.clearTimer();
    if (await this.toWorkday()) step = (await this.wizard?.step()) || step;
    const wizard = this.wizard;
    if (!wizard) return;
    this.busy = true;
    this.notice = null;
    this.problems = [];
    if (step !== this.pageStep) {
      this.leftAlone.clear();
      this.early = null;
    }
    this.pageStep = step;
    this.reviewTraced = false;
    this.rechecked = false;
    this.emit();
    await this.logFinishedSteps();
    const firstSeq = Math.max(0, ...this.state.steps.map((s) => s.seq)) + 1;
    // Paused while the page was being read and planned: the new plan waits for you too.
    const pausedBefore = this.state.paused;
    const begin = (entries: readonly PlanEntry[]) => ({
      ...startRun(entries, {
        countdownSeconds: this.state.countdownSeconds,
        resumeFirst: true,
        firstSeq,
      }),
      autoApproved: this.state.autoApproved,
      paused: this.state.paused && !pausedBefore,
    });
    try {
      if (!preplanned) await sleep(PAGE_SETTLE_MS);
      const planned =
        preplanned?.entries ??
        (await planPagedPage(this.client, this.job.jobId, wizard, closely, note));
      // Uploads you said are wrong stay out (until you leave this page).
      const kept = planned.filter((e) => !this.leftAlone.has(e.ref));
      const entries = choice ? chosen(kept, choice, true) : kept;
      const whole = preplanned
        ? preplanned.all.filter((e) => !this.leftAlone.has(e.ref))
        : kept;
      if (whole.length) this.pageEntries = inFillOrder(whole, true);
      this.state = begin(entries);
      if (!this.state.paused) this.shownAtPause = null;
      this.claudeTakes(choice);
      this.trace.event(
        "page",
        `On ${wizard.system === "workday" ? "Workday page" : "page"} "${step}" with ${entries.length} plan entries${choice ? ` (${describeChoice(choice)})` : ""}${closely ? ", after Claude read it closely" : ""}${note ? " with what you told it" : ""}`,
        {
          data: {
            step,
            entries: entries.length,
            ...(choice ? { choice } : {}),
            ...(closely ? { closely } : {}),
          },
        },
      );
      void this.snapshot(`page: ${step}`);
      // A form no site driver knows: Claude reads the whole page (HTML and a screenshot) while
      // the obvious fields are filled, and what it sees is taken in between fields.
      if (!preplanned && !closely) this.readAlongside();
    } catch (error) {
      this.notice = `Couldn't plan the "${step}" page (${errorText(error)}): fill it yourself, then continue.`;
      this.trace.event("error", this.notice, { data: { step } });
      this.state = begin([]);
    } finally {
      this.busy = false;
    }
    void this.loop();
  }

  /**
   * A form no site driver knows (the generic driver's own page, not the rest of a Greenhouse
   * form): once per page, Claude reads it alongside the fill. Site drivers' forms get Claude
   * only when a field gets stuck.
   */
  private readAlongside(): void {
    const wizard = this.wizard;
    const step = this.pageStep;
    if (!(wizard instanceof GenericDriver) || !step || this.readClosely.has(step) || this.claudeSpent)
      return;
    this.readClosely.add(step);
    void this.readEarly(step, wizard);
  }

  /** Claude's read alongside the fill: kept for the next point between fields. */
  private async readEarly(step: string, wizard: GenericDriver): Promise<void> {
    this.trace.event(
      "decision",
      `Claude reads page "${step}" closely (its HTML and a screenshot) while the fields it's sure of are filled`,
    );
    const planned = await planPagedPage(
      this.client,
      this.job.jobId,
      wizard,
      "html+screenshot",
      undefined,
      false,
    ).catch((error: unknown) => {
      this.trace.event("error", `Claude's read of the page failed: ${errorText(error)}`);
      return null;
    });
    if (!planned?.length || this.closed || this.pageStep !== step) return;
    this.early = { step, entries: planned };
    // At rest (review, waiting for you): taken now; mid-field: right after it.
    if (!this.busy && !this.state.paused) {
      this.clearTimer();
      void this.loop();
    }
  }

  /**
   * Claude's read is back: an upload it says isn't for the file is emptied, and what's new or
   * different (a field the reader missed, a value it now reads otherwise) is filled; fields
   * done already the same way stay as they are. False when there's nothing to take.
   */
  private async takeEarly(): Promise<boolean> {
    const early = this.early;
    this.early = null;
    if (!early || early.step !== this.pageStep || !this.wizard || this.closed) return false;
    const done = new Map(
      this.state.steps
        .filter((s) => s.state === "done" || s.state === "you-did-it")
        .map((s) => [s.entry.ref, s]),
    );
    for (const s of done.values()) {
      if (s.entry.type !== "file" || s.state === "you-did-it") continue;
      const now = early.entries.find((e) => e.ref === s.entry.ref);
      if (now?.status === "fill" && now.value !== null) continue;
      const cleared = (await this.driver.clearFile?.(s.entry.ref)) ?? false;
      this.leftAlone.add(s.entry.ref);
      this.trace.event(
        "decision",
        `Claude's read says "${s.entry.label}" isn't for this file: ${cleared ? "emptied it" : "couldn't empty it"}`,
        { stepSeq: s.seq, data: { ref: s.entry.ref, cleared } },
      );
    }
    const same = (a: PlanEntry, b: PlanEntry) =>
      a.status === b.status && JSON.stringify(a.value) === JSON.stringify(b.value);
    const all = early.entries.filter((e) => !this.leftAlone.has(e.ref));
    const todo = all.filter((e) => {
      const before = done.get(e.ref);
      return !before || (before.state !== "you-did-it" && !same(before.entry, e));
    });
    const known = new Set(this.pageEntries.map((e) => e.ref));
    const added = todo.filter((e) => !known.has(e.ref)).length;
    // The plan in progress has every one of them, the same: carry on as it is.
    const inProgress = (e: PlanEntry) =>
      this.state.steps.some((s) => s.entry.ref === e.ref && s.state !== "done" && same(s.entry, e));
    if (!added && todo.every(inProgress)) {
      this.trace.event("page-map", "Claude's read of the page is back: it agrees with the plan in progress");
      return false;
    }
    this.trace.event(
      "page-map",
      `Claude's read of the page is back: ${todo.length} field(s) to fill or fix${added ? `, ${added} the reader missed` : ""}`,
      { data: { todo: todo.length, added, refs: todo.map((e) => e.ref).slice(0, 40) } },
    );
    await this.nextPage(early.step, undefined, false, undefined, { entries: todo, all });
    return true;
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
    /** Stuck: the page is read closely and planned again from this field (not the next step). */
    let again: FillFrom | null = null;
    /** You pressed Skip while it was being filled. */
    let skipped = false;
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
      // The page drew itself again mid-fill: once more on the page as it is now.
      if (!outcome.ok && !step.operate && REDRAWN.test(outcome.reason)) {
        await sleep(REDRAW_SETTLE_MS);
        if (this.driver instanceof GenericDriver)
          await this.driver.findFormFrame().catch(() => false);
        if (!this.leftBehind(step))
          outcome = await this.driver.fill(
            step.entry,
            step.value,
            this.resume ?? undefined,
          );
      }
      // The site's driver couldn't: the generic one, on the same field.
      if (!outcome.ok && !step.operate && !this.leftBehind(step))
        outcome = (await this.genericTry(step, outcome.reason)) ?? outcome;
      // Not filled the usual way: this site's saved steps, then Claude's.
      if (!outcome.ok && !step.operate && !this.leftBehind(step))
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
      if (!outcome.ok && step.operate && BUDGET_SPENT.test(outcome.reason))
        this.claudeSpent = true;
      // You skipped it meanwhile: the result no longer counts; the field is left as it is.
      skipped = this.leftBehind(step);
      if (skipped)
        this.trace.event(
          "decision",
          `"${step.entry.label}" was skipped while it was being filled; left as it is on the page`,
          { stepSeq: step.seq, data: { ok: outcome.ok } },
        );
      else
        this.apply(
          outcome.ok
            ? { type: "filled", result: outcome.result }
            : { type: "fill-failed", reason: outcome.reason },
        );
      // Not filled: once per page, Claude reads the whole page and it's planned again from here.
      if (!skipped && !outcome.ok && !step.operate && this.readCloselyFrom(step))
        again = this.fromStep(step);
      // Then Claude tries it; after Claude's own try, once more with what that did (as your
      // "Let Claude do it" would: it settles a question it declined, a list it missed).
      else if (!skipped && !outcome.ok) this.escalate(step, outcome.reason);
    } catch (error) {
      await this.traceFailure(step, errorText(error));
      skipped = this.leftBehind(step);
      if (!skipped) this.apply({ type: "fill-failed", reason: errorText(error) });
    } finally {
      if (stall) clearTimeout(stall);
      if (skipped) this.notice = null;
      this.busy = false;
    }
    if (again)
      return this.nextPage(
        this.pageStep || "this page",
        { kind: "from", from: again },
        "html",
      );
    void this.loop();
  }

  /**
   * Autopilot: the field goes to Claude on the page by itself, with everything already tried
   * (in the step's note). Once per field and within the application's budget; after that it
   * waits for you.
   */
  /** Autopilot settles a step that waits for you, without you; false when it can't. */
  private autopilotDecides(step: Step): boolean {
    if (!this.autopilot || this.state.paused) return false;
    const unanswered =
      step.entry.status === "needs-you" || step.value === null;
    if (unanswered && step.entry.required)
      return this.escalate(step, step.note ?? "no saved answer");
    // Tried already and it failed: Claude had its turn (escalate), so it's yours now.
    if (step.state === "awaiting-you") return false;
    if (unanswered) {
      this.trace.event(
        "decision",
        `Autopilot left "${step.entry.label}" empty (optional, no answer of yours)`,
        { stepSeq: step.seq },
      );
      this.apply({ type: "skip", by: "autopilot" });
      return true;
    }
    this.trace.event(
      "decision",
      `Autopilot approved "${step.entry.label}" (${step.entry.source})`,
      { stepSeq: step.seq, data: { source: step.entry.source } },
    );
    this.apply({ type: "approve", by: "autopilot" });
    return true;
  }

  /**
   * A field plain code (and saved steps) couldn't fill goes to Claude on the page, once, in any
   * run (you no longer press "Let Claude do it"); not while paused or once Claude's budget for
   * this application is spent.
   */
  private escalate(step: Step, why: string): boolean {
    if (
      this.claudeSpent ||
      (this.escalated.get(step.seq) ?? 0) >= MAX_CLAUDE_TRIES ||
      step.entry.type === "file" ||
      // A captcha is yours to solve: Claude never types one.
      YOURS_TO_TYPE.test(`${step.entry.label} ${step.entry.ref}`) ||
      step.entry.widget === "captcha" ||
      !this.driver.operate ||
      this.state.paused
    )
      return false;
    const tries = (this.escalated.get(step.seq) ?? 0) + 1;
    this.escalated.set(step.seq, tries);
    this.trace.event(
      "escalate",
      `Claude takes over "${step.entry.label}" on the page${tries > 1 ? ", again with what its first try did" : ""} (${why.slice(0, 160)})`,
      { stepSeq: step.seq },
    );
    this.apply({ type: "let-claude" });
    return true;
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
      () =>
        this.state.paused ||
        this.closed ||
        this.tabClosed ||
        this.leftBehind(step),
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
    await this.keptAnswers.note(this.state.steps, (entry) =>
      this.driver.readBack(entry),
    );
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
    if (outcome === "submitted" && this.keptAnswers.size) {
      const kept = await this.keptAnswers.remember(this.client, this.job.jobId);
      this.trace.event(
        "learned",
        `Remembered ${kept} of Claude's answers you kept, for the next form asking the same`,
        { data: { kept } },
      );
    }
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
