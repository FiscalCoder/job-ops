import { describe, expect, it, vi } from "vitest";
import {
  buildFounditSearchUrl,
  mapFounditListing,
  runFoundit,
  toFounditQueries,
  withFounditDetail,
} from "../src/run";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "69935144",
    jobId: 69935144,
    title: "Social Media & AI Marketing Intern",
    companyName: "Sliq Media Technologies",
    locations: "Mumbai, India",
    createdAt: Date.parse("2026-11-26T12:00:00Z"),
    seoJdUrl: "/job/social-media-ai-marketing-intern-sliq-media-69935144",
    applyUrl: "https://www.linkedin.com/jobs/view/4493475989/",
    minimumSalary: { absoluteMonthlyValue: 0 },
    maximumSalary: { absoluteMonthlyValue: 0 },
    skills: "Content Creation, Canva",
    hideCompanyName: 0,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const search = (rows: unknown[]) =>
  jsonResponse({ jobSearchResponse: { data: rows } });
const detail = (description: string) =>
  jsonResponse({ jobDetailResponse: { description } });

describe("toFounditQueries", () => {
  it("adds intern to each de-duplicated keyword", () => {
    expect(
      toFounditQueries([
        "Marketing Intern",
        "Marketing Internship",
        "Growth Marketing Intern",
      ]),
    ).toEqual(["Marketing intern", "Growth Marketing intern"]);
  });
});

describe("buildFounditSearchUrl", () => {
  it("asks for the newest results in the city", () => {
    const url = new URL(buildFounditSearchUrl("Marketing intern", "mumbai"));
    expect(url.origin + url.pathname).toBe(
      "https://www.foundit.in/middleware/jobsearch",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start: "0",
      limit: "50",
      query: "Marketing intern",
      locations: "Mumbai",
    });
  });

  it("searches all of India without a city", () => {
    expect(
      new URL(buildFounditSearchUrl("x intern")).searchParams.has("locations"),
    ).toBe(false);
  });
});

describe("mapFounditListing", () => {
  it("maps an internship result", () => {
    expect(mapFounditListing(row())).toEqual({
      jobId: "69935144",
      job: expect.objectContaining({
        source: "foundit",
        sourceJobId: "69935144",
        title: "Social Media & AI Marketing Intern",
        employer: "Sliq Media Technologies",
        jobUrl:
          "https://www.foundit.in/job/social-media-ai-marketing-intern-sliq-media-69935144",
        applicationLink: "https://www.linkedin.com/jobs/view/4493475989/",
        location: "Mumbai, India",
        isRemote: false,
        salary: undefined,
        jobType: "Internship",
        datePosted: "2026-11-26T12:00:00.000Z",
        skills: "Content Creation, Canva",
      }),
    });
  });

  it("reads stipends and location lists", () => {
    const mapped = mapFounditListing(
      row({
        locations: [{ city: "Thane" }, { city: "Navi Mumbai" }],
        minimumSalary: { absoluteMonthlyValue: 10000 },
        maximumSalary: { absoluteMonthlyValue: 15000 },
      }),
    );
    expect(mapped?.job.location).toBe("Thane, Navi Mumbai, India");
    expect(mapped?.job.salary).toBe("₹10,000 - ₹15,000 /month");
  });

  it("drops results that aren't internships or hide the company", () => {
    expect(mapFounditListing(row({ title: "Marketing Manager" }))).toBeNull();
    expect(mapFounditListing(row({ hideCompanyName: 1 }))).toBeNull();
    expect(mapFounditListing({})).toBeNull();
  });
});

describe("withFounditDetail", () => {
  it("adds the description and the stated length", () => {
    const listing = mapFounditListing(row());
    if (!listing) throw new Error("expected a listing");
    const detailed = withFounditDetail(
      listing.job,
      "<p>Run campaigns. Duration: 3 months.</p>",
    );
    expect(detailed.duration).toEqual({ minMonths: 3, maxMonths: 3 });
    expect(detailed.job.jobType).toBe("Internship · 3 months");
    expect(detailed.job.jobDescription).toBe(
      "Duration: 3 months\nLocation: Mumbai, India\n\n<p>Run campaigns. Duration: 3 months.</p>",
    );
  });

  it("leaves the description empty when the detail failed", () => {
    const listing = mapFounditListing(row());
    if (!listing) throw new Error("expected a listing");
    expect(
      withFounditDetail(listing.job, undefined).job.jobDescription,
    ).toBeUndefined();
  });
});

describe("runFoundit", () => {
  it("keeps internships of the wanted length once each and fetches details", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/jobsearch")) {
        return search([
          row(),
          row({
            id: "2",
            jobId: 2,
            seoJdUrl: "/job/b-2",
            title: "Brand Intern",
          }),
          row({
            id: "3",
            jobId: 3,
            seoJdUrl: "/job/c-3",
            title: "Marketing Manager",
          }),
        ]);
      }
      return href.endsWith("/2")
        ? detail("Internship duration: 6 months")
        : detail("Plan campaigns for 3 months? Unstated.");
    });

    const result = await runFoundit({
      searchTerms: ["Marketing Intern", "Marketing Internship"],
      cities: ["mumbai"],
      duration: { minMonths: 2, maxMonths: 3 },
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["69935144"]);
    const searches = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/jobsearch"),
    );
    expect(searches).toHaveLength(1);
  });

  it("keeps known jobs without fetching their details", async () => {
    const fetchImpl = vi.fn(async () => search([row()]));
    const result = await runFoundit({
      searchTerms: ["marketing"],
      existingJobUrls: [
        "https://www.foundit.in/job/social-media-ai-marketing-intern-sliq-media-69935144",
      ],
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });
    expect(result.jobs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a listing whose detail call fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/jobsearch")
        ? search([row()])
        : jsonResponse({}, 403),
    );
    const result = await runFoundit({
      searchTerms: ["marketing"],
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });
    expect(result.jobs).toHaveLength(1);
  });

  it("fails only when every search failed", async () => {
    const failing = vi.fn(async () => jsonResponse({}, 400));
    expect(
      await runFoundit({
        searchTerms: ["marketing"],
        fetchImpl: failing as typeof fetch,
        delayMs: 0,
      }),
    ).toEqual({
      success: false,
      jobs: [],
      error: "marketing intern: Foundit request failed with status 400",
    });
  });
});
