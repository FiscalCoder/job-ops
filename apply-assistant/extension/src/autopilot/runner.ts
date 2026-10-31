import { openForm } from "../fill/controller";
import type { ApplyClient, QueueItem } from "../lib/api";
import { errorText, TraceRecorder } from "../trace/recorder";
import { pagedFill } from "../track/job-match";
import { findForm, type NavOutcome } from "./navigator";

/**
 * Autopilot over the queue (AUTOPILOT_PLAN.md §E): highest score first, each job opened in a
 * visible tab, its form found (navigator.ts), filled with Claude rescuing what plain code can't,
 * and left at review for you to submit. Anything it can't decide (a closed posting, a sign-in,
 * no way to the form) comes to you as a question; nothing is ever submitted by it.
 */

export type RunEnd = "submitted" | "aborted" | "failed";

export interface Ask {
  /** aborted: you stopped an application yourself; go on to the next job? */
  readonly kind: "closed" | "login" | "stuck" | "aborted";
  readonly item: QueueItem;
  readonly reason: string;
}

/** expire: mark it expired; continue: you've opened the form (or signed in), go on; skip; stop. */
export type Choice = "expire" | "continue" | "skip" | "stop";

export interface AutopilotStatus {
  readonly item: QueueItem | null;
  /** Jobs started so far, and how many there are in all this pass. */
  readonly done: number;
  readonly total: number;
  readonly phase: "finding the form" | "filling" | "waiting for you" | "finished";
  readonly note?: string;
  /** What Claude has cost on this job so far (dollars), once known. */
  readonly cost?: number;
}

export interface AutopilotDeps {
  readonly client: ApplyClient;
  readonly queue: () => Promise<readonly QueueItem[]>;
  /** Fills the job (in this tab, page by page when paged is set); resolves when the run ends. */
  readonly fill: (
    item: QueueItem,
    tabId?: number,
    paged?: "workday" | "generic" | null,
  ) => Promise<RunEnd>;
  readonly ask: (question: Ask) => Promise<Choice>;
  readonly status: (status: AutopilotStatus) => void;
  /** Your setting: mark postings that look closed expired without asking. */
  readonly autoExpire: () => Promise<boolean>;
}

/** Hosts autopilot never opens a job on: their apply flows aren't automated. */
const NOT_OURS =
  /(^|\.)(linkedin|indeed|naukri|glassdoor|monster|foundit|shine|instahyre)\.(com|co\.in|in)$/i;

function allowed(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !NOT_OURS.test(u.hostname);
  } catch {
    return false;
  }
}

/** Where the job is opened: its application link, else the job's page; never LinkedIn or Indeed. */
export function startLink(item: QueueItem): string | null {
  if (allowed(item.applicationLink)) return item.applicationLink;
  if (allowed(item.jobUrl)) return item.jobUrl;
  return null;
}

/** Highest score first; companies whose limit is used up are left out. */
export function autopilotOrder(items: readonly QueueItem[]): QueueItem[] {
  return items
    .filter((i) => !i.companyLimit?.full)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** How often the bar's cost is brought up to date while a job runs. */
const COST_POLL_MS = 5_000;

const activeTabId = async (): Promise<number | undefined> =>
  (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;

export class Autopilot {
  private stopped = false;
  private skipping = false;
  private readonly started = new Set<string>();

  constructor(private readonly deps: AutopilotDeps) {}

  stop(): void {
    this.stopped = true;
  }

  /** Leave this job (while its form is being found) and go on to the next. */
  skip(): void {
    this.skipping = true;
  }

  get running(): boolean {
    return !this.stopped;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const left = autopilotOrder(await this.deps.queue()).filter(
        (i) => !this.started.has(i.jobId),
      );
      const item = left[0];
      if (!item) break;
      this.started.add(item.jobId);
      this.skipping = false;
      const done = this.started.size;
      const total = done - 1 + left.length;
      // The bar shows what Claude has cost on this job, kept up to date while it runs.
      const since = new Date().toISOString();
      let shown: AutopilotStatus = { item, done, total, phase: "finding the form" };
      let cost: number | undefined;
      const report = (status: AutopilotStatus) => {
        shown = status;
        this.deps.status(cost === undefined ? status : { ...status, cost });
      };
      const poll = setInterval(() => {
        void this.deps.client
          .jobCost(item.jobId, since)
          .then((spent) => {
            if (spent.cost === cost) return;
            cost = spent.cost;
            report(shown);
          })
          .catch(() => {});
      }, COST_POLL_MS);
      await this.runJob(item, (phase, note) =>
        report({ item, done, total, phase, ...(note ? { note } : {}) }),
      )
        .catch((error: unknown) =>
          report({
            item,
            done,
            total,
            phase: "waiting for you",
            note: `Something went wrong: ${errorText(error)}; going on to the next job`,
          }),
        )
        .finally(() => clearInterval(poll));
    }
    this.stopped = true;
    this.deps.status({
      item: null,
      done: this.started.size,
      total: this.started.size,
      phase: "finished",
    });
  }

  private async runJob(
    item: QueueItem,
    status: (phase: AutopilotStatus["phase"], note?: string) => void,
  ): Promise<void> {
    // Greenhouse, Ashby and Lever: their form is known; the run opens it itself.
    // Greenhouse, Ashby and Lever: their form is known, so the posting is only checked for being
    // closed (nothing clicked); then the run fills it from its own plan.
    const ats = Boolean(item.target.postingUrl && item.target.ats);
    const link = ats ? (item.target.postingUrl ?? null) : startLink(item);
    if (!link) {
      status("waiting for you", "Only on LinkedIn or a job board: skipped");
      return;
    }
    status("finding the form");
    const tab = await openForm(link);
    if (tab.id === undefined) return;
    const trace = new TraceRecorder(this.deps.client, item.jobId);
    trace.event("autopilot", `Autopilot opened ${link}`, { data: { link, score: item.score } });
    const stopped = () => this.stopped || this.skipping;
    const look = (tabId: number) =>
      findForm(tabId, {
        client: this.deps.client,
        jobId: item.jobId,
        trace,
        stopped,
        checkOnly: ats,
      });
    let outcome: NavOutcome = await look(tab.id);
    try {
      for (;;) {
        if (stopped()) return;
        if (outcome.kind === "form" || (ats && outcome.kind !== "closed")) {
          await trace.close();
          status("filling");
          const end = await this.deps.fill(
            item,
            outcome.tabId,
            ats ? null : (pagedFill(outcome.url) ?? "generic"),
          );
          await this.afterRun(item, end);
          return;
        }
        const choice =
          outcome.kind === "closed" && (await this.deps.autoExpire())
            ? "expire"
            : (status("waiting for you", outcome.reason),
              await this.deps.ask({ kind: outcome.kind, item, reason: outcome.reason }));
        trace.event("decision", `${outcome.kind}: ${outcome.reason} → you chose ${choice}`, {
          data: { kind: outcome.kind, reason: outcome.reason, choice },
        });
        if (choice === "stop") return this.stop();
        if (choice === "skip") return;
        if (choice === "expire") {
          await this.deps.client.expireJob(item.jobId, outcome.reason);
          await chrome.tabs.remove(outcome.tabId).catch(() => {});
          return;
        }
        // You signed in or opened the form yourself: look again, in the tab you're on.
        const here = (await activeTabId()) ?? outcome.tabId;
        outcome = await look(here);
        // You said it isn't closed: the closed wording is ignored from here.
        if (outcome.kind === "closed")
          outcome = { kind: "stuck", tabId: here, url: outcome.url, reason: "Open the application form, then Continue" };
      }
    } finally {
      await trace.close();
    }
  }

  /**
   * You aborted the application yourself (not Skip or Stop on the bar): asked whether to go on
   * to the next job or stop here.
   */
  private async afterRun(item: QueueItem, end: RunEnd): Promise<void> {
    if (end !== "aborted" || this.stopped || this.skipping) return;
    const choice = await this.deps.ask({
      kind: "aborted",
      item,
      reason: "",
    });
    if (choice === "stop") this.stop();
  }
}
