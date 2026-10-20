import { describe, expect, it } from "vitest";
import {
  companyTargetOf,
  followed,
  startCapture,
  toReport,
} from "../src/capture/tracker";

const EXTERNAL =
  "https://www.linkedin.com/jobs/view/externalApply/4477797153?url=https%3A%2F%2Fclick%2Eappcast%2Eio%2Ft%2Fabc&urlHash=x";

describe("companyTargetOf", () => {
  it("decodes LinkedIn's redirect links and ignores other LinkedIn pages", () => {
    expect(companyTargetOf(EXTERNAL)).toBe("https://click.appcast.io/t/abc");
    expect(
      companyTargetOf(
        "https://www.linkedin.com/safety/go?url=https%3A%2F%2Fjobs.lever.co%2Fx%2F1",
      ),
    ).toBe("https://jobs.lever.co/x/1");
    expect(
      companyTargetOf("https://www.linkedin.com/jobs/view/4477797153"),
    ).toBeNull();
    expect(
      companyTargetOf(
        "https://www.linkedin.com/x?url=https%3A%2F%2Fwww.linkedin.com%2Ffeed",
      ),
    ).toBeNull();
    expect(companyTargetOf("https://jobs.lever.co/x/1")).toBe(
      "https://jobs.lever.co/x/1",
    );
    expect(companyTargetOf("chrome://newtab/")).toBeNull();
  });
});

describe("capture tracker", () => {
  it("follows LinkedIn's externalApply tab through redirects to the company page", () => {
    let pending = startCapture(EXTERNAL, null);
    expect(pending).toEqual({
      linkedinJobId: "4477797153",
      first: "https://click.appcast.io/t/abc",
      last: "https://click.appcast.io/t/abc",
    });
    if (!pending) throw new Error("expected a capture");
    pending = followed(pending, "https://job-boards.greenhouse.io/acme/jobs/1");
    expect(toReport(pending)).toEqual({
      linkedinJobId: "4477797153",
      applyUrl: "https://click.appcast.io/t/abc",
      finalUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
    });
  });

  it("uses the job open in the source LinkedIn tab when the new tab goes straight to the company", () => {
    const pending = startCapture("about:blank", "4477797153");
    if (!pending) throw new Error("expected a capture");
    const done = followed(
      followed(pending, "https://www.linkedin.com/redir/whatever"),
      "https://jobs.lever.co/acme/1",
    );
    expect(toReport(done)).toEqual({
      linkedinJobId: "4477797153",
      applyUrl: "https://jobs.lever.co/acme/1",
      finalUrl: null,
    });
  });

  it("ignores tabs not opened from a LinkedIn job, and tabs that never leave LinkedIn", () => {
    expect(startCapture("https://example.com", null)).toBeNull();
    const pending = startCapture(
      "https://www.linkedin.com/feed/",
      "4477797153",
    );
    if (!pending) throw new Error("expected a capture");
    expect(toReport(pending)).toBeNull();
  });
});
