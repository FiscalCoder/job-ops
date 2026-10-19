import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import type { JobOpsApi, JobOpsJob, JobUpdate } from "../src/jobops/client.js";
import { JobOpsError } from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";

const JD =
  "We are looking for a senior backend engineer to design and build scalable services in Go and Kubernetes. " +
  "You will own APIs, mentor engineers, and work closely with product to ship reliable features.";

const jobs: JobOpsJob[] = [
  {
    id: "direct",
    title: "Senior Backend Engineer",
    employer: "Acme",
    status: "ready",
    jobUrl: "https://job-boards.greenhouse.io/acme/jobs/11",
    applicationLink: null,
    suitabilityScore: 82,
  },
  {
    id: "short",
    title: "Platform Engineer",
    employer: "Beta",
    status: "ready",
    jobUrl: "https://grnh.se/abc123",
    applicationLink: null,
    suitabilityScore: 75,
  },
  {
    id: "linkedin",
    title: "Senior Backend Engineer",
    employer: "Gamma Labs Inc.",
    status: "ready",
    jobUrl: "https://www.linkedin.com/jobs/view/1",
    applicationLink: null,
    suitabilityScore: 79,
  },
  {
    id: "discovered-high",
    title: "Backend Engineer",
    employer: "Delta",
    status: "discovered",
    jobUrl: "https://www.linkedin.com/jobs/view/2",
    applicationLink: null,
    suitabilityScore: 70,
  },
  {
    id: "discovered-low",
    title: "Backend Engineer",
    employer: "Epsilon",
    status: "discovered",
    jobUrl: "https://www.linkedin.com/jobs/view/3",
    applicationLink: null,
    suitabilityScore: 69,
  },
  {
    id: "discovered-unscored",
    title: "Backend Engineer",
    employer: "Zeta",
    status: "discovered",
    jobUrl: "https://www.linkedin.com/jobs/view/4",
    applicationLink: null,
    suitabilityScore: null,
  },
  {
    id: "skipped",
    title: "Backend Engineer",
    employer: "Eta",
    status: "skipped",
    jobUrl: "https://job-boards.greenhouse.io/eta/jobs/9",
    applicationLink: null,
    suitabilityScore: 95,
  },
];

function fakeJobOps(log: {
  updates: [string, JobUpdate][];
  notes: [string, string][];
}): JobOpsApi {
  return {
    login: async () => ({ token: "good", expiresIn: 3600 }),
    me: async (token) => {
      if (token === "good") return { id: "u1", username: "me" };
      throw new JobOpsError(401, "UNAUTHORIZED", "nope");
    },
    listJobs: async (_t, statuses) => {
      const found = jobs.filter((j) => statuses.includes(j.status));
      return { jobs: found, total: found.length, revision: "r1" };
    },
    getJob: async (_t, id) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new JobOpsError(404, "NOT_FOUND", "Job not found");
      return { ...job, location: "Bengaluru", jobDescription: JD };
    },
    updateJob: async (_t, id, update) => {
      log.updates.push([id, update]);
    },
    addNote: async (_t, id, note) => {
      log.notes.push([id, note.title]);
    },
    getPdf: async () => new Uint8Array(),
  };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
  const log = {
    updates: [] as [string, JobUpdate][],
    notes: [] as [string, string][],
  };
  const app = createApp({
    jobOps: fakeJobOps(log),
    db: openStore(":memory:"),
    authCacheSeconds: 60,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      json: (await res.json()) as { ok: boolean; data: any; error?: any },
    };
  };
  return { call, log };
}

describe("lookups", () => {
  it("lists one lookup task per unresolved Ready job, and per Discovered job scoring 70+", async () => {
    const { call } = await start();
    const { status, json } = await call("/lookups/pending");
    expect(status).toBe(200);
    expect(json.data).toEqual([
      {
        jobId: "direct",
        employer: "Acme",
        title: "Senior Backend Engineer",
        task: {
          type: "verify-job",
          token: "acme",
          ghJobId: "11",
          region: "us",
        },
      },
      {
        jobId: "short",
        employer: "Beta",
        title: "Platform Engineer",
        task: { type: "follow-short-link", url: "https://grnh.se/abc123" },
      },
      {
        jobId: "linkedin",
        employer: "Gamma Labs Inc.",
        title: "Senior Backend Engineer",
        task: { type: "find-board", employer: "Gamma Labs Inc." },
      },
      {
        jobId: "discovered-high",
        employer: "Delta",
        title: "Backend Engineer",
        task: { type: "find-board", employer: "Delta" },
      },
    ]);
  });

  it("verifies a direct job: live → matched and link written back with a note", async () => {
    const { call, log } = await start();
    const res = await call("/lookups/results", {
      type: "job",
      jobId: "direct",
      token: "acme",
      ghJobId: "11",
      url: "https://job-boards.greenhouse.io/acme/jobs/11",
      live: true,
    });
    expect(res.json.data).toMatchObject({ status: "matched" });
    expect(log.updates).toEqual([
      [
        "direct",
        { applicationLink: "https://job-boards.greenhouse.io/acme/jobs/11" },
      ],
    ]);
    expect(log.notes.map(([, t]) => t)).toEqual([
      "Greenhouse posting confirmed",
    ]);
  });

  it("records a closed posting without touching the Job Ops status", async () => {
    const { call, log } = await start();
    const res = await call("/lookups/results", {
      type: "job",
      jobId: "direct",
      token: "acme",
      ghJobId: "11",
      url: "https://x",
      live: false,
    });
    expect(res.json.data).toMatchObject({ status: "closed" });
    expect(log.updates).toEqual([]);
    expect(log.notes.map(([, t]) => t)).toEqual(["Greenhouse posting closed"]);
  });

  it("matches a LinkedIn job on its company board in two steps (titles, then details)", async () => {
    const { call, log } = await start();
    const boardJobs = [
      {
        id: "77",
        title: "Senior Backend Engineer",
        location: "Bengaluru, India",
        url: "https://job-boards.greenhouse.io/gammalabs/jobs/77",
      },
      {
        id: "78",
        title: "Designer",
        location: "Remote",
        url: "https://job-boards.greenhouse.io/gammalabs/jobs/78",
      },
    ];
    const first = await call("/lookups/results", {
      type: "board",
      jobId: "linkedin",
      employer: "Gamma Labs Inc.",
      token: "gammalabs",
      method: "name-slug",
      jobs: boardJobs,
    });
    expect(first.json.data).toEqual({
      status: "need-details",
      ghJobIds: ["77"],
    });

    const second = await call("/lookups/results", {
      type: "board",
      jobId: "linkedin",
      employer: "Gamma Labs Inc.",
      token: "gammalabs",
      method: "name-slug",
      jobs: boardJobs,
      details: { "77": JD },
    });
    expect(second.json.data).toMatchObject({
      status: "matched",
      ghUrl: "https://job-boards.greenhouse.io/gammalabs/jobs/77",
    });
    expect(log.updates).toEqual([
      [
        "linkedin",
        {
          applicationLink: "https://job-boards.greenhouse.io/gammalabs/jobs/77",
        },
      ],
    ]);

    // The board is cached for the employer: next time the task is list-board, not find-board.
    const pending = await call("/lookups/pending");
    expect(
      pending.json.data.find((p: any) => p.jobId === "linkedin"),
    ).toBeUndefined();
  });

  it("remembers that a company has no Greenhouse board", async () => {
    const { call } = await start();
    const res = await call("/lookups/results", {
      type: "board",
      jobId: "linkedin",
      employer: "Gamma Labs Inc.",
      token: null,
      method: "careers-page",
    });
    expect(res.json.data).toMatchObject({ status: "none" });
    const pending = await call("/lookups/pending");
    expect(pending.json.data.map((p: any) => p.jobId)).not.toContain(
      "linkedin",
    );
  });

  it("validates result payloads", async () => {
    const { call } = await start();
    expect(
      (await call("/lookups/results", { type: "job", jobId: "direct" })).status,
    ).toBe(400);
    expect(
      (
        await call("/lookups/results", {
          type: "board",
          jobId: "linkedin",
          employer: "G",
          token: "x",
          method: "m",
          jobs: [{ id: 1 }],
        })
      ).status,
    ).toBe(400);
  });

  it("returns 404 for a result about a job Job Ops doesn't know", async () => {
    const { call } = await start();
    const res = await call("/lookups/results", {
      type: "job",
      jobId: "nope",
      token: "a",
      ghJobId: "1",
      url: "https://x",
      live: true,
    });
    expect(res.status).toBe(404);
  });

  it("shows the queue with each job's Greenhouse status", async () => {
    const { call } = await start();
    await call("/lookups/results", {
      type: "job",
      jobId: "direct",
      token: "acme",
      ghJobId: "11",
      url: "https://job-boards.greenhouse.io/acme/jobs/11",
      live: true,
    });
    const { json } = await call("/queue");
    expect(json.data).toEqual([
      expect.objectContaining({
        jobId: "direct",
        greenhouse: expect.objectContaining({
          status: "matched",
          ghUrl: "https://job-boards.greenhouse.io/acme/jobs/11",
        }),
      }),
      expect.objectContaining({
        jobId: "linkedin",
        greenhouse: { status: "pending" },
      }),
      expect.objectContaining({
        jobId: "short",
        greenhouse: { status: "pending" },
      }),
    ]);
  });
});
