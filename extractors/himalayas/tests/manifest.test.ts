import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runHimalayas: vi.fn(),
}));

describe("himalayas manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards shared automatic-run settings", async () => {
    const { manifest } = await import("../src/manifest");
    const { runHimalayas } = await import("../src/run");
    vi.mocked(runHimalayas).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "himalayas",
      selectedSources: ["himalayas"],
      settings: {
        jobspyResultsWanted: "70",
        workplaceTypes: '["remote"]',
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "uk",
    });

    expect(runHimalayas).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote"],
        selectedCountry: "uk",
      }),
    );
  });
});
