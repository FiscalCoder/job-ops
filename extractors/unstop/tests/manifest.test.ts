import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runUnstop: vi.fn(),
}));

describe("unstop manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes cities, workplace types, the limit and the length setting", async () => {
    const { manifest } = await import("../src/manifest");
    const { runUnstop } = await import("../src/run");
    vi.mocked(runUnstop).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "unstop",
      selectedSources: ["unstop"],
      settings: {
        jobspyResultsWanted: "7",
        searchCities: "mumbai",
        workplaceTypes: '["remote","bogus","onsite"]',
        internshipDurationMonths: "2-3",
      },
      searchTerms: ["Marketing Intern"],
      selectedCountry: "india",
    });

    expect(runUnstop).toHaveBeenCalledWith(
      expect.objectContaining({
        cities: ["mumbai"],
        workplaceTypes: ["remote", "onsite"],
        includeRemote: true,
        duration: { minMonths: 2, maxMonths: 3 },
        maxJobsPerTerm: 7,
      }),
    );
  });

  it("leaves out remote listings for a selected-cities-only search", async () => {
    const { manifest } = await import("../src/manifest");
    const { runUnstop } = await import("../src/run");
    vi.mocked(runUnstop).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "unstop",
      selectedSources: ["unstop"],
      settings: {
        searchCities: "mumbai",
        locationSearchScope: "selected_only",
      },
      searchTerms: ["marketing"],
      selectedCountry: "india",
    });

    expect(runUnstop).toHaveBeenCalledWith(
      expect.objectContaining({ includeRemote: false }),
    );
  });

  it("returns partial errors as source errors", async () => {
    const { manifest } = await import("../src/manifest");
    const { runUnstop } = await import("../src/run");
    vi.mocked(runUnstop).mockResolvedValue({
      success: true,
      jobs: [],
      errors: ["marketing: down"],
    });

    const result = await manifest.run({
      source: "unstop",
      selectedSources: ["unstop"],
      settings: { workplaceTypes: "not json" },
      searchTerms: ["marketing"],
      selectedCountry: "india",
    });

    expect(runUnstop).toHaveBeenCalledWith(
      expect.objectContaining({ workplaceTypes: undefined, duration: null }),
    );
    expect(result.sourceErrors).toEqual(["marketing: down"]);
  });
});
