import { describe, expect, it } from "vitest";
import { postingKey, postingKeysOf } from "./posting-key";

describe("postingKey", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/4000001", "greenhouse:4000001"],
    ["https://job-boards.greenhouse.io/acme/jobs/4000001?gh_src=x", "greenhouse:4000001"],
    ["https://acme.com/careers?gh_jid=4000001", "greenhouse:4000001"],
    ["https://boards.greenhouse.io/embed/job_app?token=4000001", "greenhouse:4000001"],
    ["https://jobs.lever.co/acme/3F2504E0-4F89-11D3-9A0C-0305E82C3301/apply", "lever:3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["https://jobs.ashbyhq.com/acme/3f2504e0-4f89-11d3-9a0c-0305e82c3301", "ashby:3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["https://acme.com/jobs?ashby_jid=3f2504e0-4f89-11d3-9a0c-0305e82c3301", "ashby:3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Pune/Engineer_r-123", "workday:acme:R-123"],
    ["https://wd3.myworkdaysite.com/recruiting/acme/ext/job/Pune/Engineer_JR42", "workday:acme:JR42"],
    ["https://jobs.smartrecruiters.com/Acme/744000159536960-senior-engineer", "smartrecruiters:744000159536960"],
    ["https://hr.keka.com/careers/jobdetails/146427", "keka:hr:146427"],
    ["https://acme.darwinbox.in/ms/candidatev2/a1/careers/jobDetails/x9", "darwinbox:acme:x9"],
    ["https://acme.zohorecruit.in/jobs/Careers/123456/Engineer", "zoho:acme:123456"],
    ["https://www.linkedin.com/jobs/view/senior-engineer-at-acme-3999999999/", "linkedin:3999999999"],
    ["https://www.linkedin.com/jobs/search/?currentJobId=3999999999", "linkedin:3999999999"],
  ])("%s → %s", (link, key) => {
    expect(postingKey(link)).toBe(key);
  });

  it("no key for links naming no known system, or not a link", () => {
    expect(postingKey("https://acme.com/careers/engineer")).toBeNull();
    expect(postingKey("https://acme.wd5.myworkdayjobs.com/en-US/careers")).toBeNull();
    expect(postingKey("not a url")).toBeNull();
    expect(postingKey(undefined)).toBeNull();
  });

  it("a job's keys come from its page and where you apply", () => {
    expect(
      postingKeysOf({
        jobUrl: "https://www.linkedin.com/jobs/view/3999999999",
        applicationLink: "https://boards.greenhouse.io/acme/jobs/4000001",
      }),
    ).toEqual(["linkedin:3999999999", "greenhouse:4000001"]);
  });
});
