import { describe, expect, it } from "vitest";
import { classifyLivenessResponse } from "./classify";

const POSTING_URL = "https://boards.example.com/jobs/123-backend-engineer";

function classify(
  overrides: Partial<Parameters<typeof classifyLivenessResponse>[0]>,
) {
  return classifyLivenessResponse({
    requestedUrl: POSTING_URL,
    finalUrl: POSTING_URL,
    status: 200,
    body: "<html><body><h1>Backend Engineer</h1><p>Apply now</p></body></html>",
    ...overrides,
  });
}

describe("classifyLivenessResponse", () => {
  it("treats a reachable posting as live", () => {
    expect(classify({}).state).toBe("live");
  });

  it.each([404, 410])("treats HTTP %i as closed", (status) => {
    expect(classify({ status, body: "" }).state).toBe("closed");
  });

  it.each([
    401, 403, 429, 500, 503, 999,
  ])("treats HTTP %i as unknown, not closed", (status) => {
    expect(classify({ status, body: "" }).state).toBe("unknown");
  });

  it("lets only permanent walls fall back to age", () => {
    expect(classify({ status: 401, body: "" }).unverifiable).toBe(true);
    expect(classify({ status: 403, body: "" }).unverifiable).toBe(true);
    expect(classify({ status: 429, body: "" }).unverifiable).toBeFalsy();
    expect(classify({ status: 503, body: "" }).unverifiable).toBeFalsy();
  });

  it("treats a bot challenge answering 404 as unknown, not closed", () => {
    const verdict = classify({
      status: 404,
      body: "<html><title>Just a moment...</title></html>",
    });
    expect(verdict).toMatchObject({ state: "unknown", unverifiable: true });
  });

  it.each([
    "<template><p>This job is no longer available</p></template>",
    "<noscript>This job has expired</noscript>",
    "<!-- This job is no longer available -->",
    '<div data-msg="x"></div><script>var s="This job has expired"',
  ])("ignores closed-sounding text hidden in %j", (hidden) => {
    const verdict = classify({
      body: `<html><body><h1>Backend Engineer</h1>${hidden}</body></html>`,
    });
    expect(verdict.state).toBe("live");
  });

  it("does not read a job description as a closed notice", () => {
    const verdict = classify({
      body: "<html><body><p>Sorry, this position is not remote. The role has requirements.</p></body></html>",
    });
    expect(verdict.state).toBe("live");
  });

  it("ignores a redirect to another site's home page", () => {
    expect(
      classify({ finalUrl: "https://consent.other-site.com/" }).state,
    ).toBe("live");
  });

  it("ignores an expired-looking query the request already carried", () => {
    const requestedUrl =
      "https://boards.example.com/jobs/1?ref=expired-domains";
    expect(
      classify({
        requestedUrl,
        finalUrl: "https://boards.example.com/jobs/1/?ref=expired-domains",
      }).state,
    ).toBe("live");
  });

  it("stays fast on pathological markup", () => {
    const started = Date.now();
    classify({
      expectedTitle: "Backend Engineer",
      body: "<".repeat(500_000) + "<script ".repeat(60_000),
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("treats bot challenges as unknown even with a 200", () => {
    const verdict = classify({
      body: "<html><title>Just a moment...</title>challenges.cloudflare.com</html>",
    });
    expect(verdict.state).toBe("unknown");
  });

  it.each([
    "No longer accepting applications",
    "This job has expired on Indeed",
    "This job is no longer available.",
    "Sorry, this position has been filled.",
    "<b>No longer</b> accepting&nbsp;applications",
    "This position is no longer open",
    "The job you are looking for is no longer available",
    "Applications for this role are now closed",
  ])("detects the closed marker %j", (text) => {
    const verdict = classify({
      body: `<html><body><p>${text}</p></body></html>`,
    });
    expect(verdict.state).toBe("closed");
    expect(verdict.reason).toContain("Posting page says");
  });

  it("detects an expired-job page title", () => {
    const verdict = classify({
      body: "<html><head><title>HiringCafe - Expired Job</title></head></html>",
    });
    expect(verdict.state).toBe("closed");
  });

  it("ignores closed-sounding strings inside scripts", () => {
    const verdict = classify({
      body: '<html><script>var i18n={"expired":"This job has expired"}</script><body>Apply now</body></html>',
    });
    expect(verdict.state).toBe("live");
  });

  it("treats a redirect to the listing page as closed", () => {
    expect(
      classify({ finalUrl: "https://boards.example.com/jobs" }).state,
    ).toBe("closed");
    expect(classify({ finalUrl: "https://boards.example.com/" }).state).toBe(
      "closed",
    );
    expect(
      classify({ finalUrl: "https://boards.example.com/acme?error=true" })
        .state,
    ).toBe("closed");
  });

  it.each([
    "https://www.linkedin.com/jobs/javascript-developer-jobs?trk=expired_jd_redirect",
    "https://www.naukri.com/quality-engineer-jobs-in-chennai?expJD=true",
  ])("treats the expired redirect %s as closed", (finalUrl) => {
    const requestedUrl = `${new URL(finalUrl).origin}/job-listings/view/4457168285`;
    expect(classify({ requestedUrl, finalUrl }).state).toBe("closed");
  });

  it("is unknown when a reachable page never mentions the job title", () => {
    const verdict = classify({
      expectedTitle: "Senior Go Developer",
      body: "<html><title>Golang Jobs</title><div id='root'></div></html>",
    });
    expect(verdict).toMatchObject({ state: "unknown", unverifiable: true });
  });

  it("matches the title through markup, entities and embedded JSON", () => {
    expect(
      classify({
        expectedTitle: "R&D Engineer (Backend)",
        body: "<html><h1>R&amp;D  Engineer <span>(Backend)</span></h1></html>",
      }).state,
    ).toBe("live");
    expect(
      classify({
        expectedTitle: "Data Analyst",
        body: '<html><script>{"title":"Data Analyst"}</script></html>',
      }).state,
    ).toBe("live");
  });

  it("does not treat a redirect to another posting URL as closed", () => {
    expect(
      classify({
        finalUrl: "https://boards.example.com/jobs/123-backend-engineer/",
      }).state,
    ).toBe("live");
    expect(
      classify({ finalUrl: "https://www.example.com/en/jobs/view/123" }).state,
    ).toBe("live");
  });
});
