import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getTenantId, getUserId } from "@infra/request-context";
import { getDataDir } from "@server/config/dataDir";

/**
 * Per-user home for subscription CLI logins (Claude Code, Codex). Every path
 * is derived from the authenticated server request context only, so one
 * user's login can never be picked up by another user's jobs.
 */
export type CliAuthScope = Readonly<{
  scopeKey: string;
  baseDir: string;
  claudeDir: string;
  codexHome: string;
  homeDir: string;
  workDir: string;
}>;

export class CliAuthScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliAuthScopeError";
  }
}

const SCOPE_ROOT_DIRNAME = "llm-auth";
const PRIVATE_DIR_MODE = 0o700;

export function getCliAuthRootDir(): string {
  return join(getDataDir(), SCOPE_ROOT_DIRNAME);
}

function hashScope(tenantId: string, userId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([tenantId, userId]))
    .digest("hex");
}

export function resolveCliAuthScopePaths(
  tenantId: string,
  userId: string,
): CliAuthScope {
  const scopeKey = hashScope(tenantId, userId);
  const baseDir = join(getCliAuthRootDir(), scopeKey);
  return Object.freeze({
    scopeKey,
    baseDir,
    claudeDir: join(baseDir, "claude"),
    codexHome: join(baseDir, "codex"),
    homeDir: join(baseDir, "home"),
    workDir: join(baseDir, "work"),
  });
}

function ensurePrivateDirs(scope: CliAuthScope): void {
  for (const dir of [
    scope.baseDir,
    scope.claudeDir,
    scope.codexHome,
    scope.homeDir,
    scope.workDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
}

/**
 * Resolve the current user's CLI login scope and make sure its directories
 * exist. Throws when the request has no tenant + user: there is deliberately
 * no default tenant fallback here.
 */
export function getCliAuthScope(): CliAuthScope {
  const tenantId = getTenantId()?.trim();
  const userId = getUserId()?.trim();
  if (!tenantId || !userId) {
    throw new CliAuthScopeError(
      "Subscription logins need a signed-in Job Ops user; no user context was found for this request.",
    );
  }
  const scope = resolveCliAuthScopePaths(tenantId, userId);
  ensurePrivateDirs(scope);
  return scope;
}

/** Server env variables a CLI child process may inherit (matched upper-case). */
const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "SHELL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  // Windows essentials so local development can still spawn the CLIs.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

const ALLOWED_ENV_PREFIXES = ["LC_", "NODE_"];

/** Never passed to a CLI child, whatever the source. */
const ALWAYS_BLOCKED_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "CODEX_ACCESS_TOKEN",
]);

function isAllowedServerEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (ALWAYS_BLOCKED_ENV_KEYS.has(upper)) return false;
  return (
    ALLOWED_ENV_KEYS.has(upper) ||
    ALLOWED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/**
 * Build a child-process env from an allow-list of server variables, with
 * HOME / config dirs pointed at the user's scope. `extra` is added last (for
 * example the user's own CLAUDE_CODE_OAUTH_TOKEN), but API-key style
 * variables that would override subscription auth are always dropped.
 */
export function buildCliEnv(
  scope: CliAuthScope,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && isAllowedServerEnvKey(entry[0]),
    ),
  );
  const scoped = {
    HOME: scope.homeDir,
    USERPROFILE: scope.homeDir,
    XDG_CONFIG_HOME: scope.homeDir,
    CLAUDE_CONFIG_DIR: scope.claudeDir,
    CODEX_HOME: scope.codexHome,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const safeExtra = Object.fromEntries(
    Object.entries(extra).filter(
      ([key]) => !ALWAYS_BLOCKED_ENV_KEYS.has(key.toUpperCase()),
    ),
  );
  return { ...inherited, ...scoped, ...safeExtra };
}
