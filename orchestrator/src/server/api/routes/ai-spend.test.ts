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

  it("returns nulls and empty DeepSeek totals when upstreams are down", async () => {
    stubUpstreams(() => Promise.reject(new Error("offline")));

    const res = await fetch(`${baseUrl}/api/ai-spend`, {
      headers: { Authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.claude).toBeNull();
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

  it("passes the Claude summary through and forwards the auth header", async () => {
    const data = {
      totalUsd: 1,
      monthUsd: 1,
      todayUsd: 0,
      calls: 2,
      unpriced: 0,
      byModel: [],
      since: null,
      credit: null,
    };
    let seenAuth: string | null = null;
    stubUpstreams(async (_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ ok: true, data }));
    });

    const res = await fetch(`${baseUrl}/api/ai-spend`, {
      headers: { Authorization: "Bearer tok" },
    });
    const body = await res.json();
    expect(body.data.claude).toEqual(data);
    expect(seenAuth).toBe("Bearer tok");
  });
});
