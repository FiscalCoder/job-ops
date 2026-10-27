import { describe, expect, it } from "vitest";
import type { QueueItem } from "../src/lib/api";
import { jobForTab, pageKey, samePosting } from "../src/lib/tab-match";

const item = (jobId: string, target: QueueItem["target"]): QueueItem => ({
  jobId,
  title: "Engineer",
  employer: "Acme",
  score: 80,
  target,
  plan: null,
});

const queue = [
  item("ashby", {
    status: "matched",
    ats: "ashby",
    postingUrl:
      "https://jobs.ashbyhq.com/elevenlabs/35813150-a851-4821-b732-a037b4e6c4fe",
  }),
  item("gh", {
    status: "matched",
    ats: "greenhouse",
    postingUrl: "https://job-boards.greenhouse.io/acme/jobs/123",
  }),
  item("lever", {
    status: "matched",
    ats: "lever",
    postingUrl: "https://jobs.lever.co/acme/uuid-1",
  }),
  item("maybe", {
    status: "possible",
    ats: "greenhouse",
    postingUrl: "https://job-boards.greenhouse.io/other/jobs/9",
  }),
];

describe("jobForTab", () => {
  it("finds the job from its posting or the application page under it", () => {
    expect(
      jobForTab(
        "https://jobs.ashbyhq.com/elevenlabs/35813150-a851-4821-b732-a037b4e6c4fe/application?utm_source=linkedin",
        queue,
      )?.jobId,
    ).toBe("ashby");
    expect(
      jobForTab(
        "https://jobs.ashbyhq.com/ElevenLabs/35813150-A851-4821-B732-A037B4E6C4FE/",
        queue,
      )?.jobId,
    ).toBe("ashby");
    expect(
      jobForTab("https://jobs.lever.co/acme/uuid-1/apply", queue)?.jobId,
    ).toBe("lever");
    expect(
      jobForTab("https://boards.greenhouse.io/acme/jobs/123#app", queue)?.jobId,
    ).toBe("gh");
  });

  it("ignores other postings, unconfirmed matches and non-pages", () => {
    expect(
      jobForTab("https://job-boards.greenhouse.io/acme/jobs/1234", queue),
    ).toBeNull();
    expect(jobForTab("https://jobs.ashbyhq.com/elevenlabs", queue)).toBeNull();
    expect(
      jobForTab("https://job-boards.greenhouse.io/other/jobs/9", queue),
    ).toBeNull();
    expect(jobForTab(undefined, queue)).toBeNull();
    expect(jobForTab("chrome://extensions", queue)).toBeNull();
    expect(pageKey("not a url")).toBeNull();
  });
});

describe("samePosting", () => {
  it("a careers page with Greenhouse's embed is the same posting wherever it sends you", () => {
    expect(
      samePosting(
        "https://careers.toasttab.com/jobs/senior-software-engineer?gh_jid=8317320#applynow",
        "https://careers.toasttab.com/jobs?gh_jid=8317320",
      ),
    ).toBe(true);
    expect(
      samePosting(
        "https://careers.toasttab.com/jobs?gh_jid=1",
        "https://careers.toasttab.com/jobs?gh_jid=2",
      ),
    ).toBe(false);
    expect(
      samePosting(
        "https://other.example.com/jobs?gh_jid=1",
        "https://careers.toasttab.com/jobs?gh_jid=1",
      ),
    ).toBe(false);
    expect(
      samePosting(
        "https://jobs.ashbyhq.com/acme/123/",
        "https://jobs.ashbyhq.com/acme/123",
      ),
    ).toBe(true);
  });
});
