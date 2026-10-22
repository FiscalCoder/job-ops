import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { runAsUser } from "../src/store/owner.js";
import { createTraceStore } from "../src/store/trace-store.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trace-test-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("trace store", () => {
  const setup = (now = new Date("2026-10-20T10:00:00Z"), cap?: number) => {
    const db = openStore(":memory:");
    const dir = tempDir();
    let clock = now;
    const store = createTraceStore({
      db,
      dir,
      now: () => clock,
      ...(cap === undefined ? {} : { maxSnapshotBytes: cap }),
    });
    return {
      store,
      dir,
      advance: (days: number) => {
        clock = new Date(clock.getTime() + days * 86_400_000);
      },
    };
  };

  it("keeps events in order with their data, per job and per run", () =>
    runAsUser("u1", () => {
    const { store } = setup();
    store.addEvents([
      {
        jobId: "j1",
        runId: "r1",
        source: "extension",
        kind: "step-start",
        stepSeq: 1,
        message: "Filling First Name",
        data: { value: "Ada" },
      },
      {
        jobId: "j1",
        runId: "r1",
        source: "page",
        kind: "console-error",
        message: "TypeError: x is undefined",
      },
      { jobId: "j2", source: "extension", kind: "kit", message: "Copied" },
    ]);
    store.record({ jobId: "j1", kind: "plan", message: "Plan built" });

    const events = store.events("j1");
    expect(events.map((e) => e.kind)).toEqual([
      "step-start",
      "console-error",
      "plan",
    ]);
    expect(events[0]).toMatchObject({
      runId: "r1",
      stepSeq: 1,
      data: { value: "Ada" },
    });
    expect(events[2]?.source).toBe("server");
    expect(store.events("j1", { runId: "r1" })).toHaveLength(2);
    expect(store.events("j1", { limit: 1 }).map((e) => e.kind)).toEqual([
      "plan",
    ]);
    expect(store.recentJobs()).toEqual([
      expect.objectContaining({
        jobId: "j1",
        events: 3,
        failures: 0, // page console errors aren't problems
        lastMessage: "Plan built",
      }),
      expect.objectContaining({ jobId: "j2", failures: 0 }),
    ]);
    }));

  it("stores DOM snapshots gzipped and gives them back as text, with a pointing event", () =>
    runAsUser("u1", () => {
    const { store, dir } = setup();
    const html = "<form><input name=first value=Ada></form>".repeat(50);
    const meta = store.saveSnapshot({
      jobId: "j1",
      runId: "r1",
      kind: "dom",
      reason: "step 2 failed",
      url: "https://jobs.example.com/apply",
      content: Buffer.from(html),
    });
    expect(meta.bytes).toBeLessThan(html.length);
    expect(readdirSync(dir)).toEqual([`${meta.id}.html.gz`]);
    expect(store.readSnapshot(meta.id)?.content.toString()).toBe(html);
    expect(store.events("j1")).toEqual([
      expect.objectContaining({
        kind: "snapshot",
        snapshotId: meta.id,
        message: "Page snapshot: step 2 failed",
      }),
    ]);
    expect(store.readSnapshot("nope")).toBeNull();
    }));

  it("prunes by age, then the oldest snapshots over the size cap", () =>
    runAsUser("u1", () => {
    const { store, dir, advance } = setup(undefined, JPEG.length * 2);
    const shot = (reason: string) =>
      store.saveSnapshot({
        jobId: "j1",
        kind: "screenshot",
        reason,
        content: JPEG,
      });
    const ancient = shot("ancient");
    store.record({ jobId: "j1", kind: "plan", message: "old" });
    advance(61);
    const a = shot("a");
    advance(1);
    const b = shot("b");
    advance(1);
    const c = shot("c");

    const dropped = store.prune();
    expect(dropped.snapshots).toBe(2);
    expect(store.snapshots("j1").map((s) => s.id)).toEqual([b.id, c.id]);
    expect(readdirSync(dir).sort()).toEqual(
      [`${b.id}.jpg`, `${c.id}.jpg`].sort(),
    );
    expect(store.readSnapshot(ancient.id)).toBeNull();
    expect(store.readSnapshot(a.id)).toBeNull();
    expect(store.events("j1").some((e) => e.message === "old")).toBe(false);
    }));
});

const job: JobOpsJob = {
  id: "job-1",
  title: "Senior Backend Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://job-boards.greenhouse.io/acme/jobs/11",
  applicationLink: null,
  suitabilityScore: 82,
};

function fakeJobOps(): JobOpsApi {
  let status = job.status;
  return {
    login: async () => ({ token: "good", expiresIn: 3600 }),
    me: async (t) => {
      if (t === "good") return { id: "u1", username: "me" };
      throw new JobOpsError(401, "UNAUTHORIZED", "nope");
    },
    listJobs: async () => ({ jobs: [job], total: 1, revision: "r" }),
    getJob: async (_t, id) => {
      if (id !== job.id)
        throw new JobOpsError(404, "NOT_FOUND", "Job not found");
      return { ...job, status, location: "Bengaluru", jobDescription: "x" };
    },
    updateJob: async (_t, _id, update) => {
      status = update.status ?? status;
    },
    addNote: async () => {},
    getPdf: async () => new Uint8Array(),
    markApplied: async () => {
      status = "applied";
    },
    skipJob: async () => {},
    getDesignResume: async () => fakeDesignResume,
  };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
  const db = openStore(":memory:");
  const trace = createTraceStore({ db, dir: tempDir() });
  const server = createApp({
    jobOps: fakeJobOps(),
    db,
    authCacheSeconds: 60,
    trace,
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, auth = true) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: "Bearer good" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res;
  };
  const json = async (path: string, body?: unknown) => {
    const res = await call(path, body);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call, json, trace };
}

describe("trace routes", () => {
  it("needs a login", async () => {
    const { call } = await start();
    expect((await call("/trace/jobs", undefined, false)).status).toBe(401);
  });

  it("takes event batches, bounds big data and rejects bad events", async () => {
    const { json } = await start();
    const saved = await json("/trace/events", {
      events: [
        {
          jobId: job.id,
          source: "extension",
          kind: "step-failed",
          stepSeq: 3,
          message: "Value didn't stick",
          data: { shown: "x".repeat(30_000) },
        },
      ],
    });
    expect(saved.body.data).toEqual({ saved: 1, rejected: [] });
    // One bad event doesn't cost the rest of its batch; the gap is noted in the trail.
    const mixed = await json("/trace/events", {
      events: [
        { jobId: job.id, source: "server", kind: "x", message: "forged" },
        { jobId: job.id, source: "page", kind: "console-error", message: "" },
        {
          jobId: job.id,
          source: "extension",
          kind: "review",
          message: "At review",
        },
      ],
    });
    expect(mixed.body.data.saved).toBe(1);
    expect(
      mixed.body.data.rejected.map((r: { index: number }) => r.index),
    ).toEqual([0, 1]);
    expect((await json("/trace/events", { events: [] })).status).toBe(400);

    const timeline = await json(`/trace/jobs/${job.id}`);
    expect(timeline.body.data.events[0].data).toMatchObject({
      truncated: true,
    });
    expect(
      timeline.body.data.events.map((e: { kind: string; source: string }) => [
        e.source,
        e.kind,
      ]),
    ).toEqual([
      ["extension", "step-failed"],
      ["extension", "review"],
      ["server", "trace-problem"],
    ]);
    const jobs = await json("/trace/jobs");
    expect(jobs.body.data[0]).toMatchObject({
      jobId: job.id,
      title: "Senior Backend Engineer",
      employer: "Acme",
      failures: 2, // the failed step and the rejected-events note
    });
  });

  it("serves DOM snapshots sandboxed and only accepts JPEG screenshots", async () => {
    const { call, json } = await start();
    const dom = await json("/trace/snapshots", {
      jobId: job.id,
      kind: "dom",
      reason: "review",
      url: "https://x.test/apply",
      content: "<form><input value=Ada></form>",
    });
    const res = await call(`/trace/snapshots/${dom.body.data.id}`);
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(await res.text()).toBe("<form><input value=Ada></form>");

    const png = await json("/trace/snapshots", {
      jobId: job.id,
      kind: "screenshot",
      reason: "review",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    });
    expect(png.status).toBe(400);
    const shot = await json("/trace/snapshots", {
      jobId: job.id,
      kind: "screenshot",
      reason: "review",
      content: JPEG.toString("base64"),
    });
    const image = await call(`/trace/snapshots/${shot.body.data.id}`);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
  });

  it("records the server's part of a run and exports the whole trail", async () => {
    const { json } = await start();
    const run = (await json("/runs", { jobId: job.id })).body.data;
    await json(`/runs/${run.id}/actions`, {
      seq: 1,
      actionClass: "auto",
      fieldRef: "first_name",
      valueMasked: "A***(3)",
      source: "bank",
      decision: "approved",
      decidedBy: "countdown",
      result: "filled",
    });
    await json("/trace/snapshots", {
      jobId: job.id,
      runId: run.id,
      kind: "dom",
      reason: "submitted",
      content: "<p>Thank you for applying</p>",
    });
    await json(`/runs/${run.id}/complete`, { outcome: "submitted" });
    const refused = await json("/runs", { jobId: job.id });
    expect(refused.status).toBe(409);

    const bundle = (await json(`/trace/jobs/${job.id}/export`)).body.data;
    expect(bundle.job).toMatchObject({ id: job.id, status: "applied" });
    expect(bundle.job.jobDescription).toBeUndefined();
    expect(bundle.runs[0].actions).toHaveLength(1);
    expect(bundle.events.map((e: { kind: string }) => e.kind)).toEqual([
      "run-created",
      "snapshot",
      "run-finished",
      "marked-applied",
      "run-refused",
    ]);
    expect(bundle.snapshots[0].html).toBe("<p>Thank you for applying</p>");
  });
});
