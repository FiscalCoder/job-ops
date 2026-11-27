import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runInternshala: vi.fn(),
}));

describe("internshala manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes cities, the per-search limit and the tenant's length setting", async () => {
    const { manifest } = await import("../src/manifest");
    const { runInternshala } = await import("../src/run");
    vi.mocked(runInternshala).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "internshala",
      selectedSources: ["internshala"],
      settings: {
        jobspyResultsWanted: "7",
        searchCities: "mumbai",
        internshipDurationMonths: "2-3",
      },
      searchTerms: ["Marketing Intern"],
      selectedCountry: "india",
      getExistingJobUrls: async () => ["https://internshala.com/x"],
    });

    expect(runInternshala).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["Marketing Intern"],
        cities: ["mumbai"],
        duration: { minMonths: 2, maxMonths: 3 },
        maxJobsPerTerm: 7,
        existingJobUrls: ["https://internshala.com/x"],
      }),
    );
  });

  it("searches any length when the setting is unset", async () => {
    const { manifest } = await import("../src/manifest");
    const { runInternshala } = await import("../src/run");
    vi.mocked(runInternshala).mockResolvedValue({
      success: true,
      jobs: [],
      errors: ["marketing: down"],
    });

    const result = await manifest.run({
      source: "internshala",
      selectedSources: ["internshala"],
      settings: {},
      searchTerms: ["marketing"],
      selectedCountry: "india",
    });

    expect(runInternshala).toHaveBeenCalledWith(
      expect.objectContaining({ duration: null, maxJobsPerTerm: 20 }),
    );
    expect(result.sourceErrors).toEqual(["marketing: down"]);
  });
});
