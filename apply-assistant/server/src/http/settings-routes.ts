import { type Response, Router } from "express";
import { z } from "zod";
import type { ClaudeAccess } from "../claude/access.js";
import type { UserSettingsRepo } from "../store/user-settings-repo.js";
import type { AuthedRequest } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Your own settings: your Claude (Anthropic) API key. It's stored for you alone and never sent
 * back: the reply says only whose key is used and the key's last characters.
 */

const keyBody = z.object({
  apiKey: z
    .string()
    .trim()
    .regex(/^sk-ant-[A-Za-z0-9_-]{20,300}$/, "That isn't an Anthropic API key (sk-ant-…)"),
});

export const MAX_CREDIT_USD = 100_000;

/** A real calendar date (YYYY-MM-DD) that isn't after today (UTC). */
export function validAsOf(text: string, nowMs: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 10) === text &&
    text <= new Date(nowMs).toISOString().slice(0, 10)
  );
}

const creditBody = z.object({
  amountUsd: z.number().min(0).max(MAX_CREDIT_USD),
  asOf: z.string(),
});

export function createSettingsRoutes(deps: {
  readonly settings: UserSettingsRepo;
  readonly access: ClaudeAccess | null;
  readonly now?: () => number;
}) {
  const { settings, access } = deps;
  const now = deps.now ?? Date.now;
  const router = Router();

  const status = () => {
    const own = settings.claudeKey();
    return {
      // "yours", "server" (Job Ops' admin, no key saved) or null: Claude is off for you.
      source: access?.source() ?? null,
      hint: own ? `…${own.slice(-4)}` : null,
    };
  };

  router.get("/settings/claude", (_req, res) => sendOk(res, status()));

  router.put("/settings/claude", (req: AuthedRequest, res: Response) => {
    const body = keyBody.safeParse(req.body);
    if (!body.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        body.error.issues[0]?.message ?? "Invalid key",
      );
      return;
    }
    settings.setClaudeKey(body.data.apiKey);
    sendOk(res, status());
  });

  router.delete("/settings/claude", (_req, res) => {
    settings.setClaudeKey(null);
    sendOk(res, status());
  });

  // The Claude credit you loaded: an estimate you enter (Anthropic has no API for what's left).
  const credit = () => {
    const own = settings.claudeCredit();
    return { amountUsd: own?.amountUsd ?? null, asOf: own?.asOf ?? null };
  };

  router.get("/settings/claude-credit", (_req, res) => sendOk(res, credit()));

  router.put("/settings/claude-credit", (req: AuthedRequest, res: Response) => {
    const body = creditBody.safeParse(req.body);
    if (!body.success || !validAsOf(body.data.asOf, now())) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        `Credit must be $0 to $${MAX_CREDIT_USD.toLocaleString("en-US")} with a date (YYYY-MM-DD) that isn't in the future`,
      );
      return;
    }
    settings.setClaudeCredit(body.data);
    sendOk(res, credit());
  });

  router.delete("/settings/claude-credit", (_req, res) => {
    settings.setClaudeCredit(null);
    sendOk(res, credit());
  });

  return router;
}
