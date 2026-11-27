import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { withAiPurpose } from "../src/claude/ai-context.js";
import type { MessagesApi } from "../src/claude/answerer.js";
import { ClaudeDailyLimitError, dailyTokenCap } from "../src/claude/daily-cap.js";
import { usageOfMessage } from "../src/claude/pricing.js";
import { subscriptionFirst } from "../src/claude/subscription.js";
import { JobOpsError } from "../src/jobops/client.js";
import { createAiCallStore } from "../src/store/ai-call-store.js";
import { openStore } from "../src/store/db.js";
import { runAsUser } from "../src/store/owner.js";

const apiReply = { id: "api", model: "claude-haiku-5-5" } as Anthropic.Message;
const fallback = (): MessagesApi & { create: ReturnType<typeof vi.fn> } => ({
  create: vi.fn().mockResolvedValue(apiReply),
});
const asUser = <T>(work: () => T, token: string | undefined = "tok") =>
  runAsUser({ id: "u1", ...(token ? { token } : {}) }, work);

const mapParams = {
  model: "claude-haiku-5-5",
  max_tokens: 100,
  system: [{ type: "text", text: "You map questions." }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Q1?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      ],
    },
  ],
  output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object" } } },
} as unknown as Anthropic.MessageCreateParamsNonStreaming;

describe("subscriptionFirst", () => {
  it("sends the call to the user's subscription and returns an unpriced Message with its tokens", async () => {
    const call = vi.fn().mockResolvedValue({
      text: '{"items":[]}',
      usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 100 },
    });
    const api = fallback();
    const reply = await asUser(() =>
      withAiPurpose("map-questions", () =>
        subscriptionFirst({ call, fallback: api }).create(mapParams),
      ),
    );

    expect(call).toHaveBeenCalledWith("tok", {
      model: "claude-haiku-5-5",
      purpose: "map-questions",
      effort: "low",
      system: "You map questions.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Q1?" },
            { type: "image", mediaType: "image/png", data: "AAA" },
          ],
        },
      ],
      schema: { type: "object" },
    });
    expect(api.create).not.toHaveBeenCalled();
    expect(reply.content).toEqual([{ type: "text", text: '{"items":[]}', citations: null }]);
    expect(reply.model).toBe("subscription:claude-haiku-5-5");
    expect(usageOfMessage(reply)).toMatchObject({ inputTokens: 910, outputTokens: 40, cost: null });
  });

  it("unwraps plain-text replies it asked for as {text}", async () => {
    const call = vi.fn().mockResolvedValue({ text: '{"text":"A paragraph."}', usage: null });
    const reply = await asUser(() =>
      subscriptionFirst({ call, fallback: fallback() }).create({
        model: "claude-sonnet-5-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "Draft it" }],
      }),
    );
    expect(call.mock.calls[0]?.[1].schema.required).toEqual(["text"]);
    expect(reply.content).toEqual([{ type: "text", text: "A paragraph.", citations: null }]);
  });

  it("uses the API key for tool calls, without a token, and when the subscription fails", async () => {
    const call = vi.fn().mockRejectedValue(new JobOpsError(503, "SERVICE_UNAVAILABLE", "no login"));
    const api = fallback();
    const sub = subscriptionFirst({ call, fallback: api });
    const plain = { model: "m", max_tokens: 1, messages: [{ role: "user" as const, content: "hi" }] };

    await asUser(() => sub.create({ ...plain, tools: [{ name: "click", input_schema: { type: "object" } }] }));
    expect(call).not.toHaveBeenCalled();
    await asUser(() => sub.create(plain), "");
    expect(call).not.toHaveBeenCalled();
    await expect(asUser(() => sub.create(plain))).resolves.toBe(apiReply);
    expect(call).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledTimes(3);
  });

  it("skips the subscription for a while after a usage limit", async () => {
    let clock = 0;
    const call = vi.fn().mockRejectedValue(new JobOpsError(429, "TOO_MANY_REQUESTS", "limit"));
    const sub = subscriptionFirst({ call, fallback: fallback(), now: () => clock });
    const plain = { model: "m", max_tokens: 1, messages: [{ role: "user" as const, content: "hi" }] };

    await asUser(() => sub.create(plain));
    await asUser(() => sub.create(plain));
    expect(call).toHaveBeenCalledTimes(1);
    clock = 6 * 60_000;
    await asUser(() => sub.create(plain));
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe("dailyTokenCap", () => {
  it("stops calls once today's tokens reach the limit and asks from UTC midnight", async () => {
    const api = fallback();
    const used = vi.fn().mockReturnValueOnce(999).mockReturnValueOnce(1000);
    const capped = dailyTokenCap(api, used, 1000, () => new Date("2026-11-28T15:00:00Z"));
    const plain = { model: "m", max_tokens: 1, messages: [{ role: "user" as const, content: "hi" }] };

    await expect(capped.create(plain)).resolves.toBe(apiReply);
    await expect(capped.create(plain)).rejects.toBeInstanceOf(ClaudeDailyLimitError);
    expect(used).toHaveBeenCalledWith("2026-11-28T00:00:00.000Z");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("counts the signed-in user's logged tokens since a time", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daily-cap-test-"));
    try {
      let at = new Date("2026-11-27T23:00:00Z");
      const calls = createAiCallStore({ db: openStore(":memory:"), dir, now: () => at });
      const log = (user: string, input: number, output: number) =>
        runAsUser(user, () =>
          calls.record({
            context: { purpose: "tell" },
            model: "m",
            request: {},
            usage: { model: "m", inputTokens: input, outputTokens: output, cost: null },
            durationMs: 1,
          }),
        );
      log("u1", 500, 50); // yesterday
      at = new Date("2026-11-28T09:00:00Z");
      log("u1", 300, 20);
      log("u2", 9999, 1);
      expect(runAsUser("u1", () => calls.tokensUsedSince("2026-11-28T00:00:00.000Z"))).toBe(320);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is off at 0", () => {
    const api = fallback();
    expect(dailyTokenCap(api, () => 1e9, 0)).toBe(api);
  });
});
