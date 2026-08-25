import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runRemotive: vi.fn(),
}));

describe("remotive manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards shared automatic-run settings", async () => {
    const { manifest } = await import("../src/manifest");
    const { runRemotive } = await import("../src/run");
    vi.mocked(runRemotive).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "remotive",
      selectedSources: ["remotive"],
      settings: {
        jobspyResultsWanted: "70",
        workplaceTypes: '["remote"]',
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "uk",
    });

    expect(runRemotive).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote"],
        selectedCountry: "uk",
      }),
    );
  });
});
