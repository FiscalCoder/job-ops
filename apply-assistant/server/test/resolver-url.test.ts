import { describe, expect, it } from "vitest";
import { classifyApplyUrl } from "../src/resolver/greenhouse-url.js";

describe("classifyApplyUrl", () => {
  it("parses a job-boards.greenhouse.io job URL", () => {
    expect(
      classifyApplyUrl(
        "https://job-boards.greenhouse.io/newrelic/jobs/5453390008",
      ),
    ).toEqual({
      kind: "greenhouse-job",
      token: "newrelic",
      ghJobId: "5453390008",
      region: "us",
    });
  });

  it("parses the EU host and the legacy boards host, ignoring query strings", () => {
    expect(
      classifyApplyUrl(
        "https://job-boards.eu.greenhouse.io/litmos/jobs/4982603101?utm_source=x",
      ),
    ).toMatchObject({
      kind: "greenhouse-job",
      token: "litmos",
      ghJobId: "4982603101",
      region: "eu",
    });
    expect(
      classifyApplyUrl(
        "https://boards.greenhouse.io/celonis/jobs/7791427003?gh_jid=7791427003",
      ),
    ).toMatchObject({
      token: "celonis",
      ghJobId: "7791427003",
    });
  });

  it("recognises a company careers page with gh_jid (token still unknown)", () => {
    expect(
      classifyApplyUrl(
        "https://www.fivetran.com/careers/job?gh_jid=7768594003",
      ),
    ).toEqual({
      kind: "greenhouse-embedded",
      ghJobId: "7768594003",
      pageUrl: "https://www.fivetran.com/careers/job?gh_jid=7768594003",
    });
  });

  it("recognises grnh.se short links", () => {
    expect(classifyApplyUrl("https://grnh.se/3p6v950q1us")).toEqual({
      kind: "greenhouse-short",
      url: "https://grnh.se/3p6v950q1us",
    });
  });

  it("labels job boards and anything else", () => {
    expect(classifyApplyUrl("https://in.linkedin.com/jobs/view/123")).toEqual({
      kind: "board",
      board: "linkedin",
    });
    expect(classifyApplyUrl("https://www.naukri.com/job-listings-abc")).toEqual(
      { kind: "board", board: "naukri" },
    );
    expect(classifyApplyUrl("https://careers.example.com/job/1")).toEqual({
      kind: "other",
    });
    expect(classifyApplyUrl("not a url")).toEqual({ kind: "other" });
  });
});
