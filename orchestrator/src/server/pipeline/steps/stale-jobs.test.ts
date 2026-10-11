import { createJob } from "@shared/testing/factories";
import type { CreateJobInput } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@server/repositories/jobs", () => ({
  getUnscoredDiscoveredJobs: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock("@server/services/job-liveness/sweep", () => ({
  sweepJobs: vi.fn(),
}));

vi.mock("../progress", () => ({
  updateProgress: vi.fn(),
}));

function posting(overrides: Partial<CreateJobInput>): CreateJobInput {
  return {
    source: "linkedin",
    title: "Backend Engineer",
    employer: "Acme",
    jobUrl: "https://example.com/jobs/1",
    ...overrides,
  };
}

describe("stale-jobs pipeline step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("dropStalePostings", () => {
    it("drops postings older than the default 30 day limit", async () => {
      const { dropStalePostings } = await import("./stale-jobs");

      const kept = dropStalePostings([
        posting({ jobUrl: "https://example.com/1", datePosted: "2026-10-01" }),
        posting({ jobUrl: "https://example.com/2", datePosted: "2026-07-01" }),
        posting({ jobUrl: "https://example.com/3" }),
      ]);

      expect(kept.map((job) => job.jobUrl)).toEqual([
        "https://example.com/1",
        "https://example.com/3",
      ]);
    });

    it("honours JOB_MAX_POSTING_AGE_DAYS", async () => {
      vi.stubEnv("JOB_MAX_POSTING_AGE_DAYS", "0");
      const { dropStalePostings } = await import("./stale-jobs");

      const kept = dropStalePostings([posting({ datePosted: "2020-01-01" })]);

      expect(kept).toHaveLength(1);
    });
  });

  describe("expireClosedJobsStep", () => {
    it("does nothing when liveness checks are disabled", async () => {
      vi.stubEnv("JOB_LIVENESS_ENABLED", "false");
      const jobsRepo = await import("@server/repositories/jobs");
      const { expireClosedJobsStep } = await import("./stale-jobs");

      await expect(expireClosedJobsStep({})).resolves.toBeNull();
      expect(jobsRepo.getUnscoredDiscoveredJobs).not.toHaveBeenCalled();
    });

    it("sweeps the jobs that are about to be scored", async () => {
      vi.stubEnv("JOB_LIVENESS_ENABLED", "true");
      const jobsRepo = await import("@server/repositories/jobs");
      const { sweepJobs } = await import("@server/services/job-liveness/sweep");
      const { expireClosedJobsStep } = await import("./stale-jobs");
      const unscored = [createJob({ id: "job-1" })];
      const summary = {
        total: 1,
        checked: 1,
        live: 0,
        unknown: 0,
        expired: 1,
        notReached: 0,
        expiredJobs: [],
      };
      vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue(unscored);
      vi.mocked(sweepJobs).mockResolvedValue(summary);

      await expect(expireClosedJobsStep({})).resolves.toEqual(summary);
      expect(sweepJobs).toHaveBeenCalledWith(
        unscored,
        expect.objectContaining({ shouldStop: expect.any(Function) }),
      );
    });

    it("stops on cancellation or when the time budget runs out", async () => {
      vi.stubEnv("JOB_LIVENESS_ENABLED", "true");
      const jobsRepo = await import("@server/repositories/jobs");
      const { sweepJobs } = await import("@server/services/job-liveness/sweep");
      const { expireClosedJobsStep } = await import("./stale-jobs");
      let cancelled = false;
      vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue([
        createJob({ id: "job-1" }),
      ]);
      vi.mocked(sweepJobs).mockResolvedValue({
        total: 1,
        checked: 0,
        live: 0,
        unknown: 0,
        expired: 0,
        notReached: 1,
        expiredJobs: [],
      });

      await expireClosedJobsStep({ shouldCancel: () => cancelled });
      const shouldStop = vi.mocked(sweepJobs).mock.calls[0]?.[1]?.shouldStop;

      expect(shouldStop?.()).toBe(false);
      cancelled = true;
      expect(shouldStop?.()).toBe(true);
      cancelled = false;
      vi.advanceTimersByTime(61_000);
      expect(shouldStop?.()).toBe(true);
    });

    it("never fails the pipeline when the check throws", async () => {
      vi.stubEnv("JOB_LIVENESS_ENABLED", "true");
      const jobsRepo = await import("@server/repositories/jobs");
      const { expireClosedJobsStep } = await import("./stale-jobs");
      vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockRejectedValue(
        new Error("database is locked"),
      );

      await expect(expireClosedJobsStep({})).resolves.toBeNull();
    });
  });
});
