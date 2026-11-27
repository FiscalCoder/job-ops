import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "@infra/logger";
import {
  extractClaudeOauthToken,
  extractCliErrorMessage,
  extractSignInUrl,
  extractTokenLifetimeMs,
  hasCodePrompt,
  hasCodeRejection,
} from "./claude-login-output";
import {
  createOutputBuffer,
  type OutputBuffer,
  type SetupTokenSpawnDeps,
  spawnSetupToken,
  terminateSetupToken,
  usesProcessGroup,
  waitForEvents,
} from "./claude-login-process";
import {
  type ClaudeTokenMetadata,
  saveClaudeToken,
} from "./claude-token-store";
import type { CliAuthScope } from "./scope";

/**
 * Per-user `claude setup-token` sessions. The code Anthropic shows after
 * sign-in must be typed into the SAME process (a new process starts a new
 * PKCE flow), so each user gets one long-running process kept here until the
 * code arrives, then it is killed. URLs, codes and tokens are never logged.
 */
export type ClaudeLoginStatus =
  | "starting"
  | "awaiting_code"
  | "submitting"
  | "failed"
  | "expired";

export type ClaudeLoginSnapshot = Readonly<{
  status: ClaudeLoginStatus;
  signInUrl: string | null;
  startedAt: string;
  expiresAt: string;
  message: string | null;
}>;

export type ClaudeLoginTimeouts = {
  startMs: number;
  codeMs: number;
  idleMs: number;
  /** Wait this long for a token after a rejection phrase before failing. */
  rejectGraceMs?: number;
  /** How long a failed/expired session stays visible before it is dropped. */
  terminalTtlMs?: number;
};

export type ClaudeLoginDeps = SetupTokenSpawnDeps & {
  timeouts?: ClaudeLoginTimeouts;
};

export class ClaudeLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeLoginError";
  }
}

const CODE_REJECTED_MESSAGE = "Code rejected or expired — start again.";
const NO_SESSION_MESSAGE =
  "No Claude sign-in is waiting for a code — start again.";
const MAX_CODE_LENGTH = 512;
const TOO_MANY_SESSIONS_MESSAGE =
  "Too many sign-ins in progress, try again shortly";
const PROMPT_GRACE_MS = 1_500;
/** Pause between typing the code and pressing Enter. */
const ENTER_DELAY_MS = 250;
/** `claude setup-token` announces a "long-lived (1-year)" token up front. */
const SETUP_TOKEN_LIFETIME_MS = 365 * 86_400_000;
const DEFAULT_REJECT_GRACE_MS = 3_000;
const DEFAULT_TERMINAL_TTL_MS = 300_000;
const DEFAULT_MAX_SESSIONS = 5;
const ACTIVE_STATUSES = new Set<ClaudeLoginStatus>([
  "starting",
  "awaiting_code",
  "submitting",
]);

type Session = Readonly<{
  status: ClaudeLoginStatus;
  proc: ChildProcessWithoutNullStreams | null;
  startedAtMs: number;
  expiresAtMs: number;
  signInUrl: string | null;
  message: string | null;
  output: OutputBuffer;
  events: EventEmitter;
  idleTimer: NodeJS.Timeout | null;
  /** Linux: the process runs in its own group, stopped as a whole. */
  group: boolean;
  terminalTtlMs: number;
}>;

const sessions = new Map<string, Session>();
const pendingStarts = new Map<string, Promise<ClaudeLoginSnapshot>>();

function getPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTimeouts(deps: ClaudeLoginDeps): Required<ClaudeLoginTimeouts> {
  const base = deps.timeouts ?? {
    startMs: getPositiveIntEnv("CLAUDE_SETUP_TOKEN_START_TIMEOUT_MS", 30_000),
    codeMs: getPositiveIntEnv("CLAUDE_SETUP_TOKEN_CODE_TIMEOUT_MS", 60_000),
    idleMs: getPositiveIntEnv("CLAUDE_SETUP_TOKEN_IDLE_TIMEOUT_MS", 600_000),
  };
  return {
    rejectGraceMs: DEFAULT_REJECT_GRACE_MS,
    terminalTtlMs: DEFAULT_TERMINAL_TTL_MS,
    ...base,
  };
}

/** Failed/expired sessions are kept briefly for status display, then dropped. */
function terminalPatch(
  session: Session,
  status: "failed" | "expired",
  message: string,
): Partial<Session> {
  return {
    status,
    proc: null,
    idleTimer: null,
    message,
    expiresAtMs: Date.now() + session.terminalTtlMs,
  };
}

function pruneSessions(now: number = Date.now()): void {
  for (const [key, session] of sessions) {
    if (!ACTIVE_STATUSES.has(session.status) && session.expiresAtMs <= now) {
      sessions.delete(key);
    }
  }
}

function assertSessionCapacity(key: string): void {
  const max = getPositiveIntEnv(
    "CLAUDE_SETUP_TOKEN_MAX_SESSIONS",
    DEFAULT_MAX_SESSIONS,
  );
  const activeKeys = new Set(pendingStarts.keys());
  for (const [sessionKey, session] of sessions) {
    if (ACTIVE_STATUSES.has(session.status)) activeKeys.add(sessionKey);
  }
  activeKeys.delete(key);
  if (activeKeys.size >= max) {
    throw new ClaudeLoginError(TOO_MANY_SESSIONS_MESSAGE);
  }
}

function toSnapshot(session: Session): ClaudeLoginSnapshot {
  return {
    status: session.status,
    signInUrl: session.signInUrl,
    startedAt: new Date(session.startedAtMs).toISOString(),
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    message: session.message,
  };
}

function updateSession(key: string, patch: Partial<Session>): Session | null {
  const current = sessions.get(key);
  if (!current) return null;
  const next = { ...current, ...patch };
  sessions.set(key, next);
  return next;
}

function stopProcess(session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.proc && !session.proc.killed) {
    terminateSetupToken(session.proc, { group: session.group });
  }
}

function attachProcess(key: string, session: Session): void {
  const proc = session.proc;
  if (!proc) return;
  const onData = (chunk: Buffer | string) => {
    session.output.append(
      typeof chunk === "string" ? chunk : chunk.toString("utf8"),
    );
    session.events.emit("output");
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  // Writing to a CLI that just exited raises EPIPE; the exit handler covers it.
  proc.stdin.on("error", () => undefined);
  proc.once("error", () => {
    session.events.emit("exit");
  });
  proc.once("exit", () => {
    const current = sessions.get(key);
    if (current?.proc === proc && ACTIVE_STATUSES.has(current.status)) {
      if (current.idleTimer) clearTimeout(current.idleTimer);
      updateSession(
        key,
        terminalPatch(
          current,
          "failed",
          "Claude sign-in ended before it finished — start again.",
        ),
      );
    }
    session.events.emit("exit");
  });
}

function scheduleIdleKill(key: string, idleMs: number): NodeJS.Timeout {
  const timer = setTimeout(() => {
    const current = sessions.get(key);
    if (!current || !ACTIVE_STATUSES.has(current.status)) return;
    stopProcess(current);
    updateSession(
      key,
      terminalPatch(
        current,
        "expired",
        "Claude sign-in timed out — start again.",
      ),
    );
    logger.info("Claude subscription sign-in expired (idle)");
  }, idleMs);
  timer.unref?.();
  return timer;
}

async function waitForSignInUrl(
  key: string,
  session: Session,
  startMs: number,
): Promise<ClaudeLoginSnapshot> {
  let urlSeenAt: number | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  const fail = () =>
    new ClaudeLoginError(
      "Claude CLI did not show a sign-in link. Check that the Claude CLI is installed, or paste a token from `claude setup-token` instead.",
    );
  const url = await waitForEvents<string | Error>(
    session.events,
    startMs,
    (exited) => {
      const output = session.output.all();
      const found = extractSignInUrl(output);
      if (found && urlSeenAt === null) {
        urlSeenAt = Date.now();
        // The CLI goes quiet after the prompt, so re-check once the grace
        // has passed instead of waiting for output that never comes.
        graceTimer = setTimeout(
          () => session.events.emit("output"),
          PROMPT_GRACE_MS + 50,
        );
        graceTimer.unref?.();
      }
      const graceOver =
        urlSeenAt !== null && Date.now() - urlSeenAt > PROMPT_GRACE_MS;
      if (exited) return { done: true, value: fail() };
      if (found && (hasCodePrompt(output) || graceOver)) {
        return { done: true, value: found };
      }
      return { done: false };
    },
    () => extractSignInUrl(session.output.all()) ?? fail(),
  ).finally(() => {
    if (graceTimer) clearTimeout(graceTimer);
  });
  if (url instanceof Error) throw url;
  const next = updateSession(key, {
    status: "awaiting_code",
    signInUrl: url,
    message: "Sign in on Anthropic's page, then paste the code it shows.",
  });
  if (!next) throw new ClaudeLoginError(NO_SESSION_MESSAGE);
  return toSnapshot(next);
}

export function getClaudeLoginSnapshot(
  scope: CliAuthScope,
): ClaudeLoginSnapshot | null {
  pruneSessions();
  const session = sessions.get(scope.scopeKey);
  return session ? toSnapshot(session) : null;
}

export async function startClaudeLogin(
  scope: CliAuthScope,
  deps: ClaudeLoginDeps = {},
): Promise<ClaudeLoginSnapshot> {
  const key = scope.scopeKey;
  const pending = pendingStarts.get(key);
  if (pending) return await pending;
  pruneSessions();
  const existing = sessions.get(key);
  if (existing && ACTIVE_STATUSES.has(existing.status)) {
    return toSnapshot(existing);
  }
  assertSessionCapacity(key);
  if (existing) sessions.delete(key);

  const timeouts = resolveTimeouts(deps);
  const now = Date.now();
  const session: Session = {
    status: "starting",
    proc: spawnSetupToken(scope, deps),
    startedAtMs: now,
    expiresAtMs: now + timeouts.idleMs,
    signInUrl: null,
    message: null,
    output: createOutputBuffer(),
    events: new EventEmitter(),
    idleTimer: scheduleIdleKill(key, timeouts.idleMs),
    group: usesProcessGroup(deps),
    terminalTtlMs: timeouts.terminalTtlMs,
  };
  sessions.set(key, session);
  attachProcess(key, session);
  logger.info("Claude subscription sign-in started");

  const startPromise = waitForSignInUrl(key, session, timeouts.startMs);
  pendingStarts.set(key, startPromise);
  try {
    return await startPromise;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Claude sign-in failed.";
    stopProcess(session);
    updateSession(key, terminalPatch(session, "failed", message));
    logger.warn("Claude subscription sign-in failed to start");
    throw error instanceof ClaudeLoginError
      ? error
      : new ClaudeLoginError(message);
  } finally {
    pendingStarts.delete(key);
  }
}

export function validateLoginCode(raw: string): string {
  const code = raw.trim();
  if (!code || code.length > MAX_CODE_LENGTH || !/^[\x21-\x7e]+$/.test(code)) {
    throw new ClaudeLoginError(
      "Enter the code shown on Anthropic's page (one line, no spaces).",
    );
  }
  return code;
}

/** Rejection text for the UI, with the CLI's own reason when it gave one. */
function rejectionMessage(cliReason: string | null): string {
  return cliReason
    ? `${CODE_REJECTED_MESSAGE} Claude said: ${cliReason} Use the code from the newest sign-in link only.`
    : CODE_REJECTED_MESSAGE;
}

/**
 * Type the code like a person would: the characters first, then Enter as its
 * own keystroke, so the CLI's input box reads Enter as "submit" rather than as
 * part of a pasted string. Skips Enter when the process has already ended.
 */
async function typeCode(
  proc: ChildProcessWithoutNullStreams,
  code: string,
): Promise<void> {
  proc.stdin.write(code);
  await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS));
  if (proc.exitCode == null && !proc.killed && proc.stdin.writable) {
    proc.stdin.write("\r");
  }
}

/**
 * Wait for the token after a code was typed. Rejected only when the process
 * exits without a token, or when a known rejection phrase appears and no
 * token follows within `rejectGraceMs` (the CLI may print transient errors
 * while it retries the exchange).
 */
async function waitForToken(
  session: Session,
  timeouts: Required<ClaudeLoginTimeouts>,
): Promise<string> {
  const rejected = () =>
    new ClaudeLoginError(
      rejectionMessage(extractCliErrorMessage(session.output.sinceMark())),
    );
  let rejectionSeenAt: number | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  const startGrace = () => {
    rejectionSeenAt = Date.now();
    graceTimer = setTimeout(
      () => session.events.emit("output"),
      timeouts.rejectGraceMs,
    );
    graceTimer.unref?.();
  };
  try {
    const result = await waitForEvents<string | Error>(
      session.events,
      timeouts.codeMs,
      (exited) => {
        const output = session.output.sinceMark();
        const token = extractClaudeOauthToken(output);
        if (token) return { done: true, value: token };
        if (exited) return { done: true, value: rejected() };
        if (rejectionSeenAt === null && hasCodeRejection(output)) startGrace();
        const graceOver =
          rejectionSeenAt !== null &&
          Date.now() - rejectionSeenAt >= timeouts.rejectGraceMs;
        return graceOver ? { done: true, value: rejected() } : { done: false };
      },
      rejected,
    );
    if (result instanceof Error) throw result;
    return result;
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
  }
}

export async function submitClaudeLoginCode(
  scope: CliAuthScope,
  rawCode: string,
  deps: ClaudeLoginDeps = {},
): Promise<{ status: "connected"; metadata: ClaudeTokenMetadata }> {
  const key = scope.scopeKey;
  const session = sessions.get(key);
  if (!session || session.status !== "awaiting_code" || !session.proc) {
    throw new ClaudeLoginError(NO_SESSION_MESSAGE);
  }
  const code = validateLoginCode(rawCode);
  const timeouts = resolveTimeouts(deps);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const submitting = updateSession(key, {
    status: "submitting",
    message: null,
    idleTimer: scheduleIdleKill(key, timeouts.idleMs),
  });
  if (!submitting) throw new ClaudeLoginError(NO_SESSION_MESSAGE);

  submitting.output.mark();
  const tokenPromise = waitForToken(submitting, timeouts);
  // Handled by the await below; this only stops an early rejection (the CLI
  // exiting while the code is being typed) from counting as unhandled.
  tokenPromise.catch(() => undefined);
  if (submitting.proc) await typeCode(submitting.proc, code);
  try {
    const token = await tokenPromise;
    const lifetimeMs =
      extractTokenLifetimeMs(submitting.output.sinceMark()) ??
      SETUP_TOKEN_LIFETIME_MS;
    const metadata = await saveClaudeToken(scope, token, {
      source: "setup-token",
      expiresAt: new Date(Date.now() + lifetimeMs),
    });
    stopProcess(submitting);
    sessions.delete(key);
    logger.info("Claude subscription connected via setup-token");
    return { status: "connected", metadata };
  } catch (error) {
    const current = sessions.get(key) ?? submitting;
    stopProcess(current);
    const message =
      error instanceof ClaudeLoginError ? error.message : CODE_REJECTED_MESSAGE;
    updateSession(key, terminalPatch(current, "failed", message));
    // The CLI's reason is redacted of code/token-like runs; safe to log.
    logger.warn("Claude subscription code submission failed", {
      cliReason: extractCliErrorMessage(current.output.sinceMark()),
      sawTokenPrefix: current.output.sinceMark().includes("sk-ant-oat"),
    });
    throw new ClaudeLoginError(message);
  }
}

export function cancelClaudeLogin(scope: CliAuthScope): void {
  const session = sessions.get(scope.scopeKey);
  if (!session) return;
  stopProcess(session);
  sessions.delete(scope.scopeKey);
}

export async function saveManualClaudeToken(
  scope: CliAuthScope,
  rawToken: string,
): Promise<ClaudeTokenMetadata> {
  const metadata = await saveClaudeToken(scope, rawToken.trim(), {
    source: "pasted",
  });
  cancelClaudeLogin(scope);
  logger.info("Claude subscription connected via pasted token");
  return metadata;
}

export function __resetClaudeLoginsForTests(): void {
  for (const session of sessions.values()) stopProcess(session);
  sessions.clear();
  pendingStarts.clear();
}
