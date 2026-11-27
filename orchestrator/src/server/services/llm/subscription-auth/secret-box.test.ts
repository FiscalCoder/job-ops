import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSecretBoxKeyForTests,
  getSecretBoxKeyPath,
  openSecret,
  sealSecret,
} from "./secret-box";

describe("secret box", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "secret-box-"));
    vi.stubEnv("DATA_DIR", dataDir);
    __resetSecretBoxKeyForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSecretBoxKeyForTests();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("seals and opens a secret bound to a context", async () => {
    const sealed = await sealSecret("hello", "scope-a");
    expect(JSON.stringify(sealed)).not.toContain("hello");
    await expect(openSecret(sealed, "scope-a")).resolves.toBe("hello");
  });

  it("refuses to open with a different context", async () => {
    const sealed = await sealSecret("hello", "scope-a");
    await expect(openSecret(sealed, "scope-b")).rejects.toThrow(
      /could not be decrypted/i,
    );
  });

  it("uses a fresh IV per seal", async () => {
    const first = await sealSecret("hello", "scope-a");
    const second = await sealSecret("hello", "scope-a");
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it("persists the key so a restart can still decrypt", async () => {
    const sealed = await sealSecret("hello", "scope-a");
    __resetSecretBoxKeyForTests();
    await expect(openSecret(sealed, "scope-a")).resolves.toBe("hello");
  });

  it("versions the sealed format", async () => {
    const sealed = await sealSecret("hello", "scope-a");
    expect(sealed.v).toBe(2);
  });

  it("still opens secrets sealed in the original v1 format", async () => {
    const key = randomBytes(32);
    vi.stubEnv("JOBOPS_SECRET_KEY", key.toString("base64"));
    const { createCipheriv } = await import("node:crypto");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("scope-a", "utf8"));
    const data = Buffer.concat([
      cipher.update("legacy", "utf8"),
      cipher.final(),
    ]);
    const legacy = {
      v: 1 as const,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    await expect(openSecret(legacy, "scope-a")).resolves.toBe("legacy");
  });

  it("refuses a sealed secret whose version was tampered with", async () => {
    const sealed = await sealSecret("hello", "scope-a");
    await expect(
      openSecret({ ...sealed, v: 1 } as typeof sealed, "scope-a"),
    ).rejects.toThrow(/could not be decrypted/i);
  });

  it("prefers JOBOPS_SECRET_KEY over the key file and never writes a file", async () => {
    vi.stubEnv("JOBOPS_SECRET_KEY", randomBytes(32).toString("base64"));
    const sealed = await sealSecret("hello", "scope-a");
    expect(existsSync(getSecretBoxKeyPath())).toBe(false);
    __resetSecretBoxKeyForTests();
    await expect(openSecret(sealed, "scope-a")).resolves.toBe("hello");
  });

  it("rejects a JOBOPS_SECRET_KEY that is not 32 base64 bytes", async () => {
    vi.stubEnv("JOBOPS_SECRET_KEY", "too-short");
    await expect(sealSecret("hello", "scope-a")).rejects.toThrow(
      /JOBOPS_SECRET_KEY/,
    );
  });

  it("creates the key file atomically and leaves no temp files", async () => {
    await Promise.all([sealSecret("a", "scope-a"), sealSecret("b", "scope-b")]);
    const dir = join(dataDir, "llm-auth");
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
    expect(
      Buffer.from(readFileSync(getSecretBoxKeyPath(), "utf8").trim(), "base64"),
    ).toHaveLength(32);
  });

  it("reuses a key file created by another process", async () => {
    const key = randomBytes(32);
    mkdirSync(join(dataDir, "llm-auth"), { recursive: true });
    writeFileSync(getSecretBoxKeyPath(), `${key.toString("base64")}\n`);
    const sealed = await sealSecret("hello", "scope-a");
    __resetSecretBoxKeyForTests();
    vi.stubEnv("JOBOPS_SECRET_KEY", key.toString("base64"));
    await expect(openSecret(sealed, "scope-a")).resolves.toBe("hello");
  });

  it("retries briefly when the existing key file is still empty", async () => {
    mkdirSync(join(dataDir, "llm-auth"), { recursive: true });
    const path = getSecretBoxKeyPath();
    writeFileSync(path, "");
    const key = randomBytes(32);
    setTimeout(() => writeFileSync(path, key.toString("base64")), 30);
    const sealed = await sealSecret("hello", "scope-a");
    __resetSecretBoxKeyForTests();
    vi.stubEnv("JOBOPS_SECRET_KEY", key.toString("base64"));
    await expect(openSecret(sealed, "scope-a")).resolves.toBe("hello");
  });

  it.skipIf(process.platform === "win32")(
    "stores the key file with mode 0600",
    async () => {
      await sealSecret("hello", "scope-a");
      expect(statSync(getSecretBoxKeyPath()).mode & 0o777).toBe(0o600);
    },
  );
});
