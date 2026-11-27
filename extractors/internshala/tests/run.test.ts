import { describe, expect, it, vi } from "vitest";
import {
  buildInternshalaListUrl,
  cardAgeHours,
  parseInternshalaCards,
  parseInternshalaDetail,
  runInternshala,
  toInternshalaJob,
} from "../src/run";

function card(args: {
  id: string;
  title: string;
  company?: string;
  locations?: string[];
  duration?: string;
  posted?: string;
  employmentType?: string;
}): string {
  const slug = `/internship/detail/${args.title.toLowerCase().replace(/\W+/g, "-")}-${args.id}`;
  const locations = (args.locations ?? ["Mumbai"])
    .map((location) => `<a>${location}</a>`)
    .join(", ");
  return `<div class="container-fluid individual_internship visibilityTrackerItem" id="individual_internship_${args.id}" internshipId="${args.id}" employment_type="${args.employmentType ?? "internship"}" data-href='${slug}'>
    <h2 class="job-internship-name"><a class="job-title-href" href="${slug}">${args.title}</a></h2>
    <p class="company-name"> ${args.company ?? "Mad Over Donuts"} </p>
    <div class="row-1-item locations"><i class="ic-16-map-pin"></i><span>${locations}</span></div>
    <div class="row-1-item"><i class="ic-16-money"></i><span class='stipend'>₹ 7,000 - 10,000 /month</span></div>
    <div class="row-1-item"><i class="ic-16-calendar"></i><span>${args.duration ?? "3 Months"}</span></div>
    <div class="about_job"><div class="text"> Hands-on marketing operations. </div></div>
    <div class="job_skills"><div class='job_skill'>Digital Marketing</div><div class='job_skill'>MS-Excel</div></div>
    <div class="color-labels"><div class="status-success"><i></i><span>${args.posted ?? "Today"}</span></div></div>
  </div>`;
}

const DETAIL_HTML = `<html><head>
<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Marketing - Internship","description":"<p>About the internship:</p>Run campaigns.<li>are available for duration of 3 months</li>","datePosted":"2026-11-26","validThrough":"2026-12-26T23:59:59"}</script>
</head><body></body></html>`;

function listResponse(cards: string[], isLastPage = true) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        internship_list_html: cards.join("\n"),
        is_last_page: isLastPage,
      }),
  } as Response;
}

function htmlResponse(html: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  } as Response;
}

describe("buildInternshalaListUrl", () => {
  it("combines city, keyword, maximum length and page", () => {
    expect(
      buildInternshalaListUrl({
        keyword: "Digital Marketing",
        city: "Mumbai",
        duration: { minMonths: 2, maxMonths: 3 },
        page: 2,
      }),
    ).toBe(
      "https://internshala.com/internships_ajax/internship-in-mumbai/keywords-Digital%20Marketing/duration-3/page-2/",
    );
  });

  it("leaves out the city and length when not set", () => {
    expect(buildInternshalaListUrl({ keyword: "marketing" })).toBe(
      "https://internshala.com/internships_ajax/keywords-marketing/",
    );
  });

  it("uses city slugs for multi-word cities", () => {
    expect(
      buildInternshalaListUrl({ keyword: "marketing", city: "Navi Mumbai" }),
    ).toContain("/internship-in-navi-mumbai/");
  });
});

describe("parseInternshalaCards", () => {
  it("reads the fields of each internship card", () => {
    const [parsed] = parseInternshalaCards(
      card({
        id: "3339983",
        title: "Marketing",
        locations: ["Mumbai", "Thane"],
        posted: "2 days ago",
      }),
    );
    expect(parsed).toEqual({
      id: "3339983",
      title: "Marketing",
      employer: "Mad Over Donuts",
      jobUrl: "https://internshala.com/internship/detail/marketing-3339983",
      locations: ["Mumbai", "Thane"],
      stipend: "₹ 7,000 - 10,000 /month",
      durationText: "3 Months",
      postedText: "2 days ago",
      about: "Hands-on marketing operations.",
      skills: ["Digital Marketing", "MS-Excel"],
    });
  });

  it("keeps the hybrid marker that sits outside the location link", () => {
    const html = card({ id: "5", title: "Marketing" }).replace(
      "<a>Mumbai</a>",
      '<a>Mumbai</a> (Hybrid) <span class="compensation-breakup-icon"><i></i></span>',
    );
    expect(parseInternshalaCards(html)[0]?.locations).toEqual([
      "Mumbai (Hybrid)",
    ]);
  });

  it("skips job cards mixed into internship results", () => {
    expect(
      parseInternshalaCards(
        card({ id: "1", title: "Sales Executive", employmentType: "job" }),
      ),
    ).toEqual([]);
  });
});

describe("cardAgeHours", () => {
  it.each([
    ["Today", 0],
    ["Just now", 0],
    ["Few hours ago", 0],
    ["1 day ago", 24],
    ["3 days ago", 72],
    ["1 week ago", 168],
    ["Be an early applicant", null],
    [undefined, null],
  ])("%s → %s", (label, hours) => {
    expect(cardAgeHours(label)).toBe(hours);
  });
});

describe("parseInternshalaDetail", () => {
  it("reads the JobPosting JSON-LD", () => {
    expect(parseInternshalaDetail(DETAIL_HTML)).toEqual({
      description:
        "<p>About the internship:</p>Run campaigns.<li>are available for duration of 3 months</li>",
      datePosted: "2026-11-26",
      deadline: "2026-12-26T23:59:59",
    });
  });

  it("returns null when the page has no posting", () => {
    expect(parseInternshalaDetail("<html></html>")).toBeNull();
  });

  it("reads the page's sections when there is no JobPosting JSON-LD", () => {
    const html = `<div class="internship_details">
      <h2 class="section_heading heading_5_5 about_heading">About the internship</h2>
      <div class="text-container">Support SEO and social campaigns.</div>
      <h2 class="section_heading heading_5_5 skills_heading">Skill(s) required</h2>
      <div class="round_tabs_container"><span>SEO</span> <a class="training_link_tag" href="https://trainings.internshala.com/x">Learn SEO</a></div>
      <h2 class="section_heading heading_5_5">Who can apply</h2>
      <div class="text-container who_can_apply">are available for duration of 3 months</div>
    </div>`;
    expect(parseInternshalaDetail(html)).toEqual({
      description:
        "About the internship:\nSupport SEO and social campaigns.\n\nSkill(s) required:\nSEO\n\nWho can apply:\nare available for duration of 3 months",
    });
  });
});

describe("toInternshalaJob", () => {
  it("maps a card and its detail into a job with India location evidence", () => {
    const [parsed] = parseInternshalaCards(
      card({ id: "7", title: "Marketing", locations: ["Mumbai (Hybrid)"] }),
    );
    const job = toInternshalaJob(parsed, parseInternshalaDetail(DETAIL_HTML));
    expect(job).toMatchObject({
      source: "internshala",
      sourceJobId: "7",
      title: "Marketing",
      employer: "Mad Over Donuts",
      location: "Mumbai (Hybrid), India",
      isRemote: false,
      salary: "₹ 7,000 - 10,000 /month",
      jobType: "Internship · 3 months",
      datePosted: "2026-11-26",
      deadline: "2026-12-26T23:59:59",
      skills: "Digital Marketing, MS-Excel",
    });
    expect(job.locationEvidence).toMatchObject({
      country: "india",
      isHybrid: true,
    });
    expect(job.jobDescription).toMatch(/^Duration: 3 months\nStipend: /);
    expect(job.jobDescription).toContain("Run campaigns.");
  });

  it("marks work-from-home internships as remote and falls back to the card", () => {
    const [parsed] = parseInternshalaCards(
      card({ id: "8", title: "Content", locations: ["Work from home"] }),
    );
    const job = toInternshalaJob(parsed, null);
    expect(job.location).toBe("Remote, India");
    expect(job.isRemote).toBe(true);
    expect(job.datePosted).toBe("today");
    expect(job.jobDescription).toContain("Hands-on marketing operations.");
  });
});

describe("runInternshala", () => {
  it("searches each keyword and city, filters by length and age, and opens new postings", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/internships_ajax/")) {
        return listResponse([
          card({ id: "1", title: "Marketing", duration: "3 Months" }),
          card({ id: "2", title: "Brand", duration: "6 Months" }),
          card({
            id: "3",
            title: "Growth",
            duration: "2 Months",
            posted: "3 weeks ago",
          }),
          card({ id: "4", title: "Social", duration: "6 Weeks" }),
        ]);
      }
      return htmlResponse(DETAIL_HTML);
    });

    const result = await runInternshala({
      searchTerms: ["Marketing Intern", "Marketing Internship"],
      cities: ["Mumbai"],
      duration: { minMonths: 2, maxMonths: 3 },
      maxAgeHours: 24,
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["1"]);
    const listUrls = fetchImpl.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/internships_ajax/"));
    // "Marketing Intern" and "Marketing Internship" are one keyword.
    expect(listUrls).toEqual([
      "https://internshala.com/internships_ajax/internship-in-mumbai/keywords-Marketing/duration-3/",
    ]);
    expect(result.jobs[0]?.datePosted).toBe("2026-11-26");
  });

  it("keeps known postings without reopening them", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/internships_ajax/")
        ? listResponse([card({ id: "1", title: "Marketing" })])
        : htmlResponse(DETAIL_HTML),
    );
    const result = await runInternshala({
      searchTerms: ["marketing"],
      existingJobUrls: [
        "https://internshala.com/internship/detail/marketing-1",
      ],
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });
    expect(result.jobs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the card when its detail page fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/internships_ajax/")
        ? listResponse([card({ id: "1", title: "Marketing" })])
        : htmlResponse("blocked", 403),
    );
    const result = await runInternshala({
      searchTerms: ["marketing"],
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.jobDescription).toContain("Hands-on");
  });

  it("reports failed searches and fails only when nothing was found", async () => {
    const failing = vi.fn(async () => htmlResponse("down", 503));
    const failed = await runInternshala({
      searchTerms: ["marketing"],
      fetchImpl: failing as typeof fetch,
      delayMs: 0,
    });
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("status 503");

    let call = 0;
    const partly = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes("/internships_ajax/")) {
        return htmlResponse(DETAIL_HTML);
      }
      call += 1;
      return call === 1
        ? htmlResponse("down", 503)
        : listResponse([card({ id: "9", title: "Digital" })]);
    });
    const partial = await runInternshala({
      searchTerms: ["marketing", "digital marketing"],
      fetchImpl: partly as typeof fetch,
      delayMs: 0,
    });
    expect(partial.success).toBe(true);
    expect(partial.jobs).toHaveLength(1);
    expect(partial.errors).toEqual([
      "marketing: Internshala request failed with status 503",
    ]);
  });

  it("stops reading pages once the per-search limit is reached", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/internships_ajax/")
        ? listResponse(
            [
              card({ id: "1", title: "A" }),
              card({ id: "2", title: "B" }),
              card({ id: "3", title: "C" }),
            ],
            false,
          )
        : htmlResponse(DETAIL_HTML),
    );
    const result = await runInternshala({
      searchTerms: ["marketing"],
      maxJobsPerTerm: 2,
      fetchImpl: fetchImpl as typeof fetch,
      delayMs: 0,
    });
    expect(result.jobs).toHaveLength(2);
    const listCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/internships_ajax/"),
    );
    expect(listCalls).toHaveLength(1);
  });
});
