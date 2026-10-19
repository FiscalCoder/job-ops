import type { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { sendError } from "./envelope.js";

/** Headers for the page and API: same-origin scripts only, no framing, no referrer leaks. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 10;
const REQUESTS_PER_MINUTE = 300;

/** Failed sign-ins only: a correct password never counts against you. */
export const createLoginLimiter = () =>
  rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: LOGIN_ATTEMPTS,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(
        res,
        429,
        "TOO_MANY_ATTEMPTS",
        "Too many sign-in attempts. Try again in a few minutes.",
      ),
  });

/** A generous ceiling for everything else (the extension polls; you click). */
export const createApiLimiter = () =>
  rateLimit({
    windowMs: 60 * 1000,
    limit: REQUESTS_PER_MINUTE,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(
        res,
        429,
        "RATE_LIMITED",
        "Too many requests. Slow down for a minute.",
      ),
  });
