import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { companyWindow, limitFor } from "../src/resolver/company-window.js";
import type { CompanyLimit } from "../src/store/company-limits-repo.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * Companies that take only so many applications from you (Amazon: one per six months): the
 * queue says where you stand with each, so you pick your one best role there.
 */

const amazon: CompanyLimit = {
  id: 1,
  companyKey: "amazon",
  name: "Amazon",
  maxApplications: 1,
  windowDays: 183,
  note: "",
};
const google: CompanyLimit = {
  ...amazon,
  id: 2,
  companyKey: "google",
  name: "Google",
  maxApplications: 3,
  windowDays: 30,
};

describe("company windows", () => {
  it("a company's limit covers its divisions and legal names, and nothing else", () => {
    const limits = [amazon, google];
    expect(limitFor("Amazon Development Centre India Pvt Ltd", limits)?.name).toBe(
      "Amazon",
    );
    expect(limitFor("Amazon Web Services (AWS)", limits)?.name).toBe("Amazon");
    expect(limitFor("Google Cloud", limits)?.name).toBe("Google");
    expect(limitFor("Walmart", limits)).toBeNull();
  });

  it("one per six months: used by an application in the window, open again after it", () => {
    const applied = [
      {
        jobId: "a1",
        title: "SDE II",
        employer: "Amazon",
        appliedAt: "2026-09-17T10:00:00.000Z",
      },
    ];
    const used = companyWindow(amazon, applied, new Date("2026-10-22T00:00:00Z"));
    expect(used).toMatchObject({ full: true, nextOpen: "2027-03-19" });
    expect(used.used.map((u) => u.title)).toEqual(["SDE II"]);
    const later = companyWindow(amazon, applied, new Date("2027-03-20T00:00:00Z"));
    expect(later).toMatchObject({ full: false, nextOpen: null, used: [] });
  });

  it("three in thirty days: full only at three, and the oldest of them frees a place", () => {
    const at = (day: string) => ({
      jobId: day,
      title: "SWE",
      employer: "Google",
      appliedAt: `2026-10-${day}T09:00:00.000Z`,
    });
    const now = new Date("2026-10-22T00:00:00Z");
    expect(companyWindow(google, [at("01"), at("10")], now).full).toBe(false);
    const full = companyWindow(google, [at("05"), at("10"), at("20")], now);
    expect(full).toMatchObject({ full: true, nextOpen: "2026-11-04" });
  });
});

const job = (more: Partial<JobOpsJob>): JobOpsJob => ({
  id: "x",
  title: "Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://example.com/job",
  applicationLink: null,
  suitabilityScore: 80,
  ...more,
});
const jobs = [
  job({ id: "aws-1", title: "SDE II", employer: "Amazon", datePosted: "2026-10-18" }),
  job({ id: "aws-2", title: "SDE III", employer: "Amazon Web Services" }),
  job({ id: "acme", employer: "Acme", datePosted: "2026-10-20" }),
  job({
    id: "applied-aws",
    status: "applied",
    title: "SDE I",
    employer: "Amazon",
    appliedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  }),
];

const jobOps: JobOpsApi = {
  login: async () => ({ token: "good", expiresIn: 3600 }),
  me: async (t) => {
    // Job Ops' admin: the seeded limits (from before there were users) become theirs.
    if (t === "good") return { id: "u1", username: "me", isSystemAdmin: true };
    throw new JobOpsError(401, "UNAUTHORIZED", "nope");
  },
  listJobs: async (_t, statuses) => {
    const found = jobs.filter((j) => statuses.includes(j.status));
    return { jobs: found, total: found.length, revision: "r" };
  },
  getJob: async () => {
    throw new JobOpsError(404, "NOT_FOUND", "no job");
  },
  updateJob: async () => {},
  addNote: async () => {},
  markApplied: async () => {},
  skipJob: async () => {},
  getPdf: async () => new Uint8Array(),
  getDesignResume: async () => fakeDesignResume,
};

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("company limits over HTTP", () => {
  it("starts from a known list you can change, and the queue says where you stand", async () => {
    const server = createApp({
      jobOps,
      db: openStore(":memory:"),
      authCacheSeconds: 60,
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
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

    const seeded = await call("GET", "/company-limits");
    expect(seeded.json.data.map((l: CompanyLimit) => l.name)).toEqual([
      "Amazon",
      "ElevenLabs",
      "Google",
    ]);

    const queue = (await call("GET", "/queue")).json.data;
    const byId = (id: string) => queue.find((q: any) => q.jobId === id);
    // Both Amazon roles share the window your last Amazon application used.
    for (const id of ["aws-1", "aws-2"])
      expect(byId(id).companyLimit).toMatchObject({
        name: "Amazon",
        full: true,
        used: [{ jobId: "applied-aws", title: "SDE I" }],
      });
    expect(byId("aws-1").postedAt).toBe("2026-10-18");
    expect(byId("acme")).toMatchObject({ companyLimit: null, postedAt: "2026-10-20" });

    // You mark Acme as one per 90 days; then remove it again.
    const added = await call("PUT", "/company-limits", {
      name: "Acme Inc",
      maxApplications: 1,
      windowDays: 90,
    });
    expect(added.json.data).toMatchObject({ companyKey: "acme", windowDays: 90 });
    expect(
      (await call("GET", "/queue")).json.data.find((q: any) => q.jobId === "acme")
        .companyLimit,
    ).toMatchObject({ name: "Acme Inc", full: false });
    expect((await call("DELETE", `/company-limits/${added.json.data.id}`)).status).toBe(
      200,
    );
    expect((await call("DELETE", "/company-limits/999")).status).toBe(404);
    expect(
      (await call("PUT", "/company-limits", { name: "", maxApplications: 0 })).status,
    ).toBe(400);
  });
});
