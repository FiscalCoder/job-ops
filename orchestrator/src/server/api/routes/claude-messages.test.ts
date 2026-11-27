import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callJsonMock, recordMock } = vi.hoisted(() => ({
  callJsonMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock("@server/services/llm/claude-cli/client", () => ({
  ClaudeCliClient: vi.fn(function ClaudeCliClient() {
    return { callJson: callJsonMock };
  }),
}));
vi.mock("@server/services/ai-spend/usage-recorder", () => ({
  recordLlmUsageSafely: recordMock,
}));

import { startServer, stopServer } from "./test-utils";

describe.sequential("POST /api/llm/claude-messages", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });
  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  const post = (body: unknown) =>
    fetch(`${baseUrl}/api/llm/claude-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const valid = {
    model: "claude-haiku-5-5",
    purpose: "map-questions",
    effort: "low",
    system: "You map questions.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Q?" },
          { type: "image", mediaType: "image/png", data: "AAA" },
        ],
      },
    ],
    schema: { type: "object" },
  };

  it("runs one CLI call on the caller's login and records its usage", async () => {
    callJsonMock.mockResolvedValue({
      text: '{"ok":true}',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const res = await post(valid);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      text: '{"ok":true}',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(callJsonMock).toHaveBeenCalledWith({
      model: "claude-haiku-5-5",
      messages: [
        { role: "system", content: "You map questions." },
        {
          role: "user",
          content: [
            { type: "text", text: "Q?" },
            {
              type: "image",
              imageUrl: "data:image/png;base64,AAA",
              mediaType: "image/png",
            },
          ],
        },
      ],
      jsonSchema: { name: "apply_map-questions", schema: { type: "object" } },
    });
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude_cli",
        feature: "apply:map-questions",
      }),
    );
  });

  it("rejects a malformed body and reports usage limits as 429", async () => {
    expect((await post({ ...valid, messages: [] })).status).toBe(400);

    callJsonMock.mockRejectedValue(
      Object.assign(new Error("usage limit"), { status: 429 }),
    );
    expect((await post(valid)).status).toBe(429);

    callJsonMock.mockRejectedValue(new Error("Claude login required"));
    expect((await post(valid)).status).toBe(503);
  });
});
