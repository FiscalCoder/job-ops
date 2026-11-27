import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCliAuthRootDir } from "./scope";

/**
 * AES-256-GCM sealing for secrets stored on disk (subscription OAuth tokens).
 * The key comes from `JOBOPS_SECRET_KEY` (base64, 32 bytes) when set,
 * otherwise from `<dataDir>/llm-auth/.secret-key` (0600, created atomically on
 * first use). The `context` (the user's scope key) and the one-byte format
 * version are bound in as additional authenticated data, so a sealed file
 * only opens for the scope and format it was written for.
 */
export type SealedSecret = Readonly<{
  v: 1 | 2;
  iv: string;
  tag: string;
  data: string;
}>;

const KEY_FILENAME = ".secret-key";
const KEY_ENV = "JOBOPS_SECRET_KEY";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";
const CURRENT_VERSION = 2;
const EMPTY_KEY_RETRIES = 10;
const EMPTY_KEY_RETRY_MS = 25;

const keyCache = new Map<string, Buffer>();

export function getSecretBoxKeyPath(): string {
  return join(getCliAuthRootDir(), KEY_FILENAME);
}

function decodeKey(raw: string, source: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${source} must be ${KEY_BYTES} bytes encoded as base64; fix it or delete it and sign in again.`,
    );
  }
  return key;
}

/** Key file contents; `null` when missing, `"empty"` while being written. */
async function readKeyFile(path: string): Promise<Buffer | "empty" | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!raw) return "empty";
    return decodeKey(raw, "The subscription login encryption key file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readExistingKey(path: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt <= EMPTY_KEY_RETRIES; attempt += 1) {
    const key = await readKeyFile(path);
    if (key !== "empty") return key;
    await delay(EMPTY_KEY_RETRY_MS);
  }
  throw new Error(
    "The subscription login encryption key file is empty; delete it and sign in again.",
  );
}

/**
 * Write the key to a private temp file, then hard-link it into place: the
 * link either publishes a complete file or fails with EEXIST (never
 * overwrites a key another process created first).
 */
async function publishNewKey(path: string): Promise<Buffer> {
  const generated = randomBytes(KEY_BYTES);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${generated.toString("base64")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temp, path);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readExistingKey(path);
    if (!raced) throw error;
    return raced;
  } finally {
    await rm(temp, { force: true });
  }
}

async function loadOrCreateFileKey(): Promise<Buffer> {
  const path = getSecretBoxKeyPath();
  const cached = keyCache.get(path);
  if (cached) return cached;

  await mkdir(getCliAuthRootDir(), { recursive: true, mode: 0o700 });
  const key = (await readExistingKey(path)) ?? (await publishNewKey(path));
  keyCache.set(path, key);
  return key;
}

async function loadKey(): Promise<Buffer> {
  const fromEnv = process.env[KEY_ENV]?.trim();
  if (fromEnv) return decodeKey(fromEnv, KEY_ENV);
  return await loadOrCreateFileKey();
}

function buildAad(version: number, context: string): Buffer {
  const contextBytes = Buffer.from(context, "utf8");
  // v1 bound only the context; v2+ prefixes the format version byte.
  return version === 1
    ? contextBytes
    : Buffer.concat([Buffer.from([version]), contextBytes]);
}

export async function sealSecret(
  plaintext: string,
  context: string,
): Promise<SealedSecret> {
  const key = await loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(buildAad(CURRENT_VERSION, context));
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    v: CURRENT_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export async function openSecret(
  sealed: SealedSecret,
  context: string,
): Promise<string> {
  const key = await loadKey();
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAAD(buildAad(sealed.v, context));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "The stored subscription login could not be decrypted. Sign in again.",
    );
  }
}

export function __resetSecretBoxKeyForTests(): void {
  keyCache.clear();
}
