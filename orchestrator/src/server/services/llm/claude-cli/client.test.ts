import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isConfigurationFailure } from "../policies/configuration-error";
import type { JsonSchemaDefinition } from "../types";
import {
  CLAUDE_CLI_ISOLATION_FLAGS,
  CLAUDE_CLI_SUGGESTED_MODELS,
  ClaudeCliClient,
  type ClaudeCliClientOptions,
} from "./client";
import { ClaudeCliError } from "./errors";

const RUNTIME = {
  env: { HOME: "/scope/home", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
  cwd: "/scope/work",
};

const SCHEMA: JsonSchemaDefinition = {
  name: "t",
  schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

function createMockChild() {
  const stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(),
  });
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
  });
  return { child, stdin, stdout, stderr };
}

/** Spawn mock that replays CLI output once the client has attached. */
function mockCli(output: { stdout?: string; stderr?: string; code?: number }) {
  const mock = createMockChild();
  const spawnFn = vi.fn(() => {
    setImmediate(() => {
      if (output.stdout) mock.stdout.emit("data", Buffer.from(output.stdout));
      if (output.stderr) mock.stderr.emit("data", Buffer.from(output.stderr));
      mock.child.emit("close", output.code ?? 0);
    });
    return mock.child;
  });
  return { ...mock, spawnFn };
}

function successResult(value: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(value),
    structured_output: value,
  });
}

function createClient(
  spawnFn: ReturnType<typeof vi.fn>,
  overrides: Partial<ClaudeCliClientOptions> = {},
) {
  return new ClaudeCliClient({
    spawnFn: spawnFn as unknown as ClaudeCliClientOptions["spawnFn"],
    resolveRuntime: async () => RUNTIME,
    resolveEffort: async () => "medium",
    ...overrides,
  });
}

function spawnCall(spawnFn: ReturnType<typeof vi.fn>) {
  return spawnFn.mock.calls[0] as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv; cwd: string },
  ];
}

describe("ClaudeCliClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suggests the current Claude models", () => {
    expect(CLAUDE_CLI_SUGGESTED_MODELS).toEqual(
      expect.arrayContaining(["claude-haiku-5-5", "claude-sonnet-5-5"]),
    );
  });

  it("validateCredentials succeeds when CLI returns structured_output", async () => {
    const cli = mockCli({ stdout: successResult({ ok: true }) });

    const result = await createClient(cli.spawnFn).validateCredentials();

    expect(result.valid).toBe(true);
    const [, args] = spawnCall(cli.spawnFn);
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  it("validateCredentials fails when CLI reports is_error", async () => {
    const cli = mockCli({
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_auth",
        is_error: true,
        result: "Not authenticated.",
      }),
    });

    const result = await createClient(cli.spawnFn).validateCredentials();
    expect(result.valid).toBe(false);
  });

  it("sends the prompt on stdin with isolation flags, effort, user env and work dir", async () => {
    const cli = mockCli({ stdout: successResult({ value: "from-cli" }) });

    const result = await createClient(cli.spawnFn, {
      resolveEffort: async () => "high",
    }).callJson({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "Score this job please" }],
      jsonSchema: SCHEMA,
    });

    expect(result.text).toBe(JSON.stringify({ value: "from-cli" }));
    const [, args, options] = spawnCall(cli.spawnFn);
    expect(args[0]).toBe("-p");
    expect(args.join(" ")).not.toContain("Score this job please");
    expect(args).toContain("--model");
    expect(args).toContain("claude-haiku-5-5");
    expect(args).toContain("--json-schema");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--system-prompt");
    for (const flag of CLAUDE_CLI_ISOLATION_FLAGS) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(options.env).toEqual(RUNTIME.env);
    expect(options.cwd).toBe(RUNTIME.cwd);

    const stdinInput = cli.stdin.end.mock.calls[0]?.[0] as string;
    expect(stdinInput).toContain("Score this job please");
  });

  it("defaults effort to medium", async () => {
    const cli = mockCli({ stdout: successResult({ value: "x" }) });
    await createClient(cli.spawnFn, {
      resolveEffort: undefined,
    }).callJson({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "Hi" }],
      jsonSchema: SCHEMA,
    });
    const [, args] = spawnCall(cli.spawnFn);
    expect(args[args.indexOf("--effort") + 1]).toMatch(/^(low|medium|high)$/);
  });

  it("does not spawn when the user has no Claude login", async () => {
    const cli = mockCli({ stdout: successResult({ value: "x" }) });
    const client = createClient(cli.spawnFn, {
      resolveRuntime: async () => {
        throw new Error(
          "Claude subscription is not logged in. Connect your Claude subscription in Settings → AI provider.",
        );
      },
    });

    const error = await client
      .callJson({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "Hi" }],
        jsonSchema: SCHEMA,
      })
      .catch((caught: unknown) => caught);

    expect(cli.spawnFn).not.toHaveBeenCalled();
    expect(isConfigurationFailure((error as Error).message)).toBe(true);
  });

  it("maps a usage limit to a 429 error", async () => {
    const cli = mockCli({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Claude AI usage limit reached|1764252000",
      }),
    });

    const error = await createClient(cli.spawnFn)
      .callJson({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "Hi" }],
        jsonSchema: SCHEMA,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeCliError);
    expect((error as ClaudeCliError).status).toBe(429);
  });

  async function failingCall(output: {
    stdout?: string;
    stderr?: string;
    code?: number;
  }): Promise<ClaudeCliError> {
    const cli = mockCli(output);
    return (await createClient(cli.spawnFn)
      .callJson({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "Hi" }],
        jsonSchema: SCHEMA,
      })
      .catch((caught: unknown) => caught)) as ClaudeCliError;
  }

  it("maps a 401 from the CLI error envelope on a non-zero exit", async () => {
    const error = await failingCall({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result:
          'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      }),
      code: 1,
    });
    expect(error.status).toBe(401);
    expect(isConfigurationFailure(error.message)).toBe(true);
  });

  it("does not classify model text from stream events as a usage limit", async () => {
    const error = await failingCall({
      stdout: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "Job: Claude AI usage limit reached; API Error: 429; rate_limit_error; please run /login",
              },
            ],
          },
        }),
      ].join("\n"),
      code: 1,
    });
    expect(error).toBeInstanceOf(ClaudeCliError);
    expect(error.status).toBeUndefined();
    expect(error.message).not.toContain("usage limit");
    expect(isConfigurationFailure(error.message)).toBe(false);
  });

  it("does not classify a non-error result that mentions limits", async () => {
    const error = await failingCall({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "This role mentions API Error: 429 and rate_limit_error",
      }),
      code: 1,
    });
    expect(error.status).toBeUndefined();
  });

  it("does not echo unparseable stdout into the error", async () => {
    const error = await failingCall({
      stdout: "Claude AI usage limit reached? not json",
      code: 0,
    });
    expect(error.status).toBeUndefined();
    expect(error.message).not.toContain("usage limit");
  });

  it("maps an expired login to a configuration failure", async () => {
    const cli = mockCli({
      stderr: "Login expired · Please run /login",
      code: 1,
    });

    const error = await createClient(cli.spawnFn)
      .callJson({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "Hi" }],
        jsonSchema: SCHEMA,
      })
      .catch((caught: unknown) => caught);

    expect(isConfigurationFailure((error as Error).message)).toBe(true);
  });

  it("sends image inputs through stream-json stdin", async () => {
    const cli = mockCli({
      stdout: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { value: "from-image" },
        }),
      ].join("\n"),
    });

    await expect(
      createClient(cli.spawnFn).callJson({
        model: "sonnet",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Review this image" },
              {
                type: "image",
                imageUrl: "data:image/png;base64,aGVsbG8=",
                mediaType: "image/png",
                name: "screenshot.png",
              },
            ],
          },
        ],
        jsonSchema: SCHEMA,
      }),
    ).resolves.toEqual({ text: JSON.stringify({ value: "from-image" }) });

    const [, args] = spawnCall(cli.spawnFn);
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    const payload = JSON.parse(
      (cli.stdin.end.mock.calls[0]?.[0] as string).trim(),
    ) as { message?: { content?: unknown[] } };
    expect(payload.message?.content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
  });

  it("callJson falls back to parsing result when structured_output is absent", async () => {
    const cli = mockCli({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ value: "from-result" }),
      }),
    });

    const result = await createClient(cli.spawnFn).callJson({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "Hi" }],
      jsonSchema: SCHEMA,
    });
    expect(result.text).toBe(JSON.stringify({ value: "from-result" }));
  });
});
