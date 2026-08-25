import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runArbeitnow: vi.fn(),
}));

describe("arbeitnow manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards shared automatic-run settings", async () => {
    const { manifest } = await import("../src/manifest");
    const { runArbeitnow } = await import("../src/run");
    vi.mocked(runArbeitnow).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "arbeitnow",
      selectedSources: ["arbeitnow"],
      settings: {
        jobspyResultsWanted: "70",
        workplaceTypes: '["remote"]',
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "uk",
    });

    expect(runArbeitnow).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote"],
      }),
    );
  });
});
