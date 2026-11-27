import { describe, expect, it, vi } from "vitest";
import {
  buildUnstopSearchUrl,
  mapUnstopListing,
  matchesUnstopLocation,
  runUnstop,
  toIsoDate,
} from "../src/run";

function listing(overrides: Record<string, unknown> = {}) {
  const { jobDetail, ...rest } = overrides;
  return {
    id: 1810196,
    public_url: "internships/marketing-internship-credflow-1810196",
    title: "Marketing Internship",
    organisation: { name: "CredFlow" },
    details: "<p>Plan B2B campaigns.</p><p>Internship duration: 3 months.</p>",
    approved_date: "2026-11-14 11:07:01 GMT+0530",
    end_date: "2026-11-28T00:00:00+05:30",
    required_skills: [
      { skill_name: "Marketing Campaign Planning" },
      { skill: "SEO" },
    ],
    jobDetail: {
      locations: ["Mumbai"],
      type: "in_office",
      timing: "full_time",
      paid_unpaid: "paid",
      show_salary: 1,
      min_salary: 5000,
      max_salary: 15000,
      pay_in: "monthly",
      ...(jobDetail as Record<string, unknown> | undefined),
    },
    ...rest,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function page(rows: unknown[], lastPage = 1) {
  return jsonResponse({ data: { data: rows, last_page: lastPage } });
}

describe("buildUnstopSearchUrl", () => {
  it("asks for open internships matching the keyword", () => {
    const url = new URL(buildUnstopSearchUrl("Digital Marketing", 2));
    expect(url.origin + url.pathname).toBe(
      "https://unstop.com/api/public/opportunity/search-result",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      opportunity: "internships",
      oppstatus: "open",
      per_page: "30",
      searchTerm: "Digital Marketing",
      page: "2",
    });
  });
});

describe("toIsoDate", () => {
  it.each([
    ["2026-11-14 11:07:01 GMT+0530", "2026-11-14T11:07:01+05:30"],
    ["2026-11-28T00:00:00+05:30", "2026-11-28T00:00:00+05:30"],
    ["soon", undefined],
    [null, undefined],
  ])("%s → %s", (value, expected) => {
    expect(toIsoDate(value)).toBe(expected);
  });
});

describe("mapUnstopListing", () => {
  it("maps an internship into a job", () => {
    const mapped = mapUnstopListing(listing());
    expect(mapped?.duration).toEqual({ minMonths: 3, maxMonths: 3 });
    expect(mapped?.job).toMatchObject({
      source: "unstop",
      sourceJobId: "1810196",
      title: "Marketing Internship",
      employer: "CredFlow",
      jobUrl:
        "https://unstop.com/internships/marketing-internship-credflow-1810196",
      location: "Mumbai, India",
      isRemote: false,
      salary: "₹5,000 - ₹15,000 /month",
      jobType: "Internship · 3 months",
      datePosted: "2026-11-14T11:07:01+05:30",
      deadline: "2026-11-28T00:00:00+05:30",
      skills: "Marketing Campaign Planning, SEO",
    });
    expect(mapped?.job.jobDescription).toMatch(
      /^Duration: 3 months\nStipend: ₹5,000 - ₹15,000 \/month\nTiming: full-time\nLocation: Mumbai, India\n\n<p>Plan B2B/,
    );
    expect(mapped?.job.locationEvidence).toMatchObject({ country: "india" });
  });

  it("labels unpaid, remote and hybrid internships", () => {
    expect(
      mapUnstopListing(
        listing({ jobDetail: { paid_unpaid: "unpaid", type: "wfh" } }),
      )?.job,
    ).toMatchObject({
      salary: "Unpaid",
      location: "Remote, India",
      isRemote: true,
    });
    expect(
      mapUnstopListing(listing({ jobDetail: { type: "hybrid" } }))?.job
        .location,
    ).toBe("Mumbai (Hybrid), India");
  });

  it("leaves the length unknown when the listing doesn't state it", () => {
    const mapped = mapUnstopListing(
      listing({ details: "<p>Plan campaigns.</p>" }),
    );
    expect(mapped?.duration).toBeNull();
    expect(mapped?.job.jobType).toBe("Internship");
  });

  it("skips rows without a title, employer or link", () => {
    expect(mapUnstopListing({ title: "x" })).toBeNull();
    expect(mapUnstopListing(null)).toBeNull();
  });
});

describe("matchesUnstopLocation", () => {
  const onsite = {
    locations: ["Navi Mumbai", "Pune"],
    workplace: "onsite" as const,
  };
  const remote = { locations: [], workplace: "remote" as const };

  it("keeps listings in a wanted city", () => {
    expect(matchesUnstopLocation(onsite, ["mumbai"], undefined)).toBe(true);
    expect(matchesUnstopLocation(onsite, ["chennai"], undefined)).toBe(false);
  });

  it("keeps remote listings only when remote work is wanted", () => {
    expect(
      matchesUnstopLocation(remote, ["mumbai"], ["remote", "onsite"]),
    ).toBe(true);
    expect(matchesUnstopLocation(remote, ["mumbai"], ["onsite"])).toBe(false);
  });

  it("drops remote listings when the search is limited to the selected cities", () => {
    expect(matchesUnstopLocation(remote, ["mumbai"], undefined, false)).toBe(
      false,
    );
    expect(matchesUnstopLocation(onsite, ["mumbai"], undefined, false)).toBe(
      true,
    );
  });

  it("keeps every location when no city is set", () => {
    expect(matchesUnstopLocation(onsite, [], undefined)).toBe(true);
  });
});

describe("runUnstop", () => {
  it("reads every page, keeping wanted cities and lengths once each", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const pageNo = new URL(String(url)).searchParams.get("page");
      return pageNo === "1"
        ? page(
            [
              listing(),
              listing({
                id: 2,
                public_url: "internships/b-2",
                jobDetail: { locations: ["Delhi"] },
              }),
            ],
            2,
          )
        : page(
            [
              listing(),
              listing({
                id: 3,
                public_url: "internships/c-3",
                details: "Duration: 6 months",
              }),
              listing({
                id: 4,
                public_url: "internships/d-4",
                details: "No length.",
              }),
            ],
            2,
          );
    });

    const result = await runUnstop({
      searchTerms: ["Marketing Intern", "Marketing Internship"],
      cities: ["mumbai"],
      duration: { minMonths: 2, maxMonths: 3 },
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["1810196", "4"]);
    // One keyword ("Marketing"), two pages.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports failed keywords and fails only when nothing was found", async () => {
    const failing = vi.fn(async () => jsonResponse({}, 503));
    const failed = await runUnstop({
      searchTerms: ["marketing"],
      fetchImpl: failing as typeof fetch,
      delayMs: 0,
    });
    expect(failed).toEqual({
      success: false,
      jobs: [],
      error: "marketing: Unstop request failed with status 503",
    });

    const partly = vi.fn(async (url: string | URL | Request) =>
      new URL(String(url)).searchParams.get("searchTerm") === "marketing"
        ? jsonResponse({ data: {} })
        : page([listing()]),
    );
    const partial = await runUnstop({
      searchTerms: ["marketing", "digital marketing"],
      fetchImpl: partly as typeof fetch,
      delayMs: 0,
    });
    expect(partial.success).toBe(true);
    expect(partial.jobs).toHaveLength(1);
    expect(partial.errors).toEqual([
      "marketing: Unstop returned an invalid search response",
    ]);
  });
});
