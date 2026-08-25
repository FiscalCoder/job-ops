import { describe, expect, it, vi } from "vitest";
import {
  mapArbeitnowJob,
  matchesArbeitnowSearchTerm,
  runArbeitnow,
} from "../src/run";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("Arbeitnow extractor", () => {
  it("maps a remote job into a normalized job", () => {
    expect(
      mapArbeitnowJob({
        slug: "senior-go-engineer-acme-1",
        company_name: "Acme",
        title: "Senior Go Engineer",
        description: "<p>Build things</p>",
        remote: true,
        url: "https://www.arbeitnow.com/view/senior-go-engineer-acme-1",
        tags: ["go", "postgresql"],
        job_types: ["Full Time"],
        location: "Berlin",
        created_at: 1750204800,
      }),
    ).toEqual(
      expect.objectContaining({
        source: "arbeitnow",
        sourceJobId: "senior-go-engineer-acme-1",
        title: "Senior Go Engineer",
        employer: "Acme",
        jobUrl: "https://www.arbeitnow.com/view/senior-go-engineer-acme-1",
        applicationLink:
          "https://www.arbeitnow.com/view/senior-go-engineer-acme-1",
        location: "Berlin",
        jobDescription: "<p>Build things</p>",
        datePosted: new Date(1750204800 * 1000).toISOString(),
        jobType: "Full Time",
        skills: "go, postgresql",
        isRemote: true,
      }),
    );
  });

  it("drops non-remote listings", () => {
    expect(
      mapArbeitnowJob({
        slug: "onsite-role",
        company_name: "Acme",
        title: "Office Manager",
        remote: false,
        url: "https://www.arbeitnow.com/view/onsite-role",
      }),
    ).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(
      mapArbeitnowJob({ title: "No company or URL", remote: true }),
    ).toBeNull();
  });

  describe("matchesArbeitnowSearchTerm", () => {
    it("matches on title, description, or skills", () => {
      const job = {
        title: "Senior Go Engineer",
        jobDescription: "Build distributed systems",
        skills: "go, postgresql",
      };
      expect(matchesArbeitnowSearchTerm(job, "go engineer")).toBe(true);
      expect(matchesArbeitnowSearchTerm(job, "distributed")).toBe(true);
      expect(matchesArbeitnowSearchTerm(job, "frontend designer")).toBe(false);
    });
  });

  it("paginates until there's no next link, filtering to remote jobs only", async () => {
    const remoteJob = {
      slug: "remote-1",
      company_name: "Acme",
      title: "Backend Engineer",
      remote: true,
      url: "https://www.arbeitnow.com/view/remote-1",
    };
    const onsiteJob = {
      slug: "onsite-1",
      company_name: "Acme",
      title: "Office Manager",
      remote: false,
      url: "https://www.arbeitnow.com/view/onsite-1",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [remoteJob, onsiteJob],
          links: { next: "page-2-url" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [], links: { next: null } }));

    const result = await runArbeitnow({
      searchTerms: ["backend"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.sourceJobId).toBe("remote-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after the page cap even when more pages are available", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [], links: { next: "always-more" } }),
      );

    await runArbeitnow({ searchTerms: ["backend"], fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips the source entirely when hybrid/onsite is requested without remote", async () => {
    const fetchMock = vi.fn();
    const result = await runArbeitnow({
      workplaceTypes: ["hybrid"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a status-only error for failed upstream requests", async () => {
    const result = await runArbeitnow({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 503)),
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Arbeitnow request failed with status 503",
    });
  });
});
