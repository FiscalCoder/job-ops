// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPLY, CLOSED, NEVER, readNavPage } from "../src/autopilot/nav-page";
import { savedRef } from "../src/autopilot/navigator";
import { autopilotOrder, openLink, startLink } from "../src/autopilot/runner";
import type { QueueItem } from "../src/lib/api";

/** Autopilot: reading pages on the way to a form, and which jobs it opens, in which order. */

beforeEach(() => {
  // jsdom has no layout: an element with the hidden attribute has no box, everything else one.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const size = this.closest("[hidden]") ? 0 : 20;
    return { width: size, height: size } as DOMRect;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("reading a page on the way to the form", () => {
  it("a job page: its Apply button, never LinkedIn's; the button in the page beats the header link", () => {
    document.title = "Backend Engineer · Acme Careers";
    document.body.innerHTML = `
      <header><a href="/apply">Apply</a><a href="/jobs">All jobs</a></header>
      <main><h1>Backend Engineer</h1><p>Build things.</p>
        <a href="https://www.linkedin.com/jobs/1">Apply with LinkedIn</a>
        <button>Apply now</button>
        <button hidden>Apply for this job</button></main>`;
    const page = readNavPage();
    expect(page.form).toBe(false);
    expect(page.closed).toBeNull();
    expect(page.apply.map((a) => a.text)).toEqual(["Apply now", "Apply"]);
    // Every clickable is in the outline with its mark, which finds it again.
    expect(page.outline).toContain("| button | Apply now");
    const first = page.apply[0]?.ref ?? "";
    expect(document.querySelector(`[data-ac-nav="${first}"]`)?.textContent).toBe("Apply now");
  });

  it("the form is here: name, email and a resume upload", () => {
    document.body.innerHTML = `<form>
      <label>Name <input name="name"></label><label>Email <input type="email"></label>
      <label>Phone <input name="phone"></label><input type="file" name="resume"></form>`;
    expect(readNavPage().form).toBe(true);
  });

  it("a newsletter box isn't a form; a sign-in wall is a sign-in", () => {
    document.body.innerHTML = `<footer><input type="email" placeholder="Newsletter"></footer><main><h1>Jobs</h1></main>`;
    expect(readNavPage().form).toBe(false);
    document.body.innerHTML = `<h1>Sign in to apply</h1><input type="email"><input type="password"><button>Sign in</button>`;
    expect(readNavPage()).toMatchObject({ login: true, form: false });
  });

  it("a form embedded from another site (Greenhouse's frame on Avathon's page) is found by its address", () => {
    document.body.innerHTML = `<main><h1>Careers</h1>
      <iframe src="https://job-boards.greenhouse.io/embed/job_app?for=avathon&token=4714148005"></iframe>
      <iframe src="https://www.youtube.com/embed/x"></iframe></main>`;
    const page = readNavPage();
    expect(page.form).toBe(false);
    expect(page.embeds).toEqual([
      "https://job-boards.greenhouse.io/embed/job_app?for=avathon&token=4714148005",
    ]);
  });

  it("a job alert's email box beside Apply isn't the form (Danaher): Apply is clicked", () => {
    document.body.innerHTML = `<main><h1>Full Stack Senior Software Engineer</h1>
      <button>Apply Now</button><input type="checkbox" id="save-1-R13"><label for="alert">Enter Email address</label>
      <input type="email" id="alert"><input type="text" id="keyword"></main>`;
    const page = readNavPage();
    expect(page.form).toBe(false);
    expect(page.apply.map((a) => a.text)).toContain("Apply Now");
    // With a name to give too, it is one.
    document.body.innerHTML += `<input id="first_name">`;
    expect(readNavPage().form).toBe(true);
  });

  it("a closed posting says so near the top", () => {
    document.title = "Careers";
    document.body.innerHTML = `<h1>Sorry, this job is no longer available</h1>`;
    expect(readNavPage().closed).toContain("no longer available");
  });
});

describe("wording", () => {
  it("closed postings", () => {
    for (const text of [
      "This position has been filled",
      "The job you are looking for is no longer available",
      "We are not accepting applications for this role",
      "Page not found",
      "This job posting has expired",
    ])
      expect(CLOSED.test(text), text).toBe(true);
    for (const text of ["Apply now", "We closed a big round last year", "Remote position"])
      expect(CLOSED.test(text), text).toBe(false);
  });

  it("Apply buttons, and what's never clicked", () => {
    for (const text of ["Apply", "Apply now", "Apply for this job", "Apply on company site", "Start application"])
      expect(APPLY.test(text), text).toBe(true);
    for (const text of ["Applying to Acme", "Apply filters", "Save job"])
      expect(APPLY.test(text), text).toBe(false);
    for (const text of ["Apply with LinkedIn", "Easy Apply", "Submit application", "https://in.indeed.com/x"])
      expect(NEVER.test(text), text).toBe(true);
  });
});

const item = (jobId: string, patch: Partial<QueueItem> = {}): QueueItem => ({
  jobId,
  title: "Engineer",
  employer: "Acme",
  score: 70,
  jobUrl: "https://careers.acme.example/jobs/1",
  applicationLink: null,
  target: { status: "matched" },
  plan: null,
  ...patch,
});

describe("which jobs, in which order", () => {
  it("highest score first; a company whose limit is used up is left out", () => {
    const order = autopilotOrder([
      item("low", { score: 60 }),
      item("none", { score: null }),
      item("high", { score: 95 }),
      item("limited", {
        score: 99,
        companyLimit: {
          id: 1,
          name: "Acme",
          maxApplications: 1,
          windowDays: 183,
          note: "",
          used: [],
          full: true,
          nextOpen: null,
        },
      }),
    ]);
    expect(order.map((i) => i.jobId)).toEqual(["high", "low", "none"]);
  });

  it("opened at its application link, else its page; never on LinkedIn or Indeed", () => {
    expect(startLink(item("a", { applicationLink: "https://jobs.acme.example/apply/1" }))).toBe(
      "https://jobs.acme.example/apply/1",
    );
    expect(
      startLink(item("b", { applicationLink: "https://www.linkedin.com/jobs/view/1" })),
    ).toBe("https://careers.acme.example/jobs/1");
    expect(startLink(item("c", { jobUrl: "https://in.indeed.com/viewjob?jk=1" }))).toBeNull();
  });

  it("a known system's posting is opened there; a job with no company link isn't opened (or counted)", () => {
    expect(
      openLink(item("g", { target: { status: "matched", ats: "greenhouse", postingUrl: "https://job-boards.greenhouse.io/x/jobs/1" } })),
    ).toBe("https://job-boards.greenhouse.io/x/jobs/1");
    expect(openLink(item("l", { jobUrl: "https://www.linkedin.com/jobs/view/9" }))).toBeNull();
  });
});

describe("a site's saved way to its form", () => {
  const outline = [
    "0:e1 | link | Jobs | https://x/jobs",
    "0:e2 | link | Join us → | https://x/form",
    "1:e1 | button | Continue",
  ].join("\n");
  it("clicks what was clicked last time, in order, skipping what's been tried", () => {
    expect(savedRef(outline, ["Join us →", "Continue"], new Set())).toBe("0:e2");
    expect(savedRef(outline, ["Join us →", "Continue"], new Set(["join us →"]))).toBe("1:e1");
    expect(savedRef(outline, ["Apply"], new Set())).toBe("");
  });
});
