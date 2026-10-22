import type { PipelineSearchPresetConfig } from "@shared/types";
import { describe, expect, it } from "vitest";
import { getDailySearchConfig, runConfigFor } from "./scheduler";

describe("daily search", () => {
  it("is off until a saved search is named, and runs at 01:00 UTC unless told otherwise", () => {
    expect(getDailySearchConfig({})).toEqual({ presetName: null, hour: 1 });
    expect(
      getDailySearchConfig({
        DAILY_SEARCH_PRESET: " Remote+onsite v1 ",
        DAILY_SEARCH_HOUR: "2",
      }),
    ).toEqual({ presetName: "Remote+onsite v1", hour: 2 });
    expect(
      getDailySearchConfig({ DAILY_SEARCH_PRESET: "x", DAILY_SEARCH_HOUR: "25" })
        .hour,
    ).toBe(1);
  });

  it("runs the saved search with the settings the Run button sends", () => {
    const preset = {
      searchTerms: ["Software Engineer"],
      sources: ["linkedin", "naukri"],
      country: "india",
      cityLocations: ["chennai"],
      locationMode: "cities",
      proximity: null,
      workplaceTypes: ["remote", "hybrid"],
      searchScope: "selected_plus_remote_worldwide",
      matchStrictness: "exact_only",
      topN: 10,
      minSuitabilityScore: 70,
      runBudget: 300,
      scoringInstructions: "Prioritise remote roles",
    } as unknown as PipelineSearchPresetConfig;
    const run = runConfigFor(preset);
    expect(run).toMatchObject({
      topN: 10,
      minSuitabilityScore: 70,
      sources: ["linkedin", "naukri"],
      runBudget: 300,
      scoringInstructions: "Prioritise remote roles",
    });
    expect(run.locationIntent).toBeTruthy();
    expect("watchlistSelectedSourceIds" in run).toBe(false);
  });
});
