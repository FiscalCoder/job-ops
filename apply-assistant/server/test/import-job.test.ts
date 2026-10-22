import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  type ImportJob,
  type JobOpsApi,
  JobOpsClient,
  JobOpsError,
} from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * "Add a job" from the extension: the page is read in your browser, and Job Ops' own manual
 * import reads its details and adds it. This server never fetches the job's site.
 */

const PAGE = `Page Title: Senior Engineer at Acme\n\n---\n\n${"We build payment rails. ".repeat(20)}`;

function fakeJobOps(imported: ImportJob[]): JobOpsApi {
  return {
    login: async () => ({ token: "good", expiresIn: 3600 }),
    me: async (t) => {
      if (t === "good") return { id: "u1", username: "me" };
      throw new JobOpsError(401, "UNAUTHORIZED", "nope");
    },
    listJobs: async () => ({ jobs: [], total: 0, revision: "r" }),
    getJob: async (_t, id) => {
      if (id !== "job-new") throw new JobOpsError(404, "NOT_FOUND", "no job");
      return { id, title: "Senior Engineer", employer: "Acme" } as never;
    },
    updateJob: async () => {},
    addNote: async () => {},
    markApplied: async () => {},
    skipJob: async () => {},
    getPdf: async () => new Uint8Array(),
    getDesignResume: async () => fakeDesignResume,
    inferJob: async (_t, description) => ({
      job: {
        title: description.includes("Senior Engineer") ? "Senior Engineer" : null,
        employer: "Acme",
        location: null,
      },
      warning: null,
    }),
    importJob: async (_t, job) => {
      imported.push(job);
      return { id: "job-new", status: "processing" };
    },
  };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("adding a job from its link", () => {
  it("reads the page's text with Job Ops, adds the job, and traces it", async () => {
    const imported: ImportJob[] = [];
    const server = createApp({
      jobOps: fakeJobOps(imported),
      db: openStore(":memory:"),
      authCacheSeconds: 60,
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer good" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    const url = "https://careers.acme.com/jobs/123/apply";

    const read = await call("/jobs/import/read", { url, content: PAGE });
    expect(read.status).toBe(200);
    expect(read.json.data.job).toMatchObject({ title: "Senior Engineer", employer: "Acme" });

    // LinkedIn is copy-only: its pages are never read or added from here.
    const linkedIn = await call("/jobs/import/read", {
      url: "https://www.linkedin.com/jobs/view/1",
      content: PAGE,
    });
    expect(linkedIn.status).toBe(400);
    expect(linkedIn.json.error.message).toMatch(/LinkedIn/);
    expect((await call("/jobs/import/read", { url, content: "too short" })).status).toBe(400);

    const added = await call("/jobs/import", {
      job: {
        title: "Senior Engineer",
        employer: "Acme",
        jobUrl: url,
        applicationLink: url,
        location: "",
        jobDescription: PAGE,
      },
    });
    expect(added.status).toBe(200);
    expect(added.json.data).toEqual({ jobId: "job-new", status: "processing" });
    expect(imported[0]).toMatchObject({ title: "Senior Engineer", jobUrl: url, applicationLink: url });
    expect(
      (await call("/jobs/import", { job: { title: "", employer: "Acme", jobUrl: url, jobDescription: "x" } }))
        .status,
    ).toBe(400);

    const trail = await (
      await fetch(`${base}/trace/jobs/job-new`, { headers: { authorization: "Bearer good" } })
    ).json();
    expect((trail as any).data.events.map((e: { kind: string }) => e.kind)).toContain("imported");
  });
});

describe("JobOpsClient manual import", () => {
  it("calls Job Ops' infer and import endpoints", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const data = String(url).endsWith("/infer")
        ? { job: { title: "SE", employer: "Acme" }, warning: null }
        : { id: "j1", status: "ready", title: "SE" };
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    });
    const client = new JobOpsClient("https://jobops.test", fetchImpl as typeof fetch);
    expect(await client.inferJob("tok", "text")).toEqual({
      job: { title: "SE", employer: "Acme" },
      warning: null,
    });
    expect(
      await client.importJob("tok", {
        title: "SE",
        employer: "Acme",
        jobUrl: "https://a.test/j",
        jobDescription: "text",
      }),
    ).toEqual({ id: "j1", status: "ready" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://jobops.test/api/manual-jobs/infer",
      "https://jobops.test/api/manual-jobs/import",
    ]);
    expect(calls[1]?.body).toMatchObject({ job: { title: "SE" } });
  });
});
