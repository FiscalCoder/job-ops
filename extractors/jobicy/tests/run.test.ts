import { describe, expect, it, vi } from "vitest";
import {
  buildJobicySearchUrl,
  mapJobicyJob,
  matchesJobicyLocation,
  runJobicy,
} from "../src/run";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("Jobicy extractor", () => {
  it("builds a search URL using the tag param", () => {
    const url = buildJobicySearchUrl({
      searchTerm: "backend engineer",
      count: 100,
    });
    expect(url.origin + url.pathname).toBe(
      "https://jobicy.com/api/v2/remote-jobs",
    );
    expect(url.searchParams.get("tag")).toBe("backend engineer");
    expect(url.searchParams.get("count")).toBe("50");
  });

  it("maps Jobicy fields into a normalized job", () => {
    expect(
      mapJobicyJob({
        id: 151531,
        url: "https://jobicy.com/jobs/151531-senior-go-engineer",
        jobTitle: "Senior Go Engineer",
        companyName: "Acme",
        jobIndustry: ["Engineering"],
        jobType: ["Full-Time"],
        jobGeo: "USA",
        jobLevel: "Senior",
        jobDescription: "<p>Build things</p>",
        pubDate: "2026-06-18T00:00:00+00:00",
        salaryMin: 90000,
        salaryMax: 130000,
        salaryCurrency: "USD",
        salaryPeriod: "year",
        companyLogo: "https://jobicy.com/logo.png",
      }),
    ).toEqual(
      expect.objectContaining({
        source: "jobicy",
        sourceJobId: "151531",
        title: "Senior Go Engineer",
        employer: "Acme",
        jobUrl: "https://jobicy.com/jobs/151531-senior-go-engineer",
        applicationLink: "https://jobicy.com/jobs/151531-senior-go-engineer",
        location: "USA",
        jobDescription: "<p>Build things</p>",
        datePosted: "2026-06-18T00:00:00+00:00",
        salary: "USD 90,000–130,000/year",
        salaryMinAmount: 90000,
        salaryMaxAmount: 130000,
        salaryCurrency: "USD",
        jobType: "Full-Time",
        jobLevel: "Senior",
        jobFunction: "Engineering",
        companyLogo: "https://jobicy.com/logo.png",
        isRemote: true,
      }),
    );
  });

  it("returns null when required fields are missing", () => {
    expect(mapJobicyJob({ jobTitle: "No company or URL" })).toBeNull();
  });

  describe("matchesJobicyLocation", () => {
    it("matches worldwide/unset country and blank geo", () => {
      expect(matchesJobicyLocation(undefined, "germany")).toBe(true);
      expect(matchesJobicyLocation("USA", "worldwide")).toBe(true);
      expect(matchesJobicyLocation("USA", undefined)).toBe(true);
    });

    it("matches when jobGeo mentions the selected country", () => {
      expect(matchesJobicyLocation("USA", "united states")).toBe(true);
    });

    it("rejects jobGeo tied to a different country", () => {
      expect(matchesJobicyLocation("Germany", "united states")).toBe(false);
    });
  });

  it("fetches once per term and de-duplicates upstream URLs", async () => {
    const row = {
      id: 1,
      url: "https://jobicy.com/jobs/1",
      jobTitle: "Software Engineer",
      companyName: "Acme",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [row] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [row] }));

    const result = await runJobicy({
      searchTerms: ["software", "engineer"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [expect.any(Object)] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips the source entirely when hybrid/onsite is requested without remote", async () => {
    const fetchMock = vi.fn();
    const result = await runJobicy({
      workplaceTypes: ["onsite"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Jobicy's own error payload", async () => {
    const result = await runJobicy({
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ success: false, error: "Invalid 'geo' value." }),
        ),
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Invalid 'geo' value.",
    });
  });

  it("returns a status-only error for failed upstream requests", async () => {
    const result = await runJobicy({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 503)),
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Jobicy request failed with status 503",
    });
  });
});
