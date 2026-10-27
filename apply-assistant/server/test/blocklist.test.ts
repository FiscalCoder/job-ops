import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

type MutableJob = { -readonly [K in keyof JobOpsJob]: JobOpsJob[K] };

const job = (id: string, employer: string, status: string): MutableJob => ({
  id,
  title: "Engineer",
  employer,
  status,
  jobUrl: `https://example.com/${id}`,
  applicationLink: null,
  suitabilityScore: 80,
});

/** Job Ops with its blocked-company setting and statuses that change as the app sets them. */
function fakeJobOps() {
  const jobs = [
    job("amzn-1", "Amazon", "ready"),
    job("amzn-2", "Amazon Development Centre India", "discovered"),
    job("amzn-3", "Amazon", "applied"),
    job("other", "Acme", "ready"),
  ];
  const state = { blocked: ["Existing Co"], notes: [] as string[] };
  const api: JobOpsApi = {
    login: async () => ({ token: "good", expiresIn: 3600 }),
    me: async (t) => {
      if (t === "good") return { id: "u1", username: "me" };
      throw new JobOpsError(401, "UNAUTHORIZED", "nope");
    },
    listJobs: async (_t, statuses) => {
      const found = jobs.filter((j) => statuses.includes(j.status));
      return { jobs: found, total: found.length, revision: "r" };
    },
    getJob: async (_t, id) => {
      const found = jobs.find((j) => j.id === id);
      if (!found) throw new JobOpsError(404, "NOT_FOUND", "Job not found");
      return { ...found, location: null, jobDescription: null };
    },
    updateJob: async (_t, id, update) => {
      const found = jobs.find((j) => j.id === id);
      if (found && update.status) found.status = update.status;
    },
    addNote: async (_t, id, note) => {
      state.notes.push(`${id}: ${note.title}`);
    },
    getPdf: async () => new Uint8Array(),
    markApplied: async () => {},
    skipJob: async (_t, id) => {
      const found = jobs.find((j) => j.id === id);
      if (found) found.status = "skipped";
    },
    getDesignResume: async () => fakeDesignResume,
    getBlockedCompanies: async () => [...state.blocked],
    setBlockedCompanies: async (_t, keywords) => {
      state.blocked = [...keywords];
    },
  };
  return { api, jobs, state };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
  const fake = fakeJobOps();
  const server = createApp({
    jobOps: fake.api,
    db: openStore(":memory:"),
    authCacheSeconds: 60,
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { call, ...fake };
}

const statusOf = (jobs: JobOpsJob[], id: string) =>
  jobs.find((j) => j.id === id)?.status;

describe("blocked companies", () => {
  it("blocking adds the company to Job Ops' list and skips its open jobs; unblocking puts them back", async () => {
    const { call, jobs, state } = await start();

    const blocked = await call("/blocked-companies", "PUT", { name: "Amazon" });
    expect(blocked.json.data).toEqual({ name: "Amazon", skippedJobs: 2 });
    expect(state.blocked).toEqual(["Existing Co", "Amazon"]);
    // Any company whose name contains it, as discovery matches; applied jobs are left alone.
    expect(statusOf(jobs, "amzn-1")).toBe("skipped");
    expect(statusOf(jobs, "amzn-2")).toBe("skipped");
    expect(statusOf(jobs, "amzn-3")).toBe("applied");
    expect(statusOf(jobs, "other")).toBe("ready");

    // Blocking again doesn't add it twice.
    await call("/blocked-companies", "PUT", { name: "amazon" });
    expect(state.blocked).toEqual(["Existing Co", "Amazon"]);

    expect((await call("/blocked-companies")).json.data).toEqual([
      { name: "Existing Co", skippedJobs: 0 },
      { name: "Amazon", skippedJobs: 2 },
    ]);

    const unblocked = await call("/blocked-companies/Amazon", "DELETE");
    expect(unblocked.json.data).toEqual({ name: "Amazon", restoredJobs: 2 });
    expect(state.blocked).toEqual(["Existing Co"]);
    expect(statusOf(jobs, "amzn-1")).toBe("ready");
    expect(statusOf(jobs, "amzn-2")).toBe("discovered");
    expect(state.notes).toContain("amzn-1: Back: company unblocked");
  });

  it("a name already blocked in Job Ops can be unblocked here; unknown names and short names are refused", async () => {
    const { call, state } = await start();
    expect(
      (await call("/blocked-companies/Existing%20Co", "DELETE")).json.data,
    ).toEqual({
      name: "Existing Co",
      restoredJobs: 0,
    });
    expect(state.blocked).toEqual([]);
    expect((await call("/blocked-companies/Nobody", "DELETE")).status).toBe(
      404,
    );
    expect(
      (await call("/blocked-companies", "PUT", { name: "a" })).status,
    ).toBe(400);
  });
});
