import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runRemoteOk: vi.fn(),
}));

describe("remoteok manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards shared automatic-run settings", async () => {
    const { manifest } = await import("../src/manifest");
    const { runRemoteOk } = await import("../src/run");
    vi.mocked(runRemoteOk).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "remoteok",
      selectedSources: ["remoteok"],
      settings: {
        jobspyResultsWanted: "70",
        workplaceTypes: '["remote"]',
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "uk",
    });

    expect(runRemoteOk).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote"],
        selectedCountry: "uk",
      }),
    );
  });
});
