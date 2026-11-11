import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * What a Claude call was for, so its log entry (ai-call-store.ts) can be tied to the job, run,
 * step and field it served. The job part is set per request (aiJobContext); the purpose by the
 * module that makes the call (withAiPurpose). Both are best effort: a call outside them is still
 * logged, just with less to tie it to.
 */

export type AiPurpose =
  | "page-map"
  | "deep-read"
  | "map-questions"
  | "draft-answer"
  | "act-field"
  | "tell"
  | "operate"
  | "navigate";

export interface AiJobContext {
  readonly jobId?: string;
  readonly runId?: string;
  readonly stepSeq?: number;
  readonly label?: string;
}

export interface AiCallContext extends AiJobContext {
  readonly purpose: AiPurpose | "unknown";
}

const jobContext = new AsyncLocalStorage<AiJobContext>();
const purposeContext = new AsyncLocalStorage<AiPurpose>();

export function withAiJob<T>(context: AiJobContext, work: () => T): T {
  return jobContext.run({ ...jobContext.getStore(), ...context }, work);
}

export function withAiPurpose<T>(purpose: AiPurpose, work: () => T): T {
  return purposeContext.run(purpose, work);
}

export function currentAiContext(): AiCallContext {
  return { ...jobContext.getStore(), purpose: purposeContext.getStore() ?? "unknown" };
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

const MAX_ID = 100;
const MAX_LABEL = 300;

/** The field a request is about, wherever the route keeps it. */
function labelOf(body: Record<string, unknown>): string | undefined {
  const nested = ["field", "question", "ask", "turn"].map((key) => {
    const value = body[key];
    return value && typeof value === "object"
      ? (value as Record<string, unknown>).label
      : undefined;
  });
  return [body.label, ...nested]
    .map((value) => text(value, MAX_LABEL))
    .find((value) => value !== undefined);
}

function stepOf(body: Record<string, unknown>): number | undefined {
  const value = body.stepSeq ?? body.step;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Express middleware for per-job routes: the rest of the request knows its job, run and field. */
export function aiJobContext(req: Request, _res: Response, next: NextFunction): void {
  const body =
    req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const jobId = text(req.params.jobId, MAX_ID);
  const runId = text(body.runId, MAX_ID) ?? text(req.query.runId, MAX_ID);
  const stepSeq = stepOf(body);
  const label = labelOf(body);
  withAiJob(
    {
      ...(jobId ? { jobId } : {}),
      ...(runId ? { runId } : {}),
      ...(stepSeq === undefined ? {} : { stepSeq }),
      ...(label ? { label } : {}),
    },
    () => next(),
  );
}
