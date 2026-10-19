import type { Response } from "express";

/** Same envelope shape as Job Ops: { ok, data } on success, { ok, error } on failure. */
export function sendOk<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  });
}
