import { describe, expect, it, vi } from "vitest";
import {
  buildHimalayasSearchUrl,
  mapHimalayasJob,
  matchesHimalayasLocation,
  runHimalayas,
} from "../src/run";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("Himalayas extractor", () => {
  it("builds a search URL with the search term and limit", () => {
    const url = buildHimalayasSearchUrl({
      searchTerm: "backend engineer",
      limit: 250,
    });
    expect(url.origin + url.pathname).toBe("https://himalayas.app/jobs/api");
    expect(url.searchParams.get("search")).toBe("backend engineer");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("maps Himalayas fields into a normalized job", () => {
    expect(
      mapHimalayasJob({
        title: "Senior Go Engineer",
        companyName: "Acme",
        employmentType: "Full Time",
        minSalary: 90000,
        maxSalary: 130000,
        salaryPeriod: "annual",
        currency: "USD",
        seniority: ["Senior"],
        locationRestrictions: ["United States"],
        categories: ["Backend", "Go"],
        parentCategories: ["Engineering"],
        description: "<p>Build things</p>",
        pubDate: 1750204800,
        applicationLink:
          "https://himalayas.app/companies/acme/jobs/senior-go-engineer",
        guid: "https://himalayas.app/companies/acme/jobs/senior-go-engineer",
      }),
    ).toEqual(
      expect.objectContaining({
        source: "himalayas",
        sourceJobId: "senior-go-engineer",
        title: "Senior Go Engineer",
        employer: "Acme",
        jobUrl: "https://himalayas.app/companies/acme/jobs/senior-go-engineer",
        applicationLink:
          "https://himalayas.app/companies/acme/jobs/senior-go-engineer",
        location: "United States",
        jobDescription: "<p>Build things</p>",
        datePosted: new Date(1750204800 * 1000).toISOString(),
        salary: "USD 90,000–130,000/annual",
        salaryMinAmount: 90000,
        salaryMaxAmount: 130000,
        salaryCurrency: "USD",
        jobType: "Full Time",
        jobLevel: "Senior",
        jobFunction: "Engineering",
        skills: "Backend, Go",
        isRemote: true,
      }),
    );
  });

  it("falls back to Worldwide location when unrestricted", () => {
    const job = mapHimalayasJob({
      title: "Support Engineer",
      companyName: "Acme",
      applicationLink: "https://himalayas.app/companies/acme/jobs/support",
      locationRestrictions: [],
    });
    expect(job?.location).toBe("Worldwide");
  });

  it("returns null when required fields are missing", () => {
    expect(mapHimalayasJob({ title: "No company or URL" })).toBeNull();
  });

  describe("matchesHimalayasLocation", () => {
    it("matches when unrestricted", () => {
      expect(matchesHimalayasLocation([], "germany")).toBe(true);
    });

    it("matches worldwide/unset selected country regardless of restrictions", () => {
      expect(matchesHimalayasLocation(["United States"], undefined)).toBe(true);
      expect(matchesHimalayasLocation(["United States"], "worldwide")).toBe(
        true,
      );
    });

    it("matches when the restriction mentions the selected country", () => {
      expect(matchesHimalayasLocation(["United States"], "united states")).toBe(
        true,
      );
    });

    it("rejects restrictions that exclude the selected country", () => {
      expect(matchesHimalayasLocation(["United States"], "germany")).toBe(
        false,
      );
    });
  });

  it("fetches once per term and de-duplicates upstream URLs", async () => {
    const row = {
      title: "Software Engineer",
      companyName: "Acme",
      applicationLink: "https://himalayas.app/companies/acme/jobs/se",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [row] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [row] }));

    const result = await runHimalayas({
      searchTerms: ["software", "engineer"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [expect.any(Object)] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips the source entirely when hybrid/onsite is requested without remote", async () => {
    const fetchMock = vi.fn();
    const result = await runHimalayas({
      workplaceTypes: ["hybrid"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a status-only error for failed upstream requests", async () => {
    const result = await runHimalayas({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 503)),
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Himalayas request failed with status 503",
    });
  });
});
