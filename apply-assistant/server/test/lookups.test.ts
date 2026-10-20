import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagesApi } from "../src/claude/answerer.js";
import { createApp } from "../src/http/app.js";
import type { JobOpsApi, JobOpsJob, JobUpdate } from "../src/jobops/client.js";
import { JobOpsError } from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";
import newrelic from "./fixtures/gh-newrelic.json" with { type: "json" };

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
    jobUrl: "https://www.linkedin.com/jobs/view/4400000001",
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
    getDesignResume: async () => fakeDesignResume,
  };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(options: { claude?: MessagesApi["create"] } = {}) {
  const log = {
    updates: [] as [string, JobUpdate][],
    notes: [] as [string, string][],
  };
  const app = createApp({
    jobOps: fakeJobOps(log),
    db: openStore(":memory:"),
    authCacheSeconds: 60,
    claude: options.claude
      ? {
          messages: { create: options.claude },
          mapModel: "claude-haiku-5-5",
          draftModel: "claude-sonnet-5-5",
        }
      : null,
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
  const put = async (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      body: JSON.stringify(body),
    });
  return { call, put, log };
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

    // Matched: the next task for this job is fetching its form so it can be planned.
    const pending = await call("/lookups/pending");
    expect(
      pending.json.data.find((p: any) => p.jobId === "linkedin")?.task,
    ).toEqual({ type: "fetch-schema", token: "gammalabs", ghJobId: "77" });
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

  describe("forms and plans", () => {
    const matchDirect = (call: Awaited<ReturnType<typeof start>>["call"]) =>
      call("/lookups/results", {
        type: "job",
        jobId: "direct",
        token: "acme",
        ghJobId: "11",
        url: "https://job-boards.greenhouse.io/acme/jobs/11",
        live: true,
      });
    const formFor11 = { ...structuredClone(newrelic), id: 11 };

    it("asks for the form of a matched posting, plans it, then stops asking", async () => {
      const { call } = await start();
      await matchDirect(call);
      const before = await call("/lookups/pending");
      expect(
        before.json.data.find((p: any) => p.jobId === "direct")?.task,
      ).toEqual({
        type: "fetch-schema",
        token: "acme",
        ghJobId: "11",
      });

      const res = await call("/lookups/results", {
        type: "schema",
        jobId: "direct",
        token: "acme",
        ghJobId: "11",
        payload: formFor11,
      });
      expect(res.status).toBe(200);
      expect(res.json.data.status).toBe("planned");
      expect(res.json.data.summary.needsYou).toBeGreaterThan(0);

      const after = await call("/lookups/pending");
      expect(
        after.json.data.find((p: any) => p.jobId === "direct"),
      ).toBeUndefined();

      const queue = await call("/queue");
      const direct = queue.json.data.find((q: any) => q.jobId === "direct");
      expect(direct.plan.summary).toEqual(res.json.data.summary);
    });

    it("rejects a form for another posting or a non-Greenhouse payload", async () => {
      const { call } = await start();
      await matchDirect(call);
      const wrongPosting = await call("/lookups/results", {
        type: "schema",
        jobId: "direct",
        token: "acme",
        ghJobId: "99",
        payload: formFor11,
      });
      expect(wrongPosting.status).toBe(400);
      expect(wrongPosting.json.error.code).toBe("INVALID_LOOKUP");
      const notAForm = await call("/lookups/results", {
        type: "schema",
        jobId: "direct",
        token: "acme",
        ghJobId: "11",
        payload: { nope: true },
      });
      expect(notAForm.status).toBe(400);
      const mismatchedId = await call("/lookups/results", {
        type: "schema",
        jobId: "direct",
        token: "acme",
        ghJobId: "11",
        payload: newrelic,
      });
      expect(mismatchedId.status).toBe(400);
    });

    it("serves a plan, says why when a job can't be planned, and rebuilds after bank edits", async () => {
      const { call, put } = await start();
      const notYet = await call("/plans/direct");
      expect(notYet.status).toBe(409);
      expect(notYet.json.error.code).toBe("NOT_PLANNABLE");

      await matchDirect(call);
      expect((await call("/plans/direct")).status).toBe(409);
      await call("/lookups/results", {
        type: "schema",
        jobId: "direct",
        token: "acme",
        ghJobId: "11",
        payload: formFor11,
      });

      const plan = await call("/plans/direct");
      expect(plan.status).toBe(200);
      const firstName = plan.json.data.entries.find(
        (e: any) => e.ref === "first_name",
      );
      expect(firstName.status).toBe("needs-you");

      const queueBefore = await call("/queue");
      const needsBefore = queueBefore.json.data.find(
        (q: any) => q.jobId === "direct",
      ).plan.summary.needsYou;
      await put("/answer-bank/identity.first_name", { value: "Test" });
      const rebuilt = await call("/plans/rebuild", {});
      expect(rebuilt.json.data).toEqual({ rebuilt: 1, failed: [] });
      const queueAfter = await call("/queue");
      // First name also covers "Preferred First Name", which falls back to it.
      expect(
        queueAfter.json.data.find((q: any) => q.jobId === "direct").plan.summary
          .needsYou,
      ).toBe(needsBefore - 2);

      expect((await call("/plans/nope")).status).toBe(409);
    });

    const planWithClaude = async (create: MessagesApi["create"]) => {
      const { call } = await start({ claude: create });
      await matchDirect(call);
      await call("/lookups/results", {
        type: "schema",
        jobId: "direct",
        token: "acme",
        ghJobId: "11",
        payload: formFor11,
      });
      const plan = await call("/plans/direct");
      return (ref: string) =>
        plan.json.data.entries.find((e: any) => e.ref === ref);
    };

    it("asks Claude only about required questions the rules don't know, with the job's text", async () => {
      const create = vi.fn<MessagesApi["create"]>().mockResolvedValue({
        model: "claude-haiku-5-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers: [
                {
                  ref: "question_18992931008",
                  kind: "answer",
                  bank_key: "",
                  answer: ["Yes"],
                  confidence: 0.8,
                  why: "Python on resume",
                },
                {
                  ref: "question_18992930008",
                  kind: "unknown",
                  bank_key: "",
                  answer: [],
                  confidence: 0,
                  why: "Meraki isn't on your resume",
                },
              ],
            }),
          },
        ],
      } as unknown as Anthropic.Message);
      const entry = await planWithClaude(create);
      expect(create).toHaveBeenCalledTimes(1);
      const sent = String(create.mock.calls[0]?.[0].messages[0]?.content);
      expect(sent.match(/<question ref=/g)).toHaveLength(2);
      expect(sent).toContain("scalable services in Go and Kubernetes");
      expect(entry("question_18992931008")).toMatchObject({
        status: "fill",
        value: "Yes",
        actionClass: "confirm",
      });
      expect(entry("question_18992930008")).toMatchObject({
        status: "needs-you",
        reason: "Claude: Meraki isn't on your resume",
      });
    });

    it("still plans when Claude fails, and says so on those questions", async () => {
      const entry = await planWithClaude(
        vi
          .fn<MessagesApi["create"]>()
          .mockRejectedValue(new Error("overloaded")),
      );
      expect(entry("question_18992931008")).toMatchObject({
        status: "needs-you",
        reason: expect.stringContaining("Claude couldn't be reached"),
      });
      expect(entry("email")).toMatchObject({ status: "fill" });
    });
  });

  describe("LinkedIn apply-link capture", () => {
    it("saves the company link to the LinkedIn job, with a note, and records it", async () => {
      const { call, log } = await start();
      const res = await call("/captures", {
        linkedinJobId: "4400000001",
        applyUrl: "https://click.appcast.io/t/abc",
        finalUrl:
          "https://job-boards.greenhouse.io/gamma/jobs/77?utm_source=linkedin&gh_src=x",
      });
      expect(res.json.data).toEqual({
        status: "saved",
        jobId: "linkedin",
        title: "Senior Backend Engineer",
        employer: "Gamma Labs Inc.",
        link: "https://job-boards.greenhouse.io/gamma/jobs/77?gh_src=x",
      });
      expect(log.updates).toEqual([
        [
          "linkedin",
          {
            applicationLink:
              "https://job-boards.greenhouse.io/gamma/jobs/77?gh_src=x",
          },
        ],
      ]);
      expect(log.notes).toEqual([
        ["linkedin", "Apply link captured from LinkedIn"],
      ]);
      const recent = await call("/captures");
      expect(recent.json.data[0]).toMatchObject({
        jobId: "linkedin",
        sourceUrl: "https://www.linkedin.com/jobs/view/4400000001",
        capturedUrl: "https://click.appcast.io/t/abc",
      });
    });

    it("forgets the job's old lookup result so the next lookup uses the new link", async () => {
      const { call } = await start();
      await call("/lookups/results", {
        type: "board",
        jobId: "linkedin",
        employer: "Gamma Labs Inc.",
        token: null,
        method: "slug",
      });
      const before = await call("/lookups/pending");
      expect(
        before.json.data.find((p: any) => p.jobId === "linkedin"),
      ).toBeUndefined();
      await call("/captures", {
        linkedinJobId: "4400000001",
        applyUrl: "https://jobs.lever.co/gamma/123",
      });
      const queue = await call("/queue");
      expect(
        queue.json.data.find((q: any) => q.jobId === "linkedin")?.greenhouse,
      ).toEqual({ status: "pending" });
    });

    it("ignores jobs Job Ops doesn't have and links that aren't company pages", async () => {
      const { call, log } = await start();
      expect(
        (
          await call("/captures", {
            linkedinJobId: "9999999999",
            applyUrl: "https://jobs.lever.co/x/1",
          })
        ).json.data,
      ).toEqual({ status: "unknown-job" });
      expect(
        (
          await call("/captures", {
            linkedinJobId: "4400000001",
            applyUrl: "https://www.linkedin.com/jobs/view/4400000001",
          })
        ).json.data,
      ).toMatchObject({ status: "rejected" });
      expect(
        (await call("/captures", { linkedinJobId: "abc", applyUrl: "x" }))
          .status,
      ).toBe(400);
      expect(log.updates).toEqual([]);
    });
  });
});
