/**
 * Sends a job's trace to apply-assistant (APPLY_TRACE_AND_KIT_PLAN.md §T1): events are buffered
 * and sent in batches; snapshots go one at a time. Tracing never throws into the caller and
 * never stops a run: when the server can't be reached, events wait (up to MAX_BUFFERED).
 */

export type TraceSource = "extension" | "page";

export interface TraceEvent {
  readonly jobId: string;
  readonly runId: string | null;
  readonly ts: string;
  readonly source: TraceSource;
  readonly kind: string;
  readonly stepSeq: number | null;
  readonly message: string;
  readonly data?: unknown;
}

export interface TraceSnapshot {
  readonly jobId: string;
  readonly runId: string | null;
  readonly ts: string;
  readonly kind: "dom" | "screenshot";
  readonly reason: string;
  readonly url: string | null;
  readonly content: string;
}

/** What the recorder needs from the server client. */
export interface TraceApi {
  traceEvents(events: readonly TraceEvent[]): Promise<unknown>;
  traceSnapshot(snapshot: TraceSnapshot): Promise<unknown>;
}

/** What a snapshot captured: the form's DOM, a JPEG (base64), and the page address. */
export interface Capture {
  readonly html?: string | null;
  readonly screenshot?: string | null;
  readonly url?: string | null;
}

export const FLUSH_MS = 2_000;
export const BATCH = 20;
export const MAX_BUFFERED = 500;
/** The server takes at most 200 events per request. */
const MAX_PER_REQUEST = 200;

export interface RecorderOptions {
  readonly flushMs?: number;
  readonly batch?: number;
  readonly maxBuffered?: number;
  readonly now?: () => Date;
}

export class TraceRecorder {
  private buffer: TraceEvent[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private snapshots: Promise<void> = Promise.resolve();
  private runId: string | null = null;
  private closed = false;
  private readonly flushMs: number;
  private readonly batch: number;
  private readonly maxBuffered: number;
  private readonly now: () => Date;

  constructor(
    private readonly api: TraceApi,
    readonly jobId: string,
    options: RecorderOptions = {},
  ) {
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.batch = options.batch ?? BATCH;
    this.maxBuffered = options.maxBuffered ?? MAX_BUFFERED;
    this.now = options.now ?? (() => new Date());
  }

  /** From here on, events belong to this supervised run. */
  setRun(runId: string): void {
    this.runId = runId;
  }

  event(
    kind: string,
    message: string,
    extra: { stepSeq?: number; data?: unknown; source?: TraceSource } = {},
  ): void {
    if (this.closed) return;
    this.buffer.push({
      jobId: this.jobId,
      runId: this.runId,
      ts: this.now().toISOString(),
      source: extra.source ?? "extension",
      kind,
      stepSeq: extra.stepSeq ?? null,
      message: message.slice(0, 2_000),
      ...(extra.data === undefined ? {} : { data: extra.data }),
    });
    if (this.buffer.length > this.maxBuffered) {
      this.dropped += this.buffer.length - this.maxBuffered;
      this.buffer = this.buffer.slice(-this.maxBuffered);
    }
    if (this.buffer.length >= this.batch) void this.flush();
    else this.schedule();
  }

  /**
   * Captures (DOM, screenshot) and uploads, after any snapshot already on its way. Resolves
   * once uploaded or failed; failures become an event, never an error.
   */
  snapshot(reason: string, capture: () => Promise<Capture>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const ts = this.now().toISOString();
    const runId = this.runId;
    this.snapshots = this.snapshots.then(async () => {
      try {
        const taken = await capture();
        const base = {
          jobId: this.jobId,
          runId,
          ts,
          reason,
          url: taken.url ?? null,
        };
        if (taken.html)
          await this.api.traceSnapshot({
            ...base,
            kind: "dom",
            content: taken.html,
          });
        if (taken.screenshot)
          await this.api.traceSnapshot({
            ...base,
            kind: "screenshot",
            content: taken.screenshot,
          });
      } catch (error) {
        this.event(
          "trace-problem",
          `Snapshot "${reason}" failed: ${errorText(error)}`,
        );
      }
    });
    return this.snapshots;
  }

  /** Sends what's buffered; keeps it for the next try when the server can't be reached. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.sending) {
      await this.sending;
      if (this.buffer.length === 0) return;
    }
    if (this.buffer.length === 0 && this.dropped === 0) return;
    if (this.dropped > 0) {
      const lost = this.dropped;
      this.dropped = 0;
      this.buffer.unshift({
        jobId: this.jobId,
        runId: this.runId,
        ts: this.now().toISOString(),
        source: "extension",
        kind: "trace-problem",
        stepSeq: null,
        message: `${lost} trace event(s) were dropped while the server was unreachable`,
      });
    }
    const outgoing = this.buffer.slice(0, MAX_PER_REQUEST);
    this.buffer = this.buffer.slice(outgoing.length);
    this.sending = this.api
      .traceEvents(outgoing)
      .then(() => {})
      .catch(() => {
        this.buffer = [...outgoing, ...this.buffer].slice(-this.maxBuffered);
      })
      .finally(() => {
        this.sending = null;
        if (this.buffer.length && !this.closed) this.schedule();
      });
    await this.sending;
  }

  /** Waits for snapshots, sends the rest, and stops recording. */
  async close(): Promise<void> {
    await this.snapshots;
    await this.flush();
    this.closed = true;
    this.clearTimer();
  }

  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
