import type { CaptureReport } from "../capture/tracker";
import type { TraceApi, TraceEvent, TraceSnapshot } from "../trace/recorder";
import type { Ats } from "./boards/types";
import type { LookupResult, PendingLookup, ResultOutcome } from "./lookups";

/** Client for the apply-assistant server (same envelope as Job Ops: {ok, data, error}). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface QueueItem {
  readonly jobId: string;
  readonly title: string;
  readonly employer: string;
  readonly score: number | null;
  /** Where Job Ops found the job (LinkedIn, Naukri, a job board). Absent on old servers. */
  readonly jobUrl?: string;
  /** Where it takes applications, when known (often captured from LinkedIn's Apply). */
  readonly applicationLink?: string | null;
  readonly target: {
    status: string;
    ats?: Ats;
    postingUrl?: string | null;
  };
  readonly plan: { summary: Record<string, number>; builtAt: string } | null;
  /** When the posting went up, if the job board said (absent on old servers). */
  readonly postedAt?: string | null;
  /** Set when the company takes only so many applications from you (Amazon: 1 per 6 months). */
  readonly companyLimit?: CompanyWindow | null;
}

/** Where you stand with a limited company (the server's view, from your Job Ops applications). */
export interface CompanyWindow {
  readonly id: number;
  readonly name: string;
  readonly maxApplications: number;
  readonly windowDays: number;
  readonly note: string;
  readonly used: readonly { jobId: string; title: string; appliedAt: string }[];
  readonly full: boolean;
  readonly nextOpen: string | null;
}

/** What the server did with a captured LinkedIn apply link. */
/** What Job Ops' model read from a job's page (any of it may be missing). */
export interface ImportDraft {
  readonly title?: string | null;
  readonly employer?: string | null;
  readonly location?: string | null;
  readonly salary?: string | null;
  readonly deadline?: string | null;
  readonly jobType?: string | null;
  readonly jobLevel?: string | null;
}

export interface ImportJob {
  readonly title: string;
  readonly employer: string;
  readonly jobUrl: string;
  readonly applicationLink: string;
  readonly location?: string;
  readonly salary?: string;
  readonly deadline?: string;
  readonly jobType?: string;
  readonly jobLevel?: string;
  readonly jobDescription: string;
}

export type CaptureOutcome =
  | {
      readonly status: "saved" | "unchanged";
      readonly jobId: string;
      readonly title: string;
      readonly employer: string;
      readonly link: string;
    }
  | { readonly status: "unknown-job" }
  | { readonly status: "rejected"; readonly reason: string };

export interface KitItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly sensitive?: boolean;
}

/** GET /kit/:jobId: every answer for filling an application by hand. */
export interface Kit {
  readonly job: {
    readonly jobId: string;
    readonly title: string;
    readonly employer: string;
    readonly location: string | null;
    readonly applyUrl: string;
    readonly tailoredSummary: string | null;
  };
  readonly groups: readonly {
    readonly name: string;
    readonly items: readonly KitItem[];
  }[];
}

export interface KitAnswer {
  readonly value: string;
  /** Where the answer came from, in words ("your saved answer (…)", "Claude's draft…"). */
  readonly how: string;
}

export class ApplyClient implements TraceApi {
  constructor(
    readonly baseUrl: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  withToken(token: string): ApplyClient {
    return new ApplyClient(this.baseUrl, token, this.fetchImpl);
  }

  async login(username: string, password: string): Promise<string> {
    const data = await this.request<{ token: string }>("/auth/login", {
      username,
      password,
    });
    return data.token;
  }

  pending(): Promise<PendingLookup[]> {
    return this.request("/lookups/pending");
  }

  submit(result: LookupResult): Promise<ResultOutcome> {
    return this.request("/lookups/results", result);
  }

  capture(report: CaptureReport): Promise<CaptureOutcome> {
    return this.request("/captures", report);
  }

  /** Marks a company as taking only so many applications from you in a while. */
  limitCompany(limit: {
    name: string;
    maxApplications: number;
    windowDays: number;
    note?: string;
  }): Promise<unknown> {
    return this.request("/company-limits", limit, "PUT");
  }

  unlimitCompany(id: number): Promise<unknown> {
    return this.request(`/company-limits/${id}`, undefined, "DELETE");
  }

  queue(): Promise<QueueItem[]> {
    return this.request("/queue");
  }

  /** Job Ops' model reads a job's details from its page's text (read in your browser). */
  readJob(page: { url: string; content: string }): Promise<{
    job: ImportDraft;
    warning: string | null;
  }> {
    return this.request("/jobs/import/read", page);
  }

  /** Adds a job to Job Ops (its manual import); Job Ops then tailors and scores it. */
  importJob(job: ImportJob): Promise<{ jobId: string; status: string }> {
    return this.request("/jobs/import", { job });
  }

  plan(jobId: string): Promise<unknown> {
    return this.request(`/plans/${encodeURIComponent(jobId)}`);
  }

  /** Workday: a plan for the wizard page you're on, from its fields. */
  planPage(jobId: string, page: unknown): Promise<unknown> {
    return this.request(`/plans/${encodeURIComponent(jobId)}/page`, page);
  }

  /** Workday: Claude picks the closest of a field's choices to your answer. */
  choose(
    jobId: string,
    ask: { label: string; wanted: string; options: readonly string[] },
  ): Promise<{ value: string | readonly string[]; why: string }> {
    return this.request(`/plans/${encodeURIComponent(jobId)}/choose`, ask);
  }

  /** Any company's form: Claude's steps for a field the extension couldn't fill. */
  act(
    jobId: string,
    ask: { label: string; wanted: string; html: string; failure: string },
  ): Promise<{
    steps: readonly {
      action: "click" | "type" | "press" | "pick" | "wait";
      value: string;
    }[];
    why: string;
  }> {
    return this.request(`/plans/${encodeURIComponent(jobId)}/act`, ask);
  }

  /** A site's saved steps, by question. */
  recipes(host: string): Promise<
    readonly {
      labelKey: string;
      steps: readonly {
        action: "click" | "type" | "press" | "pick" | "wait";
        value: string;
      }[];
      worked: number;
      failed: number;
    }[]
  > {
    return this.request(`/recipes?host=${encodeURIComponent(host)}`);
  }

  /** How a site's steps did (Claude's steps that worked become its recipe). */
  recordRecipe(result: {
    host: string;
    label: string;
    steps: readonly { action: string; value: string }[];
    ok: boolean;
    jobId: string;
  }): Promise<unknown> {
    return this.request("/recipes", result);
  }

  startRun(jobId: string): Promise<{ id: string }> {
    return this.request("/runs", { jobId });
  }

  logAction(runId: string, action: Record<string, unknown>): Promise<unknown> {
    return this.request(`/runs/${encodeURIComponent(runId)}/actions`, action);
  }

  completeRun(
    runId: string,
    outcome: "submitted" | "aborted",
  ): Promise<unknown> {
    return this.request(`/runs/${encodeURIComponent(runId)}/complete`, {
      outcome,
    });
  }

  traceEvents(events: readonly TraceEvent[]): Promise<unknown> {
    return this.request("/trace/events", { events });
  }

  traceSnapshot(snapshot: TraceSnapshot): Promise<unknown> {
    return this.request("/trace/snapshots", snapshot);
  }

  kit(jobId: string): Promise<Kit> {
    return this.request(`/kit/${encodeURIComponent(jobId)}`);
  }

  /** "Tell agent": Claude's proposal for one field from your instruction (nothing is filled). */
  tellAgent(
    jobId: string,
    body: {
      ref: string;
      instruction: string;
      field?: { label: string; type: string; options: readonly string[] };
    },
  ): Promise<{ value: string | readonly string[]; why: string }> {
    return this.request(`/plans/${encodeURIComponent(jobId)}/tell`, body);
  }

  /** Remembers your answer to a form question for the next form that asks it. */
  learn(answer: {
    jobId: string;
    label: string;
    type: string;
    value: string | readonly string[];
    how: "edited" | "typed";
  }): Promise<unknown> {
    return this.request("/learned", answer);
  }

  /** You applied by hand, or skipped the job: Job Ops' own apply/skip actions. */
  kitOutcome(
    jobId: string,
    outcome: "applied" | "skipped",
  ): Promise<{ status: string }> {
    return this.request(`/kit/${encodeURIComponent(jobId)}/outcome`, {
      outcome,
    });
  }

  kitAnswer(
    jobId: string,
    question: { question: string; options?: string[]; long?: boolean },
  ): Promise<KitAnswer> {
    return this.request(`/kit/${encodeURIComponent(jobId)}/answer`, question);
  }

  /** The job's tailored PDF, as base64 plus the file name the server chose. */
  async resumePdf(jobId: string): Promise<{ base64: string; name: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl.replace(/\/+$/, "")}/jobs/${encodeURIComponent(jobId)}/resume.pdf`,
      { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} },
    );
    if (!res.ok)
      throw new ApiError(
        res.status,
        "RESUME_UNAVAILABLE",
        "The tailored PDF isn't available from Job Ops",
      );
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const name =
      res.headers
        .get("content-disposition")
        ?.match(/filename="([^"]+)"/)?.[1] ?? "Resume.pdf";
    return { base64: btoa(binary), name };
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method?: "PUT" | "DELETE",
  ): Promise<T> {
    const res = await this.fetchImpl(
      `${this.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const payload = (await res.json().catch(() => null)) as {
      ok: boolean;
      data: T;
      error?: { code: string; message: string };
    } | null;
    if (!res.ok || !payload?.ok)
      throw new ApiError(
        res.status,
        payload?.error?.code ?? "ERROR",
        payload?.error?.message ?? `apply-assistant answered ${res.status}`,
      );
    return payload.data;
  }
}
