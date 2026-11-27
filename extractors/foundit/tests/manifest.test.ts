import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runFoundit: vi.fn(),
}));

describe("foundit manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes cities, the limit, known jobs and the length setting", async () => {
    const { manifest } = await import("../src/manifest");
    const { runFoundit } = await import("../src/run");
    vi.mocked(runFoundit).mockResolvedValue({
      success: true,
      jobs: [],
      errors: ["x: down"],
    });

    const result = await manifest.run({
      source: "foundit",
      selectedSources: ["foundit"],
      settings: {
        jobspyResultsWanted: "7",
        searchCities: "mumbai",
        internshipDurationMonths: "2-3",
      },
      searchTerms: ["Marketing Intern"],
      selectedCountry: "india",
      getExistingJobUrls: async () => ["https://www.foundit.in/job/x"],
    });

    expect(runFoundit).toHaveBeenCalledWith(
      expect.objectContaining({
        cities: ["mumbai"],
        duration: { minMonths: 2, maxMonths: 3 },
        maxJobsPerTerm: 7,
        existingJobUrls: ["https://www.foundit.in/job/x"],
      }),
    );
    expect(result.sourceErrors).toEqual(["x: down"]);
  });
});
