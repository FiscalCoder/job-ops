import { describe, expect, it, vi } from "vitest";
import {
  buildRemotiveSearchUrl,
  mapRemotiveJob,
  matchesRemotiveLocation,
  runRemotive,
} from "../src/run";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("Remotive extractor", () => {
  it("builds a search URL with the search term", () => {
    const url = buildRemotiveSearchUrl("backend engineer");
    expect(url.origin + url.pathname).toBe(
      "https://remotive.com/api/remote-jobs",
    );
    expect(url.searchParams.get("search")).toBe("backend engineer");
  });

  it("maps Remotive fields into a normalized job", () => {
    expect(
      mapRemotiveJob({
        id: 12345,
        url: "https://remotive.com/remote-jobs/software-dev/senior-go-engineer-12345",
        title: "Senior Go Engineer",
        company_name: "Acme",
        category: "Software Development",
        tags: ["go", "postgresql"],
        job_type: "full_time",
        publication_date: "2026-06-18T00:00:00",
        candidate_required_location: "USA Only",
        salary: "$120,000 - $150,000",
        description: "<p>Build things</p>",
      }),
    ).toEqual(
      expect.objectContaining({
        source: "remotive",
        sourceJobId: "12345",
        title: "Senior Go Engineer",
        employer: "Acme",
        jobUrl:
          "https://remotive.com/remote-jobs/software-dev/senior-go-engineer-12345",
        applicationLink:
          "https://remotive.com/remote-jobs/software-dev/senior-go-engineer-12345",
        location: "USA Only",
        jobDescription: "<p>Build things</p>",
        datePosted: "2026-06-18T00:00:00",
        salary: "$120,000 - $150,000",
        jobType: "full_time",
        jobFunction: "Software Development",
        skills: "go, postgresql",
        isRemote: true,
      }),
    );
  });

  it("returns null when required fields are missing", () => {
    expect(mapRemotiveJob({ title: "No company or URL" })).toBeNull();
  });

  describe("matchesRemotiveLocation", () => {
    it("always matches worldwide/unset country", () => {
      expect(matchesRemotiveLocation("USA Only", undefined)).toBe(true);
      expect(matchesRemotiveLocation("USA Only", "worldwide")).toBe(true);
    });

    it("always matches worldwide-labeled listings", () => {
      expect(matchesRemotiveLocation("Worldwide", "germany")).toBe(true);
      expect(matchesRemotiveLocation("Anywhere", "germany")).toBe(true);
    });

    it("matches when the listing mentions the selected country", () => {
      expect(matchesRemotiveLocation("USA Only", "united states")).toBe(true);
      expect(matchesRemotiveLocation("UK, Europe", "united kingdom")).toBe(
        true,
      );
    });

    it("rejects listings restricted to a different country", () => {
      expect(matchesRemotiveLocation("USA Only", "germany")).toBe(false);
    });
  });

  it("fetches once per term and de-duplicates upstream URLs", async () => {
    const row = {
      id: 1,
      url: "https://remotive.com/remote-jobs/1",
      title: "Software Engineer",
      company_name: "Acme",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [row] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [row] }));

    const result = await runRemotive({
      searchTerms: ["software", "engineer"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [expect.any(Object)] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips the source entirely when hybrid/onsite is requested without remote", async () => {
    const fetchMock = vi.fn();
    const result = await runRemotive({
      workplaceTypes: ["onsite"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a status-only error for failed upstream requests", async () => {
    const result = await runRemotive({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 503)),
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Remotive request failed with status 503",
    });
  });
});
