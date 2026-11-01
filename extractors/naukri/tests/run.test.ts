import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dedupeNaukriJobs,
  htmlToText,
  makeSearchPageUrl,
  mapNaukriJob,
  postingText,
  resolveNaukriMaxJobsPerTerm,
  slugifyKeyword,
  withFullPostings,
} from "../src/run";

const testDir = dirname(fileURLToPath(import.meta.url));

describe("naukri extractor mapping", () => {
  it("builds a default 7-day search URL with optional location", () => {
    expect(slugifyKeyword("Senior C++ Engineer")).toBe("senior-c-engineer");

    const url = new URL(
      makeSearchPageUrl({
        keyword: "software developer",
        location: "Bengaluru",
      }),
    );

    expect(url.pathname).toBe("/software-developer-jobs-in-bengaluru");
    expect(url.searchParams.get("k")).toBe("software developer");
    expect(url.searchParams.get("l")).toBe("Bengaluru");
    expect(url.searchParams.get("jobAge")).toBe("7");
  });

  it("maps raw Naukri jobs into CreateJobInput", () => {
    const mapped = mapNaukriJob({
      title: "Software engineer",
      jobId: "270426502000",
      companyName: "Barclays",
      jdURL:
        "/job-listings-software-engineer-barclays-pune-0-to-7-years-270426502000",
      companyApplyUrl:
        "https://www.naukri.com/cloudgateway-apply/apply-services/v0/apply/saveCompanyApply?id=&file=270426502000&logstr=srprestapi",
      createdDate: 1777288114000,
      tagsAndSkills: "Core Java,Unit testing",
      logoPathV3: "https://img.naukimg.com/logo.gif",
      currency: "INR",
      experienceText: "0-7 Yrs",
      placeholders: [
        { type: "salary", label: "Not disclosed" },
        { type: "location", label: "Pune" },
      ],
      salaryDetail: {
        minimumSalary: 0,
        maximumSalary: 0,
        currency: "INR",
        hideSalary: true,
      },
      ambitionBoxData: {
        AggregateRating: "3.8",
        ReviewsCount: 1156,
      },
      jobDescription: "Production systems",
    });

    expect(mapped).toEqual(
      expect.objectContaining({
        source: "naukri",
        sourceJobId: "270426502000",
        title: "Software engineer",
        employer: "Barclays",
        jobUrl:
          "https://www.naukri.com/job-listings-software-engineer-barclays-pune-0-to-7-years-270426502000",
        // Naukri's click tracker errors when opened on its own: the listing has the button.
        applicationLink:
          "https://www.naukri.com/job-listings-software-engineer-barclays-pune-0-to-7-years-270426502000",
        location: "Pune",
        locationEvidence: {
          rawLocation: "Pune",
          location: "Pune, India",
          countryKey: "india",
          country: "india",
          evidenceQuality: "approximate",
          source: "naukri",
          sourceNotes: ["Naukri is scoped to India in this extractor."],
        },
        datePosted: "2026-04-27T11:08:34.000Z",
        jobDescription: "Production systems",
        skills: "Core Java,Unit testing",
        experienceRange: "0-7 Yrs",
        companyLogo: "https://img.naukimg.com/logo.gif",
        companyRating: 3.8,
        companyReviewsCount: 1156,
        salaryCurrency: "INR",
      }),
    );
  });

  it("dedupes by source job id or URL and filters existing URLs", () => {
    const jobs = [
      {
        source: "naukri",
        sourceJobId: "one",
        jobUrl: "https://www.naukri.com/job-one",
      },
      {
        source: "naukri",
        sourceJobId: "one",
        jobUrl: "https://www.naukri.com/job-one-copy",
      },
      {
        source: "naukri",
        jobUrl: "https://www.naukri.com/existing",
      },
      {
        source: "naukri",
        jobUrl: "https://www.naukri.com/fresh",
      },
    ];

    expect(
      dedupeNaukriJobs(jobs, ["https://www.naukri.com/existing"]).map(
        (job) => job.jobUrl,
      ),
    ).toEqual([
      "https://www.naukri.com/job-one",
      "https://www.naukri.com/fresh",
    ]);
  });

  it("normalizes the internal max jobs per term setting", () => {
    expect(resolveNaukriMaxJobsPerTerm(undefined)).toBe(50);
    expect(resolveNaukriMaxJobsPerTerm("12")).toBe(12);
    expect(resolveNaukriMaxJobsPerTerm(12.9)).toBe(12);
    expect(resolveNaukriMaxJobsPerTerm(0)).toBe(1);
    expect(resolveNaukriMaxJobsPerTerm("not-a-number")).toBe(50);
  });

  it("does not contain normal-run debug file writes", async () => {
    const source = await readFile(join(testDir, "../src/run.ts"), "utf8");

    expect(source).not.toContain("writeFile");
    expect(source).not.toContain("naukri_captured_requests_debug");
    expect(source).not.toContain("naukri_api_page");
    expect(source).not.toContain("naukri_jobs.json");
  });
});

describe("naukri full postings", () => {
  const job = (id: string, jobDescription?: string) => ({
    source: "naukri" as const,
    sourceJobId: id,
    title: "Software engineer",
    employer: "Barclays",
    jobUrl: `https://www.naukri.com/job-${id}`,
    ...(jobDescription === undefined ? {} : { jobDescription }),
  });
  const excerpt =
    "Platform Engineering<br><br> coaching and developing talent.";
  const full = `Join us as a Software Engineer. Languages Java (primary). ${"x".repeat(900)}`;

  it("turns the posting's HTML into text with its lines and list items", () => {
    expect(
      htmlToText(
        "<p>Join us &amp; build</p><ul><li>Java (primary)</li><li>Python&nbsp;(advantageous)</li></ul>Pune<br>India",
      ),
    ).toBe(
      [
        "Join us & build",
        "- Java (primary)",
        "- Python (advantageous)",
        "Pune",
        "India",
      ].join("\n"),
    );
  });

  it("reads jobDetails.description from the job API; anything else is nothing", () => {
    expect(
      postingText({ jobDetails: { description: "<p>Java (primary)</p>" } }),
    ).toBe("Java (primary)");
    expect(postingText({ jobDetails: { description: "  " } })).toBeNull();
    expect(postingText({ jobDetails: {} })).toBeNull();
    expect(postingText(null)).toBeNull();
  });

  it("opens only excerpts, keeps the excerpt when the posting can't be read", async () => {
    const opened: string[] = [];
    const jobs = await withFullPostings(
      [job("a", excerpt), job("b", full), job("c"), job("d", excerpt)],
      async (j) => {
        opened.push(j.sourceJobId ?? "");
        return j.sourceJobId === "d" ? null : full;
      },
      { limit: 10, delayMs: 0 },
    );
    expect(opened).toEqual(["a", "c", "d"]);
    expect(jobs.map((j) => j.jobDescription)).toEqual([
      full,
      full,
      full,
      excerpt,
    ]);
  });

  it("stops opening postings at the limit, on a block page, or when cancelled", async () => {
    const opened: string[] = [];
    const open = async (j: { sourceJobId?: string }) => {
      opened.push(j.sourceJobId ?? "");
      return j.sourceJobId === "b" ? ("blocked" as const) : full;
    };
    const jobs = await withFullPostings(
      [job("a", excerpt), job("b", excerpt), job("c", excerpt)],
      open,
      { limit: 10, delayMs: 0 },
    );
    expect(opened).toEqual(["a", "b"]);
    expect(jobs.map((j) => j.jobDescription)).toEqual([full, excerpt, excerpt]);

    opened.length = 0;
    await withFullPostings([job("a", excerpt), job("b2", excerpt)], open, {
      limit: 1,
      delayMs: 0,
    });
    expect(opened).toEqual(["a"]);

    opened.length = 0;
    await withFullPostings([job("a", excerpt)], open, {
      limit: 10,
      delayMs: 0,
      shouldCancel: () => true,
    });
    expect(opened).toEqual([]);
  });

  it("a fetch that throws keeps the excerpt and goes on", async () => {
    const jobs = await withFullPostings(
      [job("a", excerpt), job("b", excerpt)],
      async (j) => {
        if (j.sourceJobId === "a") throw new Error("timeout");
        return full;
      },
      { limit: 10, delayMs: 0 },
    );
    expect(jobs.map((j) => j.jobDescription)).toEqual([excerpt, full]);
  });
});
