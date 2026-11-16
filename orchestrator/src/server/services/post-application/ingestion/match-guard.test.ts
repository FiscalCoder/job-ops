import { describe, expect, it } from "vitest";
import type { SmartRouterResult } from "./email-router";
import {
  type GuardJob,
  guardRouterResult,
  jobsForEmail,
  looksUnfinished,
  preferRequisitionMatch,
} from "./match-guard";

const DAY = 24 * 60 * 60 * 1000;

function job(overrides: Partial<GuardJob> & { id: string }): GuardJob {
  return {
    employer: "Oracle",
    title: "Senior Platform Software Engineer",
    appliedAt: null,
    applicationLink: null,
    jobUrl: "",
    jobUrlDirect: null,
    ...overrides,
  };
}

function routed(overrides: Partial<SmartRouterResult> = {}): SmartRouterResult {
  return {
    bestMatchId: null,
    confidence: 0,
    stageTarget: "no_change",
    messageType: "other",
    isRelevant: false,
    stageEventPayload: null,
    reason: "routed",
    ...overrides,
  };
}

describe("jobsForEmail", () => {
  const received = Date.parse("2026-10-28T10:00:00Z");

  it("leaves out applications made well after the email arrived", () => {
    const early = job({ id: "a", appliedAt: "2026-10-22T10:00:00Z" });
    // The real case: re-applied to Fanatics 2.9 days after its rejection.
    const later = job({ id: "b", appliedAt: "2026-10-31T07:34:21Z" });
    expect(jobsForEmail([early, later], received).map((j) => j.id)).toEqual([
      "a",
    ]);
  });

  it("keeps an application marked a little after its confirmation email", () => {
    const markedLate = job({
      id: "a",
      appliedAt: new Date(received + DAY / 2).toISOString(),
    });
    expect(jobsForEmail([markedLate], received)).toHaveLength(1);
  });

  it("keeps jobs with no or unreadable applied date", () => {
    const none = job({ id: "a", appliedAt: null });
    const bad = job({ id: "b", appliedAt: "not a date" });
    expect(jobsForEmail([none, bad], received)).toHaveLength(2);
  });
});

describe("preferRequisitionMatch", () => {
  const first = job({
    id: "first",
    applicationLink:
      "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/348254",
  });
  const second = job({
    id: "second",
    applicationLink:
      "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/348249",
  });
  const latest = job({
    id: "latest",
    applicationLink:
      "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/346325",
  });
  const jobs = [first, second, latest];
  const email =
    "Thank you for your interest in the position of Senior Platform Software Engineer-348249.";

  it("moves the match to the same company's job whose link has the email's requisition number", () => {
    expect(preferRequisitionMatch("latest", email, jobs)).toBe("second");
  });

  it("keeps the chosen job when its own link has the number", () => {
    expect(preferRequisitionMatch("second", email, jobs)).toBe("second");
  });

  it("keeps the chosen job when no number in the email is in any link", () => {
    expect(preferRequisitionMatch("latest", "Thanks for applying!", jobs)).toBe(
      "latest",
    );
  });

  it("never moves the match to another company", () => {
    const other = job({
      id: "other",
      employer: "Toast",
      applicationLink: "https://careers.toasttab.com/jobs?gh_jid=348249",
    });
    expect(preferRequisitionMatch("latest", email, [latest, other])).toBe(
      "latest",
    );
  });

  it("keeps the chosen job when the number points at more than one job", () => {
    const dupe = job({ id: "dupe", jobUrl: second.applicationLink ?? "" });
    expect(preferRequisitionMatch("latest", email, [...jobs, dupe])).toBe(
      "latest",
    );
  });

  it("matches Workday-style ids like R-090603", () => {
    const jj = [
      job({ id: "x", employer: "J&J", jobUrl: "https://jj.wd5.myworkdayjobs.com/x/job/R-094443" }),
      job({ id: "y", employer: "J&J", jobUrl: "https://jj.wd5.myworkdayjobs.com/x/job/R-090603" }),
    ];
    expect(
      preferRequisitionMatch("x", "Thank you for applying for Sr Eng R-090603", jj),
    ).toBe("y");
  });

  it("returns null when nothing was chosen", () => {
    expect(preferRequisitionMatch(null, email, jobs)).toBeNull();
  });
});

describe("looksUnfinished", () => {
  it.each([
    "Reminder: Complete your application to Nexoya",
    "Your application is almost complete but it will not be submitted until you finalize it",
    "Verify your account to finalise your application to hurra.com",
  ])("flags %s", (text) => {
    expect(looksUnfinished(text)).toBe(true);
  });

  it.each([
    "Atlassian: Thanks for Completing Your Application",
    "Thank you for applying to GitLab",
    "We have received your completed application",
  ])("does not flag %s", (text) => {
    expect(looksUnfinished(text)).toBe(false);
  });
});

describe("guardRouterResult", () => {
  it("applies the requisition match", () => {
    const jobs = [
      job({ id: "a", applicationLink: "https://x.example/job/348254" }),
      job({ id: "b", applicationLink: "https://x.example/job/348249" }),
    ];
    const result = guardRouterResult(
      routed({ bestMatchId: "b", confidence: 90, stageTarget: "rejected", messageType: "rejection", isRelevant: true }),
      { emailText: "Senior Platform Software Engineer-348254", jobs },
    );
    expect(result.bestMatchId).toBe("a");
    expect(result.stageTarget).toBe("rejected");
  });

  it("turns an unfinished-application reminder into a suggestion that changes no stage", () => {
    const result = guardRouterResult(
      routed({ bestMatchId: "a", confidence: 98, stageTarget: "applied", messageType: "update", isRelevant: false }),
      {
        emailText: "Subject: Reminder: Complete your application to Nexoya",
        jobs: [job({ id: "a", employer: "Nexoya" })],
      },
    );
    expect(result).toMatchObject({
      bestMatchId: "a",
      isRelevant: true,
      stageTarget: "no_change",
      messageType: "other",
    });
    expect(result.confidence).toBeLessThan(95);
    expect(result.reason).toMatch(/^Application not submitted yet/);
  });

  it("leaves an ordinary result alone", () => {
    const original = routed({ bestMatchId: "a", confidence: 97, stageTarget: "applied", messageType: "update", isRelevant: true });
    expect(
      guardRouterResult(original, { emailText: "Thanks for applying", jobs: [job({ id: "a" })] }),
    ).toEqual(original);
  });
});
