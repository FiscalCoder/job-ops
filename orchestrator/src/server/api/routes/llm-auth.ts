import {
  badRequest,
  conflict,
  forbidden,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { getRequestId } from "@infra/request-context";
import { getJobOpsAppConfig } from "@server/config/app-mode";
import { isDemoMode, sendDemoBlocked } from "@server/config/demo";
import { resetCodexSession } from "@server/services/llm/codex/client";
import {
  disconnectCodexAuth,
  startCodexDeviceAuth,
} from "@server/services/llm/codex/login";
import { getLlmAuthStatus } from "@server/services/llm/subscription-auth/auth-status";
import {
  ClaudeLoginError,
  cancelClaudeLogin,
  saveManualClaudeToken,
  startClaudeLogin,
  submitClaudeLoginCode,
} from "@server/services/llm/subscription-auth/claude-login";
import { deleteClaudeToken } from "@server/services/llm/subscription-auth/claude-token-store";
import { verifyClaudeToken } from "@server/services/llm/subscription-auth/claude-verify";
import {
  type CliAuthScope,
  CliAuthScopeError,
  getCliAuthScope,
} from "@server/services/llm/subscription-auth/scope";
import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from "express";
import { z } from "zod";
import {
  createScopeRateLimiter,
  createTestRunGuard,
  toRetryAfterSeconds,
} from "./llm-auth-guards";

/**
 * Fork: per-user subscription logins (Claude Code `setup-token`, ChatGPT /
 * Codex device auth). Every endpoint acts on the caller's own scope, derived
 * from the authenticated request context; nothing here is system-wide.
 * Tokens and codes are never returned or logged.
 */
export const llmAuthRouter = Router();

const NO_SESSION_PATTERN = /no claude sign-in is waiting/i;
const MAX_SECRET_INPUT_LENGTH = 512;
const MUTATIONS_PER_MINUTE = 20;
const CLAUDE_TEST_COOLDOWN_MS = 30_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const mutationLimiter = createScopeRateLimiter({
  limit: MUTATIONS_PER_MINUTE,
  windowMs: 60_000,
});
const claudeTestGuard = createTestRunGuard({
  cooldownMs: CLAUDE_TEST_COOLDOWN_MS,
});

const codeBodySchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SECRET_INPUT_LENGTH)
    .regex(/^[\x21-\x7e]+$/),
});
const tokenBodySchema = z.object({
  token: z.string().trim().min(1).max(MAX_SECRET_INPUT_LENGTH),
});
const codexStartBodySchema = z
  .object({ forceRestart: z.boolean().optional() })
  .optional();

function assertSubscriptionLoginsAvailable(): void {
  if (getJobOpsAppConfig().appMode === "hosted") {
    throw forbidden("Subscription logins are unavailable in hosted mode.");
  }
}

function blockInDemo(res: Response, route: string): boolean {
  if (!isDemoMode()) return false;
  sendDemoBlocked(res, "Subscription logins are disabled in the public demo.", {
    route,
  });
  return true;
}

function logRouteFailure(route: string, error: unknown): void {
  logger.warn("Subscription login request failed", {
    requestId: getRequestId() ?? null,
    route,
    message: error instanceof Error ? error.message : String(error),
  });
}

function sendTooManyRequests(
  res: Response,
  retryAfterMs: number,
  message: (seconds: number) => string,
): void {
  const seconds = toRetryAfterSeconds(retryAfterMs);
  res.setHeader("Retry-After", String(seconds));
  fail(res, tooManyRequests(message(seconds)));
}

// Per-user rate limit for every state-changing subscription-login request.
llmAuthRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  const retryAfterMs = mutationLimiter.hit(getCliAuthScope().scopeKey);
  if (retryAfterMs === null) {
    next();
    return;
  }
  sendTooManyRequests(
    res,
    retryAfterMs,
    (seconds) => `Too many sign-in requests — try again in ${seconds} seconds.`,
  );
});

/**
 * Best-effort check right after a setup-token sign-in. Never fails the save:
 * a usage limit or a CLI hiccup is reported, not thrown.
 */
async function verifyAfterSignIn(
  scope: CliAuthScope,
): Promise<{ ok: boolean; message: string }> {
  try {
    return await verifyClaudeToken(scope);
  } catch {
    return {
      ok: false,
      message: "Saved, but the Claude login could not be tested right now.",
    };
  }
}

llmAuthRouter.get(
  "/status",
  asyncRoute(async (_req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    ok(res, await getLlmAuthStatus(getCliAuthScope()));
  }),
);

llmAuthRouter.post(
  "/claude/start",
  asyncRoute(async (_req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    if (blockInDemo(res, "POST /api/llm-auth/claude/start")) return;
    const scope = getCliAuthScope();
    try {
      const login = await startClaudeLogin(scope);
      ok(res, await getLlmAuthStatus(scope, { claudeLogin: login }));
    } catch (error) {
      logRouteFailure("POST /api/llm-auth/claude/start", error);
      fail(
        res,
        serviceUnavailable(
          error instanceof ClaudeLoginError
            ? error.message
            : "Could not start Claude sign-in.",
        ),
      );
    }
  }),
);

llmAuthRouter.post(
  "/claude/code",
  asyncRoute(async (req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    if (blockInDemo(res, "POST /api/llm-auth/claude/code")) return;
    const parsed = codeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(
        res,
        badRequest(
          "Enter the code shown on Anthropic's page (one line, no spaces).",
        ),
      );
      return;
    }
    const scope = getCliAuthScope();
    try {
      await submitClaudeLoginCode(scope, parsed.data.code);
    } catch (error) {
      logRouteFailure("POST /api/llm-auth/claude/code", error);
      const message =
        error instanceof ClaudeLoginError
          ? error.message
          : "Code rejected or expired — start again.";
      fail(
        res,
        NO_SESSION_PATTERN.test(message)
          ? conflict(message)
          : badRequest(message),
      );
      return;
    }
    const verification = await verifyAfterSignIn(scope);
    const status = await getLlmAuthStatus(scope);
    ok(res, { ...status, verification });
  }),
);

llmAuthRouter.post(
  "/claude/token",
  asyncRoute(async (req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    if (blockInDemo(res, "POST /api/llm-auth/claude/token")) return;
    const parsed = tokenBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, badRequest("Paste the token printed by `claude setup-token`."));
      return;
    }
    const scope = getCliAuthScope();
    try {
      await saveManualClaudeToken(scope, parsed.data.token);
    } catch (error) {
      // The message never contains the submitted value.
      fail(
        res,
        badRequest(
          error instanceof Error
            ? error.message
            : "That token could not be saved.",
        ),
      );
      return;
    }
    ok(res, await getLlmAuthStatus(scope));
  }),
);

llmAuthRouter.post(
  "/claude/test",
  asyncRoute(async (_req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    if (blockInDemo(res, "POST /api/llm-auth/claude/test")) return;
    const scope = getCliAuthScope();
    const admission = claudeTestGuard.begin(scope.scopeKey);
    if (!admission.ok && admission.reason === "in_flight") {
      fail(
        res,
        conflict("A Claude test is already running — wait for it to finish."),
      );
      return;
    }
    if (!admission.ok) {
      sendTooManyRequests(
        res,
        admission.retryAfterMs,
        (seconds) =>
          `Please wait ${seconds} seconds before testing Claude again.`,
      );
      return;
    }
    try {
      ok(res, await verifyClaudeToken(scope));
    } finally {
      admission.release();
    }
  }),
);

llmAuthRouter.post(
  "/claude/disconnect",
  asyncRoute(async (_req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    if (blockInDemo(res, "POST /api/llm-auth/claude/disconnect")) return;
    const scope = getCliAuthScope();
    cancelClaudeLogin(scope);
    await deleteClaudeToken(scope);
    logger.info("Claude subscription disconnected");
    ok(res, await getLlmAuthStatus(scope));
  }),
);

llmAuthRouter.post(
  "/codex/start",
  asyncRoute(async (req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    if (blockInDemo(res, "POST /api/llm-auth/codex/start")) return;
    const parsed = codexStartBodySchema.safeParse(req.body ?? undefined);
    if (!parsed.success) {
      fail(res, badRequest("forceRestart must be a boolean."));
      return;
    }
    const scope = getCliAuthScope();
    try {
      await startCodexDeviceAuth(parsed.data?.forceRestart === true, scope);
      ok(res, await getLlmAuthStatus(scope));
    } catch (error) {
      logRouteFailure("POST /api/llm-auth/codex/start", error);
      fail(
        res,
        serviceUnavailable(
          error instanceof Error
            ? error.message
            : "Could not start ChatGPT sign-in.",
        ),
      );
    }
  }),
);

llmAuthRouter.post(
  "/codex/disconnect",
  asyncRoute(async (_req: Request, res: Response) => {
    assertSubscriptionLoginsAvailable();
    if (blockInDemo(res, "POST /api/llm-auth/codex/disconnect")) return;
    const scope = getCliAuthScope();
    try {
      await disconnectCodexAuth(scope);
      await resetCodexSession(scope);
      ok(res, await getLlmAuthStatus(scope));
    } catch (error) {
      logRouteFailure("POST /api/llm-auth/codex/disconnect", error);
      fail(
        res,
        serviceUnavailable(
          error instanceof Error
            ? error.message
            : "Could not disconnect ChatGPT right now.",
        ),
      );
    }
  }),
);

// A request without a signed-in Job Ops user has no login scope: 401.
llmAuthRouter.use(
  (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof CliAuthScopeError) {
      fail(res, unauthorized(error.message));
      return;
    }
    next(error);
  },
);
