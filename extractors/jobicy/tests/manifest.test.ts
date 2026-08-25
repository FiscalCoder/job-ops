import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runJobicy: vi.fn(),
}));

describe("jobicy manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards shared automatic-run settings", async () => {
    const { manifest } = await import("../src/manifest");
    const { runJobicy } = await import("../src/run");
    vi.mocked(runJobicy).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "jobicy",
      selectedSources: ["jobicy"],
      settings: {
        jobspyResultsWanted: "70",
        workplaceTypes: '["remote"]',
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "uk",
    });

    expect(runJobicy).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote"],
        selectedCountry: "uk",
      }),
    );
  });
});
