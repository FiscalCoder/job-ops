import type { CreateJobInput } from "@shared/types";
import { describe, expect, it, vi } from "vitest";
import { importJobsStep } from "./import-jobs";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@server/repositories/jobs", () => ({
  createJobs: vi.fn(async () => ({ created: 1, skipped: 0 })),
  listJobLinks: vi.fn(async () => [
    {
      jobUrl: "https://www.linkedin.com/jobs/view/111",
      applicationLink: "https://job-boards.greenhouse.io/acme/jobs/4000001",
    },
  ]),
}));

vi.mock("../progress", () => ({
  progressHelpers: {
    importingJob: vi.fn(),
    importComplete: vi.fn(),
  },
}));

describe("importJobsStep", () => {
  it("publishes the job currently being imported", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const { progressHelpers } = await import("../progress");
    const job: CreateJobInput = {
      source: "linkedin",
      title: "Frontend Engineer",
      employer: "Monzo",
      jobUrl: "https://example.com/jobs/1",
    };

    await importJobsStep({ discoveredJobs: [job] });

    const onProgress = vi.mocked(jobsRepo.createJobs).mock.calls[0]?.[1];
    expect(onProgress).toBeTypeOf("function");
    onProgress?.(job, 1, 1);

    expect(progressHelpers.importingJob).toHaveBeenCalledWith(1, 1, {
      id: job.jobUrl,
      title: job.title,
      employer: job.employer,
    });
  });

  it("one posting under several links is one job; a posting already stored is skipped", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    vi.mocked(jobsRepo.createJobs).mockClear();
    const job = (jobUrl: string, applicationLink?: string): CreateJobInput => ({
      source: "linkedin",
      title: "Engineer",
      employer: "Acme",
      jobUrl,
      ...(applicationLink ? { applicationLink } : {}),
    });
    const result = await importJobsStep({
      discoveredJobs: [
        // Stored already, under its LinkedIn listing.
        job("https://acme.com/careers?gh_jid=4000001"),
        // One Workday requisition, listed per city.
        job("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Pune/Engineer_R-123"),
        { ...job("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Chennai/Engineer_R-123"), title: "Software Engineer II" },
      ],
    });
    const created = vi.mocked(jobsRepo.createJobs).mock.calls[0]?.[0] as CreateJobInput[];
    expect(created.map((j) => j.jobUrl)).toEqual([
      "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Pune/Engineer_R-123",
    ]);
    expect(result.fuzzyMerged).toBe(2);
  });
});
