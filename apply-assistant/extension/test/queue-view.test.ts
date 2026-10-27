// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  groupByCompany,
  limitText,
  periodText,
  postedText,
  renderQueue,
} from "../entrypoints/sidepanel/queue-view";
import type { CompanyWindow, QueueItem } from "../src/lib/api";

/** The queue grouped by company, with posted dates and limited companies' windows. */

const amazon: CompanyWindow = {
  id: 1,
  name: "Amazon",
  maxApplications: 1,
  windowDays: 183,
  note: "",
  used: [],
  full: false,
  nextOpen: null,
};
const item = (more: Partial<QueueItem>): QueueItem => ({
  jobId: "x",
  title: "Engineer",
  employer: "Acme",
  score: 70,
  target: { status: "none" },
  plan: null,
  ...more,
});
const items = [
  item({ jobId: "acme", employer: "Acme Pvt Ltd", score: 75 }),
  item({
    jobId: "aws-1",
    employer: "Amazon",
    title: "SDE II",
    score: 82,
    companyLimit: amazon,
  }),
  item({ jobId: "acme-2", employer: "Acme", title: "Backend", score: 90 }),
  item({
    jobId: "aws-2",
    employer: "Amazon Web Services",
    title: "SDE III",
    score: 60,
    companyLimit: amazon,
  }),
];

describe("queue grouped by company", () => {
  it("one group per company (legal names and divisions together), best company first", () => {
    const groups = groupByCompany(items);
    expect(groups.map((g) => [g.company, g.items.map((i) => i.jobId)])).toEqual(
      [
        ["Acme", ["acme-2", "acme"]],
        ["Amazon", ["aws-1", "aws-2"]],
      ],
    );
    expect(groups[1]?.limit?.name).toBe("Amazon");
  });

  it("says where you stand with a limited company", () => {
    expect(limitText(amazon)).toEqual({
      text: "1 per 6 months: pick your one best role",
      tone: "warn",
    });
    const used = limitText({
      ...amazon,
      full: true,
      used: [{ jobId: "a", title: "SDE I", appliedAt: "2026-09-17T10:00:00Z" }],
      nextOpen: "2027-03-19",
    });
    expect(used.tone).toBe("bad");
    expect(used.text).toMatch(
      /^1 per 6 months: used \(SDE I, .*2026\)\. Next opens .*2027$/,
    );
    expect(periodText(30)).toBe("30 days");
  });

  it("when each role was posted", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    expect(postedText("2026-10-22", now)).toBe("posted today");
    expect(postedText("2026-10-21", now)).toBe("posted yesterday");
    expect(postedText("2026-10-18", now)).toBe("posted 4 days ago");
    expect(postedText(null, now)).toBe("");
  });

  it("renders a header per company, then its roles", () => {
    const list = document.createElement("ul");
    const blocked: string[] = [];
    renderQueue(list, items, {
      row: (i, showEmployer) => {
        const li = document.createElement("li");
        li.textContent = `${i.title}${showEmployer ? ` (${i.employer})` : ""}`;
        return li;
      },
      limit: () => {},
      unlimit: () => {},
      block: (company) => blocked.push(company),
    });
    expect(
      [...list.children].map((li) =>
        li.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "Acme · 2 rolesLimit… Block…",
      "Backend",
      "Engineer (Acme Pvt Ltd)",
      "Amazon · 2 rolesRemove limit Block…1 per 6 months: pick your one best role",
      "SDE II",
      "SDE III (Amazon Web Services)",
    ]);
    // Block… asks about the company as the header names it.
    const block = [...list.querySelectorAll("button")].find(
      (b) => b.textContent === "Block…",
    );
    block?.click();
    expect(blocked).toEqual(["Acme"]);
  });
});
