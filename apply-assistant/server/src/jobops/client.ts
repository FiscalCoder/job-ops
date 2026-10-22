import { z } from "zod";

/**
 * Thin client for the existing Job Ops HTTP API. apply-assistant never touches Job Ops'
 * database or code; everything goes through these endpoints (covered by contract tests).
 */

export class JobOpsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobOpsError";
  }
}

export interface JobOpsUser {
  readonly id: string;
  readonly username: string;
}

export interface JobOpsJob {
  readonly id: string;
  readonly title: string;
  readonly employer: string;
  readonly status: string;
  readonly jobUrl: string;
  readonly applicationLink: string | null;
  readonly suitabilityScore: number | null;
  /** When the posting went up (as the job board said), if known. */
  readonly datePosted?: string | null;
  /** When you applied (Job Ops sets it on "applied"). */
  readonly appliedAt?: string | null;
}

export interface JobOpsJobDetail extends JobOpsJob {
  readonly location: string | null;
  readonly jobDescription: string | null;
  /** The summary Job Ops wrote for this job's tailored resume (absent in older fakes). */
  readonly tailoredSummary?: string | null;
}

export interface JobUpdate {
  readonly applicationLink?: string | null;
  readonly status?: "applied" | "expired";
}

export interface JobNote {
  readonly title: string;
  readonly content: string;
}

/** The subset of Job Ops that apply-assistant depends on (also what tests fake). */
export interface JobOpsApi {
  login(
    username: string,
    password: string,
  ): Promise<{ token: string; expiresIn: number }>;
  me(token: string): Promise<JobOpsUser>;
  listJobs(
    token: string,
    statuses: readonly string[],
  ): Promise<{ jobs: JobOpsJob[]; total: number; revision: string }>;
  getJob(token: string, jobId: string): Promise<JobOpsJobDetail>;
  updateJob(token: string, jobId: string, update: JobUpdate): Promise<void>;
  /** Job Ops' own "Applied" action: status, applied date and the Applied stage event. */
  markApplied(token: string, jobId: string): Promise<void>;
  /** Job Ops' own "Skip" action. */
  skipJob(token: string, jobId: string): Promise<void>;
  addNote(token: string, jobId: string, note: JobNote): Promise<void>;
  getPdf(token: string, jobId: string): Promise<Uint8Array>;
  /** Resume Studio document (Reactive Resume JSON): the source the tailored PDFs are built from. */
  getDesignResume(token: string): Promise<unknown>;
}

const errorEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

const loginData = z.object({ token: z.string().min(1), expiresIn: z.number() });
const meData = z.object({
  user: z.object({ id: z.string(), username: z.string() }),
});
const designResumeData = z.object({ resumeJson: z.unknown() });
const jobShape = z
  .object({
    id: z.string(),
    title: z.string(),
    employer: z.string(),
    status: z.string(),
    jobUrl: z.string(),
    applicationLink: z.string().nullable().optional(),
    suitabilityScore: z.number().nullable().optional(),
    datePosted: z.string().nullable().optional(),
    appliedAt: z.string().nullable().optional(),
  })
  .passthrough();
const jobsData = z.object({
  jobs: z.array(jobShape),
  total: z.number(),
  revision: z.string(),
});
const jobDetailData = jobShape.extend({
  location: z.string().nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  tailoredSummary: z.string().nullable().optional(),
});

/**
 * Naukri's "apply on company site" click tracker, saved as the application link by older
 * Naukri scrapes: it errors unless clicked from a signed-in Naukri page, so the listing is used.
 */
const NAUKRI_TRACKER = /^https:\/\/www\.naukri\.com\/.*\/saveCompanyApply/i;

const toJob = (job: z.infer<typeof jobShape>): JobOpsJob => ({
  id: job.id,
  title: job.title,
  employer: job.employer,
  status: job.status,
  jobUrl: job.jobUrl,
  applicationLink:
    job.applicationLink && !NAUKRI_TRACKER.test(job.applicationLink)
      ? job.applicationLink
      : null,
  suitabilityScore: job.suitabilityScore ?? null,
  datePosted: job.datePosted ?? null,
  appliedAt: job.appliedAt ?? null,
});

export class JobOpsClient implements JobOpsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async login(username: string, password: string) {
    return this.request("/api/auth/login", loginData, {
      method: "POST",
      body: { username, password },
    });
  }

  async me(token: string): Promise<JobOpsUser> {
    const data = await this.request("/api/auth/me", meData, { token });
    return { id: data.user.id, username: data.user.username };
  }

  async listJobs(token: string, statuses: readonly string[]) {
    const query = new URLSearchParams({
      status: statuses.join(","),
      view: "list",
    });
    const data = await this.request(`/api/jobs?${query}`, jobsData, { token });
    return {
      total: data.total,
      revision: data.revision,
      jobs: data.jobs.map(toJob),
    };
  }

  async getJob(token: string, jobId: string): Promise<JobOpsJobDetail> {
    const job = await this.request(
      `/api/jobs/${encodeURIComponent(jobId)}`,
      jobDetailData,
      { token },
    );
    return {
      ...toJob(job),
      location: job.location ?? null,
      jobDescription: job.jobDescription ?? null,
      tailoredSummary: job.tailoredSummary ?? null,
    };
  }

  async updateJob(
    token: string,
    jobId: string,
    update: JobUpdate,
  ): Promise<void> {
    await this.request(`/api/jobs/${encodeURIComponent(jobId)}`, z.unknown(), {
      method: "PATCH",
      token,
      body: update,
    });
  }

  async markApplied(token: string, jobId: string): Promise<void> {
    await this.request(
      `/api/jobs/${encodeURIComponent(jobId)}/apply`,
      z.unknown(),
      { method: "POST", token, body: {} },
    );
  }

  async skipJob(token: string, jobId: string): Promise<void> {
    await this.request(
      `/api/jobs/${encodeURIComponent(jobId)}/skip`,
      z.unknown(),
      { method: "POST", token, body: {} },
    );
  }

  async addNote(token: string, jobId: string, note: JobNote): Promise<void> {
    await this.request(
      `/api/jobs/${encodeURIComponent(jobId)}/notes`,
      z.unknown(),
      { method: "POST", token, body: note },
    );
  }

  async getPdf(token: string, jobId: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/pdf`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok) throw await toJobOpsError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getDesignResume(token: string): Promise<unknown> {
    const data = await this.request("/api/design-resume", designResumeData, {
      token,
    });
    return data.resumeJson;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    if (!res.ok) throw await toJobOpsError(res);
    const payload: unknown = await res.json().catch(() => null);
    const envelope = z
      .object({ ok: z.literal(true), data: schema })
      .safeParse(payload);
    if (!envelope.success) {
      throw new JobOpsError(
        502,
        "UNEXPECTED_RESPONSE",
        `Job Ops returned an unexpected response for ${path}`,
      );
    }
    return envelope.data.data as T;
  }
}

async function toJobOpsError(res: Response): Promise<JobOpsError> {
  const payload: unknown = await res.json().catch(() => null);
  const parsed = errorEnvelope.safeParse(payload);
  return parsed.success
    ? new JobOpsError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
      )
    : new JobOpsError(
        res.status,
        "HTTP_ERROR",
        `Job Ops responded with HTTP ${res.status}`,
      );
}
