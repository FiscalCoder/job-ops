import { describe, expect, it } from "vitest";
import {
  bestApplyLink,
  cleanApplyUrl,
  linkedInJobIdOf,
} from "../src/capture/linkedin.js";

describe("linkedInJobIdOf", () => {
  it.each([
    ["https://www.linkedin.com/jobs/view/4477797153", "4477797153"],
    ["https://www.linkedin.com/jobs/view/4477797153/?refId=x", "4477797153"],
    [
      "https://in.linkedin.com/jobs/view/senior-engineer-at-acme-4477797153",
      "4477797153",
    ],
    [
      "https://www.linkedin.com/jobs/search/?currentJobId=4477797153&keywords=x",
      "4477797153",
    ],
    [
      "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4477797153",
      "4477797153",
    ],
    [
      "https://www.linkedin.com/jobs/view/externalApply/4477797153?url=https%3A%2F%2Fx.com",
      "4477797153",
    ],
    ["https://www.linkedin.com/feed/", null],
    ["https://example.com/jobs/view/4477797153", null],
  ])("%s → %s", (url, id) => {
    expect(linkedInJobIdOf(url)).toBe(id);
  });
});

describe("cleanApplyUrl", () => {
  it("drops tracking parameters and keeps the rest", () => {
    expect(
      cleanApplyUrl(
        "https://job-boards.greenhouse.io/acme/jobs/1?gh_src=abc&utm_source=linkedin&utm_medium=jobs&trk=x",
      ),
    ).toBe("https://job-boards.greenhouse.io/acme/jobs/1?gh_src=abc");
  });

  it("rejects LinkedIn itself and non-web links", () => {
    expect(cleanApplyUrl("https://www.linkedin.com/jobs/view/1")).toBeNull();
    expect(cleanApplyUrl("javascript:alert(1)")).toBeNull();
    expect(cleanApplyUrl("not a url")).toBeNull();
  });
});

describe("bestApplyLink", () => {
  it("prefers where the tab ended up when it is a known application system", () => {
    expect(
      bestApplyLink(
        "https://click.appcast.io/t/abc",
        "https://jobs.lever.co/acme/123/apply",
      ),
    ).toBe("https://jobs.lever.co/acme/123/apply");
  });

  it("keeps the first link when the tab ended somewhere generic (a login or home page)", () => {
    expect(
      bestApplyLink(
        "https://careers.acme.com/job/123",
        "https://careers.acme.com/login",
      ),
    ).toBe("https://careers.acme.com/job/123");
  });

  it("uses the final link when the first one was only a redirect host", () => {
    expect(
      bestApplyLink(
        "https://click.appcast.io/t/abc",
        "https://careers.acme.com/job/123",
      ),
    ).toBe("https://careers.acme.com/job/123");
  });
});
