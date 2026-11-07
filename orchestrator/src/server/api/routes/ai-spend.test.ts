import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("GET /api/ai-spend", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await stopServer({ server, closeDb, tempDir });
  });

  function stubUpstreams(
    handler: (url: string, init?: RequestInit) => Promise<Response>,
  ): void {
    const realFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        return url.startsWith(baseUrl)
          ? realFetch(input, init)
          : handler(url, init);
      }),
    );
  }

  it("returns empty DeepSeek totals and no balance when DeepSeek is unreachable", async () => {
    stubUpstreams(() => Promise.reject(new Error("offline")));

    const res = await fetch(`${baseUrl}/api/ai-spend`, {
      headers: { Authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).not.toHaveProperty("claude");
    expect(body.data.deepseek).toMatchObject({
      trackedUsd: 0,
      monthUsd: 0,
      todayUsd: 0,
      calls: 0,
      since: null,
      byFeature: [],
      balance: null,
    });
  });
});
