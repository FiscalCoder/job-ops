import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob } from "@shared/testing/factories.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scoredJob = {
  ...createJob({ id: "job-auto-tailor-1", status: "discovered" }),
  suitabilityScore: 85,
  suitabilityReason: "Great fit",
};

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-auto-tailor-1",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    jobsDiscovered: 0,
    jobsProcessed: 0,
    errorMessage: null,
  })),
  updatePipelineRun: vi.fn(async () => undefined),
}));

vi.mock("./steps", () => ({
  loadProfileStep: vi.fn(async () => ({})),
  discoverJobsStep: vi.fn(async () => ({
    discoveredJobs: [],
    sourceErrors: [],
    pendingChallenges: [],
  })),
  importJobsStep: vi.fn(async () => ({
    created: 0,
    skipped: 0,
    fuzzyMerged: 0,
  })),
  scoreJobsStep: vi.fn(async () => ({
    unprocessedJobs: [],
    scoredJobs: [scoredJob],
  })),
  selectJobsStep: vi.fn(async () => [scoredJob]),
  processJobsStep: vi.fn(async () => ({ processedCount: 1 })),
  notifyPipelineWebhookStep: vi.fn(async () => undefined),
}));

const baseLocationIntent = {
  selectedCountry: "united kingdom",
  country: "united kingdom",
  cityLocations: [] as string[],
  workplaceTypes: [] as Array<"remote" | "hybrid" | "onsite">,
  geoScope: "selected_only" as const,
  searchScope: "selected_only" as const,
  matchStrictness: "flexible" as const,
};

describe.sequential("pipeline auto-tailoring toggle", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-pipeline-auto-tailor-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("skips processJobsStep when enableAutoTailoring is explicitly false, leaving selected jobs unprocessed", async () => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    const result = await pipeline.runPipeline({
      sources: ["gradcracker"],
      locationIntent: baseLocationIntent,
      enableAutoTailoring: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        jobsProcessed: 0,
      }),
    );
    expect(vi.mocked(steps.selectJobsStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(steps.processJobsStep)).not.toHaveBeenCalled();
  });

  it("still calls processJobsStep by default (enableAutoTailoring unset)", async () => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    const result = await pipeline.runPipeline({
      sources: ["gradcracker"],
      locationIntent: baseLocationIntent,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        jobsProcessed: 1,
      }),
    );
    expect(vi.mocked(steps.processJobsStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(steps.processJobsStep)).toHaveBeenCalledWith(
      expect.objectContaining({
        jobsToProcess: [scoredJob],
      }),
    );
  });

  it("skips processJobsStep when the persisted autoTailorOnPipelineRun setting is false", async () => {
    const pipeline = await import("./orchestrator");
    const settingsRepo = await import("../repositories/settings");
    const steps = await import("./steps");

    await settingsRepo.setSetting("autoTailorOnPipelineRun", "0");

    const result = await pipeline.runPipeline({
      sources: ["gradcracker"],
      locationIntent: baseLocationIntent,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        jobsProcessed: 0,
      }),
    );
    expect(vi.mocked(steps.processJobsStep)).not.toHaveBeenCalled();
  });
});
