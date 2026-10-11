import { createJob } from "@shared/testing/factories";
import type { Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LivenessVerdict } from "./classify";
import type { JobLivenessConfig } from "./config";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@server/repositories/jobs", () => ({
  updateJob: vi.fn(),
  getAllJobs: vi.fn(),
  getJobById: vi.fn(),
}));

const NOW = new Date("2026-10-11T12:00:00Z");

const config: JobLivenessConfig = {
  enabled: true,
  checkHour: 3,
  sweepOnSearch: true,
  maxPostingAgeDays: 30,
  expireUnverifiedAfterDays: 45,
  hostConcurrency: 4,
  perHostDelayMs: 0,
  requestTimeoutMs: 1000,
  maxJobsPerSweep: 500,
  pipelineBudgetMs: 60_000,
};

function job(overrides: Partial<Job>): Job {
  return createJob({
    status: "discovered",
    datePosted: null,
    discoveredAt: "2026-10-10T00:00:00Z",
    ...overrides,
  });
}

function checkerFor(verdicts: Record<string, LivenessVerdict>) {
  return vi.fn(
    async (jobUrl: string): Promise<LivenessVerdict> =>
      verdicts[jobUrl] ?? { state: "live", reason: "reachable" },
  );
}

describe("sweepJobs", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // By default the job is still open when the sweep comes to write.
    const jobsRepo = await import("@server/repositories/jobs");
    vi.mocked(jobsRepo.getJobById).mockImplementation(async (id) =>
      job({ id }),
    );
  });

  it("does not overwrite a status the user changed during the sweep", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const { sweepJobs } = await import("./sweep");
    vi.mocked(jobsRepo.getJobById).mockResolvedValue(
      job({ id: "gone", status: "applied" }),
    );

    const summary = await sweepJobs(
      [job({ id: "gone", status: "ready", jobUrl: "https://a.example.com/1" })],
      {
        config,
        now: NOW,
        checkPosting: async () => ({ state: "closed", reason: "HTTP 404" }),
      },
    );

    expect(summary.expired).toBe(0);
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });

  it("never ages out a job after an outage or rate limit", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const { sweepJobs } = await import("./sweep");

    const summary = await sweepJobs(
      [
        job({
          id: "old",
          jobUrl: "https://a.example.com/jobs/1",
          discoveredAt: "2026-01-01T00:00:00Z",
        }),
      ],
      {
        config,
        now: NOW,
        checkPosting: async () => ({
          state: "unknown",
          reason: "Posting could not be fetched: getaddrinfo ENOTFOUND",
        }),
      },
    );

    expect(summary).toMatchObject({ unknown: 1, expired: 0 });
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });

  it("expires closed postings and leaves live ones alone", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const { sweepJobs } = await import("./sweep");
    const jobs = [
      job({ id: "open", jobUrl: "https://a.example.com/jobs/1" }),
      job({ id: "gone", jobUrl: "https://b.example.com/jobs/2" }),
    ];

    const summary = await sweepJobs(jobs, {
      config,
      now: NOW,
      checkPosting: checkerFor({
        "https://b.example.com/jobs/2": {
          state: "closed",
          reason: "Posting returned HTTP 404",
        },
      }),
    });

    expect(summary).toMatchObject({
      total: 2,
      checked: 2,
      live: 1,
      unknown: 0,
      expired: 1,
      notReached: 0,
    });
    expect(summary.expiredJobs).toEqual([
      expect.objectContaining({
        id: "gone",
        reason: "Posting returned HTTP 404",
      }),
    ]);
    expect(jobsRepo.updateJob).toHaveBeenCalledTimes(1);
    expect(jobsRepo.updateJob).toHaveBeenCalledWith("gone", {
      status: "expired",
    });
  });

  it("keeps a recent job whose posting cannot be verified", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const { sweepJobs } = await import("./sweep");

    const summary = await sweepJobs(
      [job({ id: "blocked", jobUrl: "https://a.example.com/jobs/1" })],
      {
        config,
        now: NOW,
        checkPosting: checkerFor({
          "https://a.example.com/jobs/1": {
            state: "unknown",
            reason: "Blocked by a bot challenge",
            unverifiable: true,
          },
        }),
      },
    );

    expect(summary).toMatchObject({ unknown: 1, expired: 0 });
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });

  it("expires an unverifiable job once it is past the age fallback", async () => {
    const { sweepJobs } = await import("./sweep");
    const unknown: LivenessVerdict = {
      state: "unknown",
      reason: "Posting returned HTTP 401",
      unverifiable: true,
    };

    const summary = await sweepJobs(
      [
        job({
          id: "by-discovery",
          jobUrl: "https://a.example.com/jobs/1",
          discoveredAt: "2026-08-25T00:00:00Z",
        }),
        job({
          id: "by-posting-date",
          jobUrl: "https://b.example.com/jobs/2",
          datePosted: "2026-07-01",
        }),
        job({
          id: "manual",
          source: "manual",
          jobUrl: "https://c.example.com/jobs/3",
          discoveredAt: "2026-01-01T00:00:00Z",
        }),
      ],
      { config, now: NOW, checkPosting: async () => unknown },
    );

    expect(summary.expiredJobs.map((expired) => expired.id).sort()).toEqual([
      "by-discovery",
      "by-posting-date",
    ]);
    expect(summary.unknown).toBe(1);
  });

  it("never expires an old job that is verified live", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const { sweepJobs } = await import("./sweep");

    const summary = await sweepJobs(
      [
        job({
          id: "old-but-open",
          jobUrl: "https://a.example.com/jobs/1",
          discoveredAt: "2026-01-01T00:00:00Z",
        }),
      ],
      { config, now: NOW, checkPosting: checkerFor({}) },
    );

    expect(summary).toMatchObject({ live: 1, expired: 0 });
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });

  it("respects the age fallback being disabled", async () => {
    const { sweepJobs } = await import("./sweep");

    const summary = await sweepJobs(
      [
        job({
          id: "old",
          jobUrl: "https://a.example.com/jobs/1",
          discoveredAt: "2026-01-01T00:00:00Z",
        }),
      ],
      {
        config: { ...config, expireUnverifiedAfterDays: 0 },
        now: NOW,
        checkPosting: async () => ({
          state: "unknown",
          reason: "HTTP 403",
          unverifiable: true,
        }),
      },
    );

    expect(summary).toMatchObject({ unknown: 1, expired: 0 });
  });

  it("stops requesting postings once asked to stop", async () => {
    const { sweepJobs } = await import("./sweep");
    const checkPosting = checkerFor({});
    let calls = 0;

    const summary = await sweepJobs(
      [1, 2, 3].map((n) =>
        job({ id: `job-${n}`, jobUrl: `https://a.example.com/jobs/${n}` }),
      ),
      {
        config,
        now: NOW,
        checkPosting: async (url) => {
          calls += 1;
          return checkPosting(url);
        },
        shouldStop: () => calls >= 1,
      },
    );

    expect(calls).toBe(1);
    expect(summary).toMatchObject({ total: 3, checked: 1, notReached: 2 });
  });

  it("spaces out requests to the same host only", async () => {
    const { sweepJobs } = await import("./sweep");
    const sleep = vi.fn(async () => undefined);

    await sweepJobs(
      [
        job({ id: "a1", jobUrl: "https://a.example.com/jobs/1" }),
        job({ id: "a2", jobUrl: "https://a.example.com/jobs/2" }),
        job({ id: "b1", jobUrl: "https://b.example.com/jobs/1" }),
      ],
      {
        config: { ...config, perHostDelayMs: 250 },
        now: NOW,
        checkPosting: checkerFor({}),
        sleep,
      },
    );

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("counts a failing check as unknown and carries on", async () => {
    const { sweepJobs } = await import("./sweep");

    const summary = await sweepJobs(
      [
        job({ id: "boom", jobUrl: "https://a.example.com/jobs/1" }),
        job({ id: "fine", jobUrl: "https://b.example.com/jobs/2" }),
      ],
      {
        config,
        now: NOW,
        checkPosting: async (url) => {
          if (url.includes("a.example.com")) throw new Error("socket hang up");
          return { state: "live", reason: "reachable" };
        },
      },
    );

    expect(summary).toMatchObject({ live: 1, unknown: 1, expired: 0 });
  });

  it("caps the number of jobs handled per sweep", async () => {
    const { sweepJobs } = await import("./sweep");
    const checkPosting = checkerFor({});

    const summary = await sweepJobs(
      [1, 2, 3].map((n) =>
        job({ id: `job-${n}`, jobUrl: `https://h${n}.example.com/jobs/1` }),
      ),
      { config: { ...config, maxJobsPerSweep: 2 }, now: NOW, checkPosting },
    );

    expect(summary.total).toBe(2);
    expect(checkPosting).toHaveBeenCalledTimes(2);
  });
});

describe("sweepOpenJobsInScope", () => {
  it("checks only open jobs, oldest first", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const { sweepOpenJobsInScope } = await import("./sweep");
    vi.mocked(jobsRepo.getAllJobs).mockResolvedValue([
      job({
        id: "newer",
        jobUrl: "https://a.example.com/jobs/2",
        discoveredAt: "2026-10-09T00:00:00Z",
      }),
      job({
        id: "older",
        jobUrl: "https://a.example.com/jobs/1",
        discoveredAt: "2026-09-01T00:00:00Z",
      }),
    ]);
    const checkPosting = checkerFor({});

    await sweepOpenJobsInScope({ config, now: NOW, checkPosting });

    expect(jobsRepo.getAllJobs).toHaveBeenCalledWith(["discovered", "ready"]);
    expect(checkPosting.mock.calls.map(([url]) => url)).toEqual([
      "https://a.example.com/jobs/1",
      "https://a.example.com/jobs/2",
    ]);
  });
});
