import type { NextFunction, Request, Response } from "express";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsUser,
} from "../jobops/client.js";
import { runAsUser } from "../store/owner.js";
import { sendError } from "./envelope.js";

/**
 * Every protected route needs the caller's own Job Ops token. The token is checked against
 * Job Ops (/api/auth/me) and the result cached briefly, so one login covers both apps. The
 * rest of the request runs as that user: it reads and writes only their data (owner.ts).
 */

export interface AuthedRequest extends Request {
  user?: JobOpsUser;
  jobOpsToken?: string;
}

interface CacheEntry {
  readonly user: JobOpsUser;
  readonly expiresAt: number;
}

export function createAuthMiddleware(
  jobOps: JobOpsApi,
  cacheSeconds: number,
  onUser: (user: JobOpsUser) => void = () => {},
) {
  const cache = new Map<string, CacheEntry>();
  const proceed = (
    req: AuthedRequest,
    user: JobOpsUser,
    token: string,
    next: NextFunction,
  ) => {
    req.user = user;
    req.jobOpsToken = token;
    onUser(user);
    runAsUser(user.id, () => next());
  };

  return async function requireJobOpsUser(
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";
    if (!token)
      return sendError(
        res,
        401,
        "UNAUTHORIZED",
        "Sign in with your Job Ops account",
      );

    const cached = cache.get(token);
    if (cached && cached.expiresAt > Date.now())
      return proceed(req, cached.user, token, next);

    try {
      const user = await jobOps.me(token);
      cache.set(token, { user, expiresAt: Date.now() + cacheSeconds * 1000 });
      return proceed(req, user, token, next);
    } catch (error) {
      cache.delete(token);
      if (
        error instanceof JobOpsError &&
        (error.status === 401 || error.status === 403)
      ) {
        return sendError(
          res,
          401,
          "UNAUTHORIZED",
          "Your Job Ops session is invalid or expired",
        );
      }
      return sendJobOpsFailure(res, error);
    }
  };
}

/** Maps a Job Ops call failure to a response the caller can act on. */
export function sendJobOpsFailure(res: Response, error: unknown): void {
  if (error instanceof JobOpsError) {
    const status = error.status >= 500 ? 502 : error.status;
    sendError(res, status, error.code, error.message);
    return;
  }
  console.error("[apply-assistant] Job Ops request failed:", error);
  sendError(
    res,
    502,
    "JOBOPS_UNREACHABLE",
    "Job Ops could not be reached. Check that it is running.",
  );
}
