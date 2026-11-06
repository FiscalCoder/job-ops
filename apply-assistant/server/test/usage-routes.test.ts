import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { type JobOpsApi, JobOpsError, type JobOpsJob } from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { createRunsRepo } from "../src/store/runs-repo.js";
import { createTraceStore } from "../src/store/trace-store.js";
import { createUserSettingsRepo } from "../src/store/user-settings-repo.js";
import { backfillRunCosts, createSpendService } from "../src/usage/spend-service.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

const USERS = {
  me: { id: "u-me", username: "me", isSystemAdmin: false },
  other: { id: "u-other", username: "other", isSystemAdmin: false },
} as const;

const job: JobOpsJob = {
  id: "job-1",
  title: "Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://jobs.test/1",
  applicationLink: null,
  suitabilityScore: 80,
};

const jobOps: JobOpsApi = {
  login: async () => ({ token: "me", expiresIn: 3600 }),
  me: async (token) => {
    const user = USERS[token as keyof typeof USERS];
    if (!user) throw new JobOpsError(401, "UNAUTHORIZED", "nope");
    return user;
  },
  listJobs: async () => ({ jobs: [job], total: 1, revision: "r" }),
  getJob: async () => ({ ...job, location: null, jobDescription: "x" }),
  updateJob: async () => {},
  addNote: async () => {},
  markApplied: async () => {},
  skipJob: async () => {},
  getPdf: async () => new Uint8Array(),
  getDesignResume: async () => fakeDesignResume,
};

let close: (() => void) | undefined;
const dirs: string[] = [];
afterEach(() => {
  close?.();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start() {
  const db = openStore(":memory:");
  const dir = mkdtempSync(path.join(tmpdir(), "usage-test-"));
  dirs.push(dir);
  const trace = createTraceStore({ db, dir });
  const insertUsage = db.prepare(
    "insert into trace_events (user_id, job_id, ts, source, kind, message, data_json) values (?, 'job-1', ?, 'server', 'claude-usage', 'Claude', ?)",
  );
  const add = (user: string, ts: string, cost: number | null, model = "claude-sonnet-5-5") => {
    insertUsage.run(user, ts, JSON.stringify({ model, inputTokens: 1, outputTokens: 1, cost }));
  };
  const server = createApp({ jobOps, db, authCacheSeconds: 60, trace }).listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as =
    (who: keyof typeof USERS) =>
    async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${who}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
  const addRun = (user: string, id: string, start: string, end: string | null) =>
    db
      .prepare(
        "insert into runs (id, user_id, job_id, started_at, ended_at, outcome) values (?, ?, 'job-1', ?, ?, ?)",
      )
      .run(id, user, start, end, end ? "aborted" : null);
  return { db, trace, add, addRun, me: as("me"), other: as("other") };
}

describe("GET /runs/:runId/cost", () => {
  it("sums the run's Claude calls, including planning just before it", async () => {
    const t = await start();
    t.addRun("u-me", "r1", "2026-11-05 22:50:14", "2026-11-05 22:55:00");
    t.add("u-me", "2026-11-05T22:50:09.307Z", 0.01, "claude-haiku-5-5");
    t.add("u-me", "2026-11-05T22:51:00.000Z", 0.0666666);
    t.add("u-me", "2026-11-05T22:52:00.000Z", null);
    t.add("u-me", "2026-11-05T23:30:00.000Z", 5); // after the run: not its
    const res = await t.me("GET", "/runs/r1/cost");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      data: {
        runId: "r1",
        jobId: "job-1",
        costUsd: 0.0767,
        calls: 3,
        unpriced: 1,
        byModel: [
          { model: "claude-sonnet-5-5", costUsd: 0.0667, calls: 2 },
          { model: "claude-haiku-5-5", costUsd: 0.01, calls: 1 },
        ],
      },
    });
  });

  it("is 404 for a run that is not yours, or none", async () => {
    const t = await start();
    t.addRun("u-other", "r-theirs", "2026-11-05 22:50:14", null);
    expect((await t.me("GET", "/runs/r-theirs/cost")).status).toBe(404);
    expect((await t.me("GET", "/runs/missing/cost")).status).toBe(404);
    expect((await t.other("GET", "/runs/r-theirs/cost")).status).toBe(200);
  });
});

describe("storing a run's cost", () => {
  it("fills runs.model_cost when the run completes", async () => {
    const t = await start();
    const created = await t.me("POST", "/runs", { jobId: "job-1" });
    const runId = created.body.data.id as string;
    const startedAt = created.body.data.startedAt as string;
    t.add("u-me", `${startedAt.replace(" ", "T")}.500Z`, 0.25);
    expect((await t.me("POST", `/runs/${runId}/complete`, { outcome: "aborted" })).status).toBe(200);
    const row = t.db.prepare("select model_cost from runs where id = ?").get(runId) as { model_cost: number };
    expect(row.model_cost).toBe(0.25);
  });

  it("backfills ended runs still at 0, and a second pass does nothing", async () => {
    const t = await start();
    t.addRun("u-me", "old", "2026-11-05 22:50:14", "2026-11-05 22:55:00");
    t.add("u-me", "2026-11-05T22:51:00Z", 0.5);
    const runsRepo = createRunsRepo(t.db);
    const spend = createSpendService({
      runs: runsRepo,
      trace: t.trace,
      settings: createUserSettingsRepo(t.db),
    });
    expect(backfillRunCosts(t.db, spend, runsRepo)).toBe(1);
    expect(backfillRunCosts(t.db, spend, runsRepo)).toBe(0);
    const row = t.db.prepare("select model_cost from runs where id = 'old'").get() as { model_cost: number };
    expect(row.model_cost).toBe(0.5);
  });
});

describe("GET /usage/claude/summary and the credit setting", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("sums only your own calls, with the exact shape", async () => {
    const t = await start();
    const nowIso = new Date().toISOString();
    t.add("u-me", "2020-01-01T00:00:00.000Z", 1);
    t.add("u-me", nowIso, 0.25);
    t.add("u-me", nowIso, null, "mystery");
    t.add("u-other", nowIso, 99);
    const res = await t.me("GET", "/usage/claude/summary");
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual([
      "byModel",
      "calls",
      "credit",
      "monthUsd",
      "since",
      "todayUsd",
      "totalUsd",
      "unpriced",
    ]);
    expect(res.body.data).toMatchObject({
      totalUsd: 1.25,
      calls: 3,
      unpriced: 1,
      todayUsd: 0.25,
      since: "2020-01-01T00:00:00.000Z",
      credit: null,
    });
    expect(res.body.data.byModel).toEqual([
      { model: "claude-sonnet-5-5", usd: 1.25, calls: 2 },
      { model: "mystery", usd: 0, calls: 1 },
    ]);
  });

  it("estimates what is left of the credit you entered", async () => {
    const t = await start();
    t.add("u-me", "2020-01-01T00:00:00.000Z", 3);
    t.add("u-me", new Date().toISOString(), 0.5);
    const saved = await t.me("PUT", "/settings/claude-credit", { amountUsd: 20, asOf: "2025-01-01" });
    expect(saved.body.data).toEqual({ amountUsd: 20, asOf: "2025-01-01" });
    expect((await t.other("GET", "/settings/claude-credit")).body.data).toEqual({
      amountUsd: null,
      asOf: null,
    });
    const { credit } = (await t.me("GET", "/usage/claude/summary")).body.data;
    expect(credit).toEqual({ amountUsd: 20, asOf: "2025-01-01", spentSinceUsd: 0.5, remainingUsd: 19.5 });
    const cleared = await t.me("DELETE", "/settings/claude-credit");
    expect(cleared.body.data).toEqual({ amountUsd: null, asOf: null });
    expect((await t.me("GET", "/usage/claude/summary")).body.data.credit).toBeNull();
  });

  it("validates the credit amount and date", async () => {
    const t = await start();
    const put = (body: unknown) => t.me("PUT", "/settings/claude-credit", body);
    expect((await put({ amountUsd: -1, asOf: today })).status).toBe(400);
    expect((await put({ amountUsd: 100_001, asOf: today })).status).toBe(400);
    expect((await put({ amountUsd: "5", asOf: today })).status).toBe(400);
    expect((await put({ amountUsd: 5, asOf: "2026-02-30" })).status).toBe(400);
    expect((await put({ amountUsd: 5, asOf: "yesterday" })).status).toBe(400);
    expect((await put({ amountUsd: 5, asOf: "2999-01-01" })).status).toBe(400);
    expect((await put({ amountUsd: 0, asOf: today })).status).toBe(200);
    expect((await put({ amountUsd: 100_000, asOf: today })).status).toBe(200);
  });
});
