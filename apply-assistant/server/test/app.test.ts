import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import type { JobOpsApi } from "../src/jobops/client.js";
import { JobOpsError } from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";

function fakeJobOps(overrides: Partial<JobOpsApi> = {}): JobOpsApi {
  return {
    login: async (username, password) => {
      if (username === "me" && password === "pw")
        return { token: "good", expiresIn: 3600 };
      throw new JobOpsError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    },
    me: async (token) => {
      if (token === "good") return { id: "u1", username: "me" };
      throw new JobOpsError(401, "UNAUTHORIZED", "Authentication required");
    },
    listJobs: async () => ({ jobs: [], total: 0, revision: "r0" }),
    getJob: async () => {
      throw new JobOpsError(404, "NOT_FOUND", "Job not found");
    },
    updateJob: async () => undefined,
    addNote: async () => undefined,
    getPdf: async () => new Uint8Array(),
    ...overrides,
  };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(jobOps: JobOpsApi = fakeJobOps()) {
  const app = createApp({
    jobOps,
    db: openStore(":memory:"),
    authCacheSeconds: 60,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit & { token?: string } = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    });
  return { call };
}

describe("apply-assistant HTTP app", () => {
  it("reports health without auth", async () => {
    const { call } = await start();
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      data: { status: "ok" },
    });
  });

  it("proxies login to Job Ops and returns its token", async () => {
    const { call } = await start();
    const res = await call("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "me", password: "pw" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      data: { token: "good" },
    });
  });

  it("passes a Job Ops login failure through as 401", async () => {
    const { call } = await start();
    const res = await call("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "me", password: "no" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_CREDENTIALS" },
    });
  });

  it("rejects a malformed login body with 400", async () => {
    const { call } = await start();
    const res = await call("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires a valid Job Ops token on protected routes", async () => {
    const { call } = await start();
    expect((await call("/answer-bank")).status).toBe(401);
    expect((await call("/answer-bank", { token: "bad" })).status).toBe(401);
    expect((await call("/answer-bank", { token: "good" })).status).toBe(200);
  });

  it("caches token checks so Job Ops isn't called on every request", async () => {
    let meCalls = 0;
    const base = fakeJobOps();
    const { call } = await start({
      ...base,
      me: async (t) => {
        meCalls++;
        return base.me(t);
      },
    });
    await call("/answer-bank", { token: "good" });
    await call("/answer-bank", { token: "good" });
    expect(meCalls).toBe(1);
  });

  it("stores and returns answer bank entries", async () => {
    const { call } = await start();
    const put = await call("/answer-bank/notice_period", {
      method: "PUT",
      token: "good",
      body: JSON.stringify({ value: "30 days, negotiable", isProtected: true }),
    });
    expect(put.status).toBe(200);
    const list = await (await call("/answer-bank", { token: "good" })).json();
    expect(list).toMatchObject({
      ok: true,
      data: [
        {
          key: "notice_period",
          value: "30 days, negotiable",
          isProtected: true,
        },
      ],
    });
  });

  it("validates answer bank input", async () => {
    const { call } = await start();
    const res = await call("/answer-bank/notice_period", {
      method: "PUT",
      token: "good",
      body: JSON.stringify({ value: 5 }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 502 with a clear message when Job Ops is unreachable", async () => {
    const { call } = await start(
      fakeJobOps({
        me: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    const res = await call("/answer-bank", { token: "good" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "JOBOPS_UNREACHABLE" },
    });
  });
});
