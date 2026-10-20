import type { CaptureReport } from "../capture/tracker";
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
  readonly greenhouse: { status: string; ghUrl?: string | null };
  readonly plan: { summary: Record<string, number>; builtAt: string } | null;
}

/** What the server did with a captured LinkedIn apply link. */
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

export class ApplyClient {
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

  queue(): Promise<QueueItem[]> {
    return this.request("/queue");
  }

  plan(jobId: string): Promise<unknown> {
    return this.request(`/plans/${encodeURIComponent(jobId)}`);
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

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(
      `${this.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
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
