import { afterEach, describe, expect, it, vi } from "vitest";
import { boardAdapter, htmlText, isoDate } from "./board-adapter";
import {
  leverBoard,
  parseLeverJobs,
  parseSmartRecruitersJobs,
  smartRecruitersBoard,
  smartRecruitersDescription,
} from "./boards/global";
import {
  darwinboxBoard,
  kekaBoard,
  parseDarwinboxJobs,
  parseKekaJobs,
  parseZohoJobs,
  zohoRecruitBoard,
} from "./boards/india";

describe("board URLs", () => {
  it("each system takes only its own boards, in one canonical form", () => {
    expect(kekaBoard.parse("https://acme.keka.com/careers/jobdetails/12")).toEqual({
      key: "acme",
      careersUrl: "https://acme.keka.com/careers",
    });
    expect(kekaBoard.parse("https://www.keka.com/careers")).toBeNull();
    expect(kekaBoard.parse("http://acme.keka.com/careers")).toBeNull();
    expect(kekaBoard.parse("https://acme.keka.com.evil.io/careers")).toBeNull();
    expect(
      darwinboxBoard.parse("https://acme.darwinbox.in/ms/candidatev2/a1b2c3/careers/jobDetails/9"),
    ).toEqual({
      key: "acme-a1b2c3",
      careersUrl: "https://acme.darwinbox.in/ms/candidatev2/a1b2c3/careers/allJobs",
    });
    expect(darwinboxBoard.parse("https://acme.darwinbox.in/careers")).toBeNull();
    expect(zohoRecruitBoard.parse("https://acme.zohorecruit.in/jobs/Careers/123")).toEqual({
      key: "acme",
      careersUrl: "https://acme.zohorecruit.in/jobs/Careers",
    });
    expect(leverBoard.parse("https://jobs.lever.co/Acme/abc-123")).toEqual({
      key: "acme",
      careersUrl: "https://jobs.lever.co/acme",
    });
    expect(leverBoard.parse("https://jobs.lever.co.evil.io/acme")).toBeNull();
    expect(smartRecruitersBoard.parse("https://careers.smartrecruiters.com/Acme1")).toEqual({
      key: "Acme1",
      careersUrl: "https://jobs.smartrecruiters.com/Acme1",
    });
  });
});

describe("reading postings", () => {
  it("Keka: the feed's array, with city and country per location", () => {
    const board = { key: "acme", careersUrl: "https://acme.keka.com/careers" };
    const jobs = parseKekaJobs(
      [
        {
          id: 42,
          title: " Senior  Engineer ",
          jobLocations: [{ city: "Pune", countryName: "India", name: "HQ" }, { name: "Remote" }],
          publishedOn: "2026-11-01T10:00:00Z",
          description: "<p>Build things</p>",
        },
        { id: 43 },
      ],
      board,
    );
    expect(jobs).toEqual([
      {
        id: "42",
        title: "Senior Engineer",
        jobUrl: "https://acme.keka.com/careers/jobdetails/42",
        location: "Pune, India; Remote",
        postedAt: "2026-11-01T10:00:00.000Z",
        descriptionHtml: "<p>Build things</p>",
      },
    ]);
    expect(() => parseKekaJobs({ error: "x" }, board)).toThrow(/unexpected/);
  });

  it("Darwinbox: a success envelope; anything else is an error, not an empty board", () => {
    const board = {
      key: "acme-a1",
      careersUrl: "https://acme.darwinbox.in/ms/candidatev2/a1/careers/allJobs",
    };
    const jobs = parseDarwinboxJobs(
      {
        status: "success",
        data: [{ id: "x9", title: "Engineer", tool_tip_locations: ["Chennai, India"], posted_on: 1_762_000_000, jd: "<p>JD</p>" }],
      },
      board,
    );
    expect(jobs[0]).toMatchObject({
      id: "x9",
      jobUrl: "https://acme.darwinbox.in/ms/candidatev2/a1/careers/jobDetails/x9",
      location: "Chennai, India",
      postedAt: new Date(1_762_000_000_000).toISOString(),
    });
    expect(() => parseDarwinboxJobs({ status: "error" }, board)).toThrow(/unexpected/);
  });

  it("Zoho Recruit: the JSON in the page's jobs input; closed postings left out", () => {
    const board = { key: "acme", careersUrl: "https://acme.zohorecruit.in/jobs/Careers" };
    const records = [
      { id: 1, Posting_Title: "Engineer", City: "Bengaluru", Country: "India", Remote_Job: true, Date_Opened: "2026-10-30" },
      { id: 2, Posting_Title: "Closed", Is_Locked: true },
    ];
    const value = JSON.stringify(records).replace(/"/g, "&quot;");
    const jobs = parseZohoJobs(`<html><input type="hidden" id="jobs" value="${value}"></html>`, board);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "1",
      jobUrl: "https://acme.zohorecruit.in/jobs/Careers/1",
      location: "Bengaluru, India, Remote",
    });
    expect(() => parseZohoJobs("<html></html>", board)).toThrow(/no job list/);
  });

  it("Lever: hosted links, all locations, remote, and lists in the description", () => {
    const [job] = parseLeverJobs([
      {
        id: "abc",
        text: "Engineer",
        hostedUrl: "https://jobs.lever.co/acme/abc",
        applyUrl: "https://jobs.lever.co/acme/abc/apply",
        categories: { allLocations: ["Bengaluru"] },
        workplaceType: "remote",
        createdAt: 1_762_000_000_000,
        description: "<p>Intro</p>",
        lists: [{ text: "Requirements", content: "<li>Node.js</li>" }],
      },
    ]);
    expect(job).toMatchObject({
      applicationLink: "https://jobs.lever.co/acme/abc/apply",
      location: "Bengaluru; Remote",
    });
    expect(htmlText(job?.descriptionHtml)).toBe("Intro\nRequirements\n• Node.js");
  });

  it("SmartRecruiters: the list, and the ad's sections as the description", () => {
    const board = { key: "Acme", careersUrl: "https://jobs.smartrecruiters.com/Acme" };
    const { postings, total } = parseSmartRecruitersJobs(
      {
        totalFound: 1,
        content: [
          { id: "744", name: "Engineer", releasedDate: "2026-11-02T00:00:00Z", location: { city: "Pune", country: "in", remote: true }, company: { name: "Acme Inc" } },
        ],
      },
      board,
    );
    expect(total).toBe(1);
    expect(postings[0]).toMatchObject({
      jobUrl: "https://jobs.smartrecruiters.com/Acme/744",
      location: "Pune, in; Remote",
      employer: "Acme Inc",
    });
    expect(
      smartRecruitersDescription({
        jobAd: { sections: { jobDescription: { title: "Job", text: "<p>Do</p>" } } },
      }),
    ).toBe("<h3>Job</h3><p>Do</p>");
  });

  it("dates from seconds, milliseconds or text", () => {
    expect(isoDate(1_762_000_000)).toBe(isoDate(1_762_000_000_000));
    expect(isoDate("not a date")).toBeNull();
  });
});

describe("as a Watchlist source", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("newest first, details and drafts from the same read, one request per board", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.lever.co/v0/postings/acme?mode=json");
      return new Response(
        JSON.stringify([
          { id: "old", text: "Old role", hostedUrl: "https://jobs.lever.co/acme/old", createdAt: 1_700_000_000_000, description: "<p>Old</p>" },
          { id: "new", text: "New role", hostedUrl: "https://jobs.lever.co/acme/new", createdAt: 1_762_000_000_000, description: "<p>New</p>" },
        ]),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = boardAdapter(leverBoard);
    const source = {
      id: "lever:acme",
      label: "Acme",
      sourceType: "lever",
      careersUrl: "https://jobs.lever.co/acme",
      cxsJobsUrl: null,
    } as never;
    const result = await adapter.fetchJobs({ source });
    expect(result.jobs.map((j) => j.title)).toEqual(["New role", "Old role"]);
    expect(result.jobs[0]).toMatchObject({ source: "lever:acme", employer: "Acme" });
    const draft = await adapter.prepareImportDraft({ source, jobRef: "new" });
    expect(draft.draft).toMatchObject({ title: "New role", jobDescription: "New" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a redirect means no such board", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 302, headers: { location: "/x" } })));
    const adapter = boardAdapter(kekaBoard);
    const source = {
      id: "keka:nobody",
      label: "Nobody",
      sourceType: "keka",
      careersUrl: "https://nobody.keka.com/careers",
      cxsJobsUrl: null,
    } as never;
    await expect(adapter.fetchJobs({ source })).rejects.toThrow(/redirected/);
  });
});
