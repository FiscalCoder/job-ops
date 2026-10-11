import { createJob } from "@shared/testing/factories";
import type { Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@server/repositories/jobs", () => ({
  getJobById: vi.fn(),
  updateJob: vi.fn(),
  getAllJobs: vi.fn(),
}));

async function setup(jobs: Job[]) {
  const jobsRepo = await import("@server/repositories/jobs");
  vi.mocked(jobsRepo.getJobById).mockImplementation(
    async (id) => jobs.find((job) => job.id === id) ?? null,
  );
  const { expireJobsManually } = await import("./manual-expire");
  return { jobsRepo, expireJobsManually };
}

describe("expireJobsManually", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expires discovered and ready jobs", async () => {
    const { jobsRepo, expireJobsManually } = await setup([
      createJob({ id: "a", status: "discovered" }),
      createJob({ id: "b", status: "ready" }),
    ]);

    const summary = await expireJobsManually(["a", "b"]);

    expect(summary).toMatchObject({ requested: 2, succeeded: 2, failed: 0 });
    expect(jobsRepo.updateJob).toHaveBeenCalledWith("a", { status: "expired" });
    expect(jobsRepo.updateJob).toHaveBeenCalledWith("b", { status: "expired" });
  });

  it.each([
    "applied",
    "in_progress",
    "processing",
    "skipped",
    "expired",
  ] as const)("refuses a job that is %s", async (status) => {
    const { jobsRepo, expireJobsManually } = await setup([
      createJob({ id: "a", status }),
    ]);

    const summary = await expireJobsManually(["a"]);

    expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(summary.results[0]?.message).toContain(status);
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });

  it("reports missing jobs without failing the rest", async () => {
    const { expireJobsManually } = await setup([
      createJob({ id: "a", status: "discovered" }),
    ]);

    const summary = await expireJobsManually(["missing", "a"]);

    expect(summary).toMatchObject({ requested: 2, succeeded: 1, failed: 1 });
    expect(summary.results).toEqual([
      { jobId: "missing", ok: false, message: "Job not found" },
      { jobId: "a", ok: true },
    ]);
  });

  it("ignores duplicate ids", async () => {
    const { jobsRepo, expireJobsManually } = await setup([
      createJob({ id: "a", status: "discovered" }),
    ]);

    const summary = await expireJobsManually(["a", "a"]);

    expect(summary.requested).toBe(1);
    expect(jobsRepo.updateJob).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one update throws", async () => {
    const { jobsRepo, expireJobsManually } = await setup([
      createJob({ id: "a", status: "discovered" }),
      createJob({ id: "b", status: "discovered" }),
    ]);
    vi.mocked(jobsRepo.updateJob).mockRejectedValueOnce(
      new Error("database is locked"),
    );

    const summary = await expireJobsManually(["a", "b"]);

    expect(summary).toMatchObject({ succeeded: 1, failed: 1 });
    expect(summary.results[0]).toEqual({
      jobId: "a",
      ok: false,
      message: "Failed to expire job",
    });
  });
});
