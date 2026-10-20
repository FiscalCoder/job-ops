import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import type { JobOpsApi } from "../src/jobops/client.js";
import { JobOpsError } from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

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
    markApplied: async () => {},
    skipJob: async () => {},
    getDesignResume: async () => fakeDesignResume,
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

  it("returns the answer-bank catalogue with your saved values, plus custom keys", async () => {
    const { call } = await start();
    const put = await call("/answer-bank/work.notice_period", {
      method: "PUT",
      token: "good",
      body: JSON.stringify({ value: "30 days" }),
    });
    expect(put.status).toBe(200);
    await call("/answer-bank/custom.thing", {
      method: "PUT",
      token: "good",
      body: JSON.stringify({ value: "x" }),
    });
    const { data } = await (
      await call("/answer-bank", { token: "good" })
    ).json();
    const notice = data.keys.find(
      (k: { key: string }) => k.key === "work.notice_period",
    );
    expect(notice).toMatchObject({
      label: "Notice period (days)",
      group: "Work authorisation",
      protected: true,
      value: "30",
    });
    const city = data.keys.find(
      (k: { key: string }) => k.key === "location.current_city",
    );
    expect(city).toMatchObject({ value: null, protected: false });
    expect(data.custom).toEqual([
      expect.objectContaining({ key: "custom.thing", value: "x" }),
    ]);
  });

  it("always stores catalogue-protected keys as protected", async () => {
    const { call } = await start();
    const res = await call("/answer-bank/comp.expected", {
      method: "PUT",
      token: "good",
      body: JSON.stringify({ value: "30 LPA", isProtected: false }),
    });
    expect((await res.json()).data).toMatchObject({ isProtected: true });
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

  it("serves the web page with a strict content security policy", async () => {
    const { call } = await start();
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("<title>Apply Assistant</title>");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const script = await call("/app.js");
    expect(script.headers.get("content-type")).toMatch(/javascript/);
  });

  it("slows down repeated failed sign-ins", async () => {
    const { call } = await start();
    const attempt = () =>
      call("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "me", password: "wrong" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      ok: false,
      error: { code: "TOO_MANY_ATTEMPTS" },
    });
  });

  it("normalises answers to their field's format when saving", async () => {
    const { call } = await start();
    const save = (key: string, value: string) =>
      call(`/answer-bank/${key}`, {
        method: "PUT",
        token: "good",
        body: JSON.stringify({ value }),
      });
    await save("location.current_country", "India");
    expect(
      (await (await save("comp.current", "3000000")).json()).data.value,
    ).toBe("INR 3000000");
    expect(
      (await (await save("work.notice_period", "1 month")).json()).data.value,
    ).toBe("30");
    expect(
      (await (await save("work.earliest_start_date", "20/11/2026")).json()).data
        .value,
    ).toBe("2026-11-20");
    const bad = await save("work.earliest_start_date", "soon");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ANSWER",
        message: expect.stringContaining("YYYY-MM-DD"),
      },
    });
  });

  it("returns each field's format with the catalogue", async () => {
    const { call } = await start();
    const { data } = await (
      await call("/answer-bank", { token: "good" })
    ).json();
    const notice = data.keys.find(
      (k: { key: string }) => k.key === "work.notice_period",
    );
    expect(notice).toMatchObject({ kind: "days", example: "30" });
  });
});
