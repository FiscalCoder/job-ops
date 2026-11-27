import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CliAuthScope } from "./scope";
import { openSecret, sealSecret } from "./secret-box";

/**
 * Per-user store for the long-lived Claude subscription token produced by
 * `claude setup-token`. Metadata is readable for status display; the token
 * itself is sealed with AES-256-GCM and is never returned by any API.
 */
export const CLAUDE_TOKEN_LIFETIME_DAYS = 365;
const DAY_MS = 86_400_000;
const TOKEN_FILENAME = "claude-token.json";
const CLAUDE_OAUTH_TOKEN_PATTERN = /^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/;
const MAX_TOKEN_LENGTH = 512;

export type ClaudeTokenSource = "setup-token" | "pasted";

export type ClaudeTokenMetadata = Readonly<{
  createdAt: string;
  expiresAt: string;
  source: ClaudeTokenSource;
}>;

export type StoredClaudeToken = Readonly<{
  token: string;
  metadata: ClaudeTokenMetadata;
}>;

const storedFileSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  source: z.enum(["setup-token", "pasted"]),
  secret: z.object({
    v: z.union([z.literal(1), z.literal(2)]),
    iv: z.string().min(1),
    tag: z.string().min(1),
    data: z.string().min(1),
  }),
});

export function isValidClaudeOauthToken(value: string): boolean {
  return (
    value.length <= MAX_TOKEN_LENGTH && CLAUDE_OAUTH_TOKEN_PATTERN.test(value)
  );
}

export function getClaudeTokenFilePath(scope: CliAuthScope): string {
  return join(scope.baseDir, TOKEN_FILENAME);
}

async function readStoredFile(
  scope: CliAuthScope,
): Promise<z.infer<typeof storedFileSchema> | null> {
  let raw: string;
  try {
    raw = await readFile(getClaudeTokenFilePath(scope), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = storedFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      "The stored Claude login file is unreadable. Disconnect and sign in again.",
    );
  }
  return parsed.data;
}

function toMetadata(
  file: z.infer<typeof storedFileSchema>,
): ClaudeTokenMetadata {
  return {
    createdAt: file.createdAt,
    expiresAt: file.expiresAt,
    source: file.source,
  };
}

export async function saveClaudeToken(
  scope: CliAuthScope,
  token: string,
  options: {
    source: ClaudeTokenSource;
    now?: Date;
    expiresAt?: Date | null;
  },
): Promise<ClaudeTokenMetadata> {
  if (!isValidClaudeOauthToken(token)) {
    throw new Error(
      "That is not a Claude subscription token. It should start with sk-ant-oat and come from `claude setup-token`.",
    );
  }
  const now = options.now ?? new Date();
  const expiresAt =
    options.expiresAt ??
    new Date(now.getTime() + CLAUDE_TOKEN_LIFETIME_DAYS * DAY_MS);
  const metadata: ClaudeTokenMetadata = {
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    source: options.source,
  };
  const secret = await sealSecret(token, scope.scopeKey);
  const body = JSON.stringify({ version: 1, ...metadata, secret });
  const target = getClaudeTokenFilePath(scope);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  } finally {
    // No-op after a successful rename; removes the sealed copy otherwise.
    await rm(temp, { force: true });
  }
  return metadata;
}

export async function readClaudeTokenMetadata(
  scope: CliAuthScope,
): Promise<ClaudeTokenMetadata | null> {
  const file = await readStoredFile(scope);
  return file ? toMetadata(file) : null;
}

export async function loadClaudeToken(
  scope: CliAuthScope,
): Promise<StoredClaudeToken | null> {
  const file = await readStoredFile(scope);
  if (!file) return null;
  const token = await openSecret(file.secret, scope.scopeKey);
  return { token, metadata: toMetadata(file) };
}

export async function deleteClaudeToken(scope: CliAuthScope): Promise<void> {
  await rm(getClaudeTokenFilePath(scope), { force: true });
}
