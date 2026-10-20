import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
  type JobUpdate,
} from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

const job: JobOpsJob = {
  id: "job-1",
  title: "Senior Backend Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://job-boards.greenhouse.io/acme/jobs/11",
  applicationLink: null,
  suitabilityScore: 82,
};
const PDF = new TextEncoder().encode("%PDF-1.5 tailored");

function fakeJobOps(log: {
  updates: [string, JobUpdate][];
  notes: [string, string, string][];
}): JobOpsApi {
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
    updateJob: async (_t, id, update) => {
      log.updates.push([id, update]);
      status = update.status ?? status;
    },
    addNote: async (_t, id, note) => {
      log.notes.push([id, note.title, note.content]);
    },
    getPdf: async (_t, id) => {
      if (id !== job.id) throw new JobOpsError(404, "NOT_FOUND", "No PDF");
      return PDF;
    },
    getDesignResume: async () => fakeDesignResume,
  };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
  const log = {
    updates: [] as [string, JobUpdate][],
    notes: [] as [string, string, string][],
  };
  const db = openStore(":memory:");
  const server = createApp({
    jobOps: fakeJobOps(log),
    db,
    authCacheSeconds: 60,
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, method?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res;
  };
  const json = async (path: string, body?: unknown, method?: string) => {
    const res = await call(path, body, method);
    return {
      status: res.status,
      body: (await res.json()) as { ok: boolean; data: any; error?: any },
    };
  };
  return { call, json, log, db };
}

const action = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq,
  actionClass: "auto",
  fieldRef: "first_name",
  valueMasked: "T***",
  source: "bank:identity.first_name",
  decision: "approved",
  decidedBy: "countdown",
  result: "ok",
  ...extra,
});

describe("tailored resume for the extension", () => {
  it("serves the job's tailored PDF named after you", async () => {
    const { call, json } = await start();
    await json("/answer-bank/identity.first_name", { value: "Test" }, "PUT");
    await json("/answer-bank/identity.last_name", { value: "C" }, "PUT");
    const res = await call("/jobs/job-1/resume.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Test_C_Resume.pdf"',
    );
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(
      "%PDF-1.5 tailored",
    );
  });

  it("falls back to a plain name and passes Job Ops' 404 through", async () => {
    const { call } = await start();
    expect(
      (await call("/jobs/job-1/resume.pdf")).headers.get("content-disposition"),
    ).toBe('attachment; filename="Resume.pdf"');
    expect((await call("/jobs/nope/resume.pdf")).status).toBe(404);
  });
});

describe("runs", () => {
  it("starts a run, logs actions, and on 'submitted' marks the job applied with a summary note", async () => {
    const { json, log } = await start();
    const started = await json("/runs", { jobId: "job-1" });
    expect(started.status).toBe(200);
    const runId = started.body.data.id as string;

    expect((await json(`/runs/${runId}/actions`, action(1))).status).toBe(200);
    await json(
      `/runs/${runId}/actions`,
      action(2, { fieldRef: "phone", decidedBy: "you", decision: "edited" }),
    );
    await json(
      `/runs/${runId}/actions`,
      action(3, {
        fieldRef: "question_9",
        decision: "skipped",
        decidedBy: "you",
        result: "you-did-it",
      }),
    );

    const done = await json(`/runs/${runId}/complete`, {
      outcome: "submitted",
    });
    expect(done.body.data).toMatchObject({
      id: runId,
      outcome: "submitted",
      actions: 3,
      interventions: 2,
    });
    expect(log.updates).toEqual([["job-1", { status: "applied" }]]);
    expect(log.notes[0]?.[1]).toBe("Applied via Apply Copilot");
    expect(log.notes[0]?.[2]).toContain("3 steps");
    expect(log.notes[0]?.[2]).toContain("2 by you");

    const runs = await json("/runs?jobId=job-1");
    expect(runs.body.data).toEqual([
      expect.objectContaining({ id: runId, outcome: "submitted" }),
    ]);
    const detail = await json(`/runs/${runId}`);
    expect(detail.body.data.actions.map((a: any) => a.fieldRef)).toEqual([
      "first_name",
      "phone",
      "question_9",
    ]);

    // A job already applied to can't start another run (no second application).
    const again = await json("/runs", { jobId: "job-1" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: "NOT_APPLICABLE",
      message: "You've already applied to this job (Job Ops says Applied)",
    });
  });

  it("an aborted run leaves the job alone", async () => {
    const { json, log } = await start();
    const runId = (await json("/runs", { jobId: "job-1" })).body.data.id;
    await json(`/runs/${runId}/complete`, { outcome: "aborted" });
    expect(log.updates).toEqual([]);
    expect(log.notes).toEqual([]);
  });

  it("refuses to log to a finished run, unknown runs, and duplicate steps", async () => {
    const { json } = await start();
    const runId = (await json("/runs", { jobId: "job-1" })).body.data.id;
    await json(`/runs/${runId}/actions`, action(1));
    expect((await json(`/runs/${runId}/actions`, action(1))).status).toBe(409);
    await json(`/runs/${runId}/complete`, { outcome: "aborted" });
    expect((await json(`/runs/${runId}/actions`, action(2))).status).toBe(409);
    expect(
      (await json(`/runs/${runId}/complete`, { outcome: "submitted" })).status,
    ).toBe(409);
    expect((await json("/runs/nope/actions", action(1))).status).toBe(404);
  });

  it("validates input and checks the job exists", async () => {
    const { json } = await start();
    expect((await json("/runs", {})).status).toBe(400);
    expect((await json("/runs", { jobId: "nope" })).status).toBe(404);
    const runId = (await json("/runs", { jobId: "job-1" })).body.data.id;
    expect((await json(`/runs/${runId}/actions`, { seq: "x" })).status).toBe(
      400,
    );
    expect(
      (await json(`/runs/${runId}/complete`, { outcome: "maybe" })).status,
    ).toBe(400);
  });
});
