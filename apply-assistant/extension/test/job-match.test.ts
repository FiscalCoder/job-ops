import { describe, expect, it } from "vitest";
import type { QueueItem } from "../src/lib/api";
import {
  CONFIRMATION_PATH,
  CONFIRMATION_TEXT,
  isJobPage,
  jobForAddress,
} from "../src/track/job-match";

const item = (jobId: string, patch: Partial<QueueItem> = {}): QueueItem => ({
  jobId,
  title: "Engineer",
  employer: "Acme",
  score: 80,
  target: { status: "none" },
  plan: null,
  ...patch,
});

const queue = [
  item("li", { jobUrl: "https://www.linkedin.com/jobs/view/4472762282" }),
  item("naukri", {
    jobUrl:
      "https://www.naukri.com/job-listings-mean-stack-developer-iqvia-chennai-4-to-8-years-060426011432?src=jobsearchDesk",
  }),
  item("captured", {
    jobUrl: "https://www.linkedin.com/jobs/view/4481537592",
    applicationLink:
      "https://careers.bankofamerica.com/en-us/job-detail/26035586/software-engineer",
  }),
  item("ashby", {
    jobUrl: "https://www.linkedin.com/jobs/view/1",
    target: {
      status: "matched",
      ats: "ashby",
      postingUrl: "https://jobs.ashbyhq.com/elevenlabs/35813150-a851",
    },
  }),
];

describe("jobForAddress", () => {
  it("finds the job from its LinkedIn page, also a search page showing it", () => {
    for (const url of [
      "https://www.linkedin.com/jobs/view/4472762282/?refId=x",
      "https://www.linkedin.com/jobs/view/software-engineer-at-acme-4472762282",
      "https://www.linkedin.com/jobs/search/?currentJobId=4472762282&keywords=react",
    ])
      expect(jobForAddress(url, queue)).toMatchObject({
        item: { jobId: "li" },
        how: "linkedin",
      });
    expect(
      jobForAddress("https://www.linkedin.com/jobs/view/999999999", queue),
    ).toBeNull();
  });

  it("finds Naukri listings and saved company application pages", () => {
    expect(
      jobForAddress(
        "https://www.naukri.com/job-listings-mean-stack-developer-iqvia-chennai-4-to-8-years-060426011432",
        queue,
      ),
    ).toMatchObject({ item: { jobId: "naukri" }, how: "listing" });
    expect(
      jobForAddress(
        "https://careers.bankofamerica.com/en-us/job-detail/26035586/software-engineer?src=li",
        queue,
      ),
    ).toMatchObject({ item: { jobId: "captured" }, how: "listing" });
  });

  it("prefers the fillable posting", () => {
    expect(
      jobForAddress(
        "https://jobs.ashbyhq.com/elevenlabs/35813150-a851/application",
        queue,
      ),
    ).toMatchObject({ item: { jobId: "ashby" }, how: "posting" });
    expect(jobForAddress("chrome://newtab", queue)).toBeNull();
  });
});

describe("isJobPage and confirmation patterns", () => {
  it("remembers addresses only for job listings and application systems", () => {
    expect(isJobPage("https://www.linkedin.com/jobs/view/1")).toBe(true);
    expect(isJobPage("https://www.linkedin.com/feed/")).toBe(false);
    expect(isJobPage("https://www.naukri.com/job-listings-x-1")).toBe(true);
    expect(
      isJobPage("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1"),
    ).toBe(true);
    expect(isJobPage("https://mail.google.com/")).toBe(false);
  });

  it("spots confirmation pages", () => {
    expect(CONFIRMATION_TEXT.test("Thank you for applying to Acme!")).toBe(
      true,
    );
    expect(CONFIRMATION_TEXT.test("Your application has been submitted.")).toBe(
      true,
    );
    expect(CONFIRMATION_TEXT.test("Apply for this job")).toBe(false);
    expect(CONFIRMATION_PATH.test("/acme/jobs/1/confirmation")).toBe(true);
    expect(CONFIRMATION_PATH.test("/careers/thank-you?id=1")).toBe(true);
    expect(CONFIRMATION_PATH.test("/careers/jobs/1")).toBe(false);
  });
});
