import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { createTraceStore } from "../src/store/trace-store.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * Two people on one apply-assistant: each sees and changes only their own answers, limits,
 * runs and traces, and nothing of the other's jobs. Data from before there were users is the
 * Job Ops admin's.
 */

const USERS = {
  admin: { id: "u-admin", username: "you", isSystemAdmin: true },
  other: { id: "u-other", username: "friend", isSystemAdmin: false },
} as const;

const job = (id: string, title: string): JobOpsJob => ({
  id,
  title,
  employer: "Acme",
  status: "ready",
  jobUrl: `https://jobs.test/${id}`,
  applicationLink: null,
  suitabilityScore: 80,
});

// Job Ops keeps each user's jobs apart: their token sees only theirs.
const JOBS: Record<string, JobOpsJob[]> = {
  admin: [job("job-yours", "Yours")],
  other: [job("job-theirs", "Theirs")],
};

const jobOps: JobOpsApi = {
  login: async () => ({ token: "admin", expiresIn: 3600 }),
  me: async (token) => {
    const user = USERS[token as keyof typeof USERS];
    if (!user) throw new JobOpsError(401, "UNAUTHORIZED", "nope");
    return user;
  },
  listJobs: async (token) => {
    const jobs = JOBS[token] ?? [];
    return { jobs, total: jobs.length, revision: "r" };
  },
  getJob: async (token, id) => {
    const found = (JOBS[token] ?? []).find((j) => j.id === id);
    if (!found) throw new JobOpsError(404, "NOT_FOUND", "no job");
    return { ...found, location: null, jobDescription: "Build things" };
  },
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
  // From before there were users: one answer, one remembered answer, one trace event.
  db.exec(`insert into answer_bank (key, value, updated_by) values ('identity.first_name', 'Bharghav', 'you');
           insert into learned_answers (question_norm, label, field_type, answer_json, how)
             values ('postal code', 'Postal Code', 'text', '"600100"', 'edited');
           insert into trace_events (job_id, ts, source, kind, message)
             values ('job-yours', '2026-10-20T10:00:00Z', 'server', 'plan', 'Plan built before users');`);
  const dir = mkdtempSync(path.join(tmpdir(), "users-trace-"));
  dirs.push(dir);
  const server = createApp({
    jobOps,
    db,
    authCacheSeconds: 60,
    trace: createTraceStore({ db, dir }),
  }).listen(0);
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
  return { you: as("admin"), friend: as("other") };
}

/** The answers saved in a GET /answer-bank reply, as [key, value]. */
const saved = (reply: any): [string, string][] =>
  reply.body.data.keys
    .filter((k: { value: string | null }) => k.value !== null)
    .map((k: { key: string; value: string }) => [k.key, k.value]);

describe("several users on one apply-assistant", () => {
  it("data from before users is the admin's, never anyone else's", async () => {
    const { you, friend } = await start();
    // Someone else signs in first: none of it is theirs.
    expect(saved(await friend("GET", "/answer-bank"))).toEqual([]);
    expect((await friend("GET", "/learned")).body.data).toEqual([]);
    expect((await friend("GET", "/company-limits")).body.data).toEqual([]);
    expect((await friend("GET", "/trace/jobs")).body.data).toEqual([]);

    // Job Ops' admin: it's theirs, seeded company limits included.
    expect(saved(await you("GET", "/answer-bank"))).toEqual([
      ["identity.first_name", "Bharghav"],
    ]);
    expect((await you("GET", "/learned")).body.data).toMatchObject([{ label: "Postal Code" }]);
    expect((await you("GET", "/company-limits")).body.data.map((l: any) => l.name)).toEqual([
      "Amazon",
      "ElevenLabs",
      "Google",
    ]);
    const timeline = (await you("GET", "/trace/jobs/job-yours")).body.data;
    expect(timeline.events.map((e: any) => e.message)).toEqual(["Plan built before users"]);
    // And still not the other person's.
    expect(saved(await friend("GET", "/answer-bank"))).toEqual([]);
  });

  it("each person's answers, limits and remembered answers are their own", async () => {
    const { you, friend } = await start();
    await you("GET", "/answer-bank");
    expect(
      (await friend("PUT", "/answer-bank/identity.first_name", { value: "Priya" })).status,
    ).toBe(200);
    expect(saved(await you("GET", "/answer-bank"))).toEqual([
      ["identity.first_name", "Bharghav"],
    ]);
    expect(saved(await friend("GET", "/answer-bank"))).toEqual([
      ["identity.first_name", "Priya"],
    ]);

    await friend("PUT", "/company-limits", { name: "Acme", maxApplications: 1, windowDays: 90 });
    expect((await friend("GET", "/company-limits")).body.data.map((l: any) => l.name)).toEqual([
      "Acme",
    ]);
    expect(
      (await you("GET", "/company-limits")).body.data.map((l: any) => l.name),
    ).not.toContain("Acme");
    // Someone else's limit can't be removed by id.
    const amazon = (await you("GET", "/company-limits")).body.data[0];
    expect((await friend("DELETE", `/company-limits/${amazon.id}`)).status).toBe(404);

    expect(
      (
        await friend("POST", "/learned", {
          jobId: "job-theirs",
          label: "Postal Code",
          type: "text",
          value: "110001",
          how: "typed",
        })
      ).status,
    ).toBe(200);
    expect((await you("GET", "/learned")).body.data.map((a: any) => a.value)).toEqual([
      "600100",
    ]);
    expect((await friend("GET", "/learned")).body.data.map((a: any) => a.value)).toEqual([
      "110001",
    ]);
  });

  it("someone else's job, run, trace or snapshot is 'not found'", async () => {
    const { you, friend } = await start();
    await you("GET", "/answer-bank");
    const snapshot = (
      await you("POST", "/trace/snapshots", {
        jobId: "job-yours",
        kind: "dom",
        reason: "review",
        url: "https://x.test/apply",
        content: "<form><input value=Bharghav></form>",
      })
    ).body.data;
    const run = (await you("POST", "/runs", { jobId: "job-yours" })).body.data;
    expect(run.id).toBeTruthy();

    expect((await friend("GET", "/trace/jobs/job-yours")).status).toBe(404);
    expect((await friend("GET", "/trace/jobs/job-yours/export")).status).toBe(404);
    expect((await friend("GET", `/trace/snapshots/${snapshot.id}`)).status).toBe(404);
    expect((await friend("GET", `/runs/${run.id}`)).status).toBe(404);
    expect((await friend("GET", "/runs?jobId=job-yours")).body.data).toEqual([]);
    expect((await friend("GET", "/plans/job-yours")).status).toBe(404);
    expect((await friend("GET", "/kit/job-yours")).status).toBe(404);
    expect((await friend("POST", "/runs", { jobId: "job-yours" })).status).toBe(404);
    expect(
      (
        await friend("POST", "/lookups/results", {
          type: "job",
          ats: "greenhouse",
          jobId: "job-yours",
          token: "acme",
          postingId: "1",
          url: "https://job-boards.greenhouse.io/acme/jobs/1",
          live: true,
        })
      ).status,
    ).toBe(404);
    // A trace event they send for your job is theirs alone: it never shows in yours.
    await friend("POST", "/trace/events", {
      events: [{ jobId: "job-yours", source: "extension", kind: "note", message: "forged" }],
    });
    const yours = (await you("GET", "/trace/jobs/job-yours")).body.data.events;
    expect(yours.map((e: any) => e.message)).not.toContain("forged");
    // Your own: all there.
    expect((await you("GET", `/runs/${run.id}`)).status).toBe(200);
    expect((await you("GET", `/trace/snapshots/${snapshot.id}`)).status).toBe(200);
  });
});
