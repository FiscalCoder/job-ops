import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runHackerNews: vi.fn(),
}));

describe("hackernews manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards shared automatic-run settings", async () => {
    const { manifest } = await import("../src/manifest");
    const { runHackerNews } = await import("../src/run");
    vi.mocked(runHackerNews).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "hackernews",
      selectedSources: ["hackernews"],
      settings: {
        jobspyResultsWanted: "70",
        workplaceTypes: '["remote"]',
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "uk",
    });

    expect(runHackerNews).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote"],
        selectedCountry: "uk",
      }),
    );
  });
});
