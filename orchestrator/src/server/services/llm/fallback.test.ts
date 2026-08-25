import { resolveLlmFallbackRuntimeSettings } from "@server/services/modelSelection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callJsonWithFallback } from "./fallback";
import type { LlmService } from "./service";
import type { LlmRequestOptions } from "./types";

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmFallbackRuntimeSettings: vi.fn(),
}));

function fakePrimary(
  result: Awaited<ReturnType<LlmService["callJson"]>>,
): LlmService {
  return {
    callJson: vi.fn().mockResolvedValue(result),
  } as unknown as LlmService;
}

const baseOptions: LlmRequestOptions<{ score: number }> = {
  model: "primary-model",
  messages: [{ role: "user", content: "hi" }],
  jsonSchema: {
    name: "schema",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  jobId: "job-1",
};

describe("callJsonWithFallback", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.mocked(resolveLlmFallbackRuntimeSettings).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the primary result unchanged on success", async () => {
    const primary = fakePrimary({ success: true, data: { score: 90 } });

    const result = await callJsonWithFallback(primary, baseOptions);

    expect(result).toEqual({ success: true, data: { score: 90 } });
    expect(resolveLlmFallbackRuntimeSettings).not.toHaveBeenCalled();
  });

  it("returns the primary failure unchanged for non-429 errors", async () => {
    const primary = fakePrimary({
      success: false,
      error: "bad request",
      status: 400,
    });

    const result = await callJsonWithFallback(primary, baseOptions);

    expect(result).toEqual({
      success: false,
      error: "bad request",
      status: 400,
    });
    expect(resolveLlmFallbackRuntimeSettings).not.toHaveBeenCalled();
  });

  it("returns the primary failure unchanged when no fallback is configured", async () => {
    const primary = fakePrimary({
      success: false,
      error: "rate limited",
      status: 429,
    });
    vi.mocked(resolveLlmFallbackRuntimeSettings).mockResolvedValue(null);

    const result = await callJsonWithFallback(primary, baseOptions);

    expect(result).toEqual({
      success: false,
      error: "rate limited",
      status: 429,
    });
  });

  it("retries through the fallback provider on a 429 and returns its result", async () => {
    const primary = fakePrimary({
      success: false,
      error: "rate limited",
      status: 429,
    });
    vi.mocked(resolveLlmFallbackRuntimeSettings).mockResolvedValue({
      provider: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "fallback-key",
      model: "deepseek-chat",
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ score: 70 }) } }],
      }),
    }) as unknown as typeof fetch;

    const result = await callJsonWithFallback(primary, baseOptions);

    expect(result).toEqual({ success: true, data: { score: 70 } });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain("api.deepseek.com");
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.model).toBe("deepseek-chat");
  });

  it("returns the fallback failure when the fallback provider also fails", async () => {
    const primary = fakePrimary({
      success: false,
      error: "rate limited",
      status: 429,
    });
    vi.mocked(resolveLlmFallbackRuntimeSettings).mockResolvedValue({
      provider: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "fallback-key",
      model: "deepseek-chat",
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    }) as unknown as typeof fetch;

    const result = await callJsonWithFallback(primary, baseOptions);

    expect(result.success).toBe(false);
  });
});
