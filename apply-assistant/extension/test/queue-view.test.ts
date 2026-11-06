// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyBadge,
  companyKey,
  groupByCompany,
  isNew,
  NO_FILTERS,
  passesFilters,
  type QueueFilters,
  limitText,
  matchesSearch,
  meetsMinScore,
  periodText,
  postedText,
  type QueueViewActions,
  renderQueue,
  sortedFlat,
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

const calls: string[] = [];
const actions: QueueViewActions = {
  row: (i, showEmployer, menu) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `${i.title}${showEmployer ? ` (${i.employer})` : ""}`;
    li.append(label);
    if (menu) li.append(menu);
    return li;
  },
  limit: (company) => calls.push(`limit ${company}`),
  unlimit: () => {},
  block: (company) => calls.push(`block ${company}`),
  hide: (key, company) => calls.push(`hide ${key} ${company}`),
  unhide: (key) => calls.push(`unhide ${key}`),
};
const lines = (list: HTMLElement) =>
  [...list.children].map((li) =>
    (li.querySelector(".label") ?? li).textContent?.replace(/\s+/g, " ").trim(),
  );
const button = (list: HTMLElement, text: string) =>
  [...list.querySelectorAll("button")].find((b) => b.textContent === text);

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

  it("renders a header per company, then its roles; Hide, Limit and Block in its menu", () => {
    const list = document.createElement("ul");
    calls.length = 0;
    renderQueue(list, items, actions);
    expect(lines(list)).toEqual([
      "Acme · 2 roles",
      "Backend",
      "Engineer (Acme Pvt Ltd)",
      "Amazon · 2 roles",
      "SDE II",
      "SDE III (Amazon Web Services)",
    ]);
    expect(list.textContent).toContain("1 per 6 months: pick your one best role");
    // Each asks about the company as the header names it.
    button(list, "Block…")?.click();
    button(list, "Hide company")?.click();
    expect(calls).toEqual(["block Acme", "hide acme Acme"]);
  });

  it("a hidden company (shown when you ask for hidden ones) offers Unhide", () => {
    const list = document.createElement("ul");
    calls.length = 0;
    renderQueue(list, items, actions, { hidden: new Set(["acme"]) });
    button(list, "Unhide")?.click();
    expect(calls).toEqual(["unhide acme"]);
    expect(list.querySelector("li.company.hidden-company")).not.toBeNull();
  });
});

describe("sorting the queue", () => {
  const dated = [
    item({ jobId: "old", employer: "Beta", score: 95, postedAt: "2026-10-10", foundAt: "2026-10-21T00:00:00Z" }),
    item({ jobId: "new", employer: "Acme", score: 70, postedAt: "2026-10-21", foundAt: "2026-10-12T00:00:00Z" }),
    item({ jobId: "undated", employer: "Gamma", score: 99, postedAt: null, foundAt: null }),
    item({ jobId: "closed", employer: "Delta", score: 100, postedAt: "2026-10-22", target: { status: "closed" } }),
  ];

  it("newest posted first, then recently found; undated and closed last", () => {
    expect(sortedFlat(dated, "posted").map((i) => i.jobId)).toEqual([
      "new",
      "old",
      "undated",
      "closed",
    ]);
    expect(sortedFlat(dated, "found").map((i) => i.jobId)).toEqual([
      "old",
      "new",
      "undated",
      "closed",
    ]);
  });

  it("best match: a company whose roles are all closed goes last", () => {
    expect(groupByCompany(dated).map((g) => g.company)).toEqual([
      "Gamma",
      "Beta",
      "Acme",
      "Delta",
    ]);
  });

  it("company A-Z groups alphabetically", () => {
    expect(groupByCompany(dated, "company").map((g) => g.company)).toEqual([
      "Acme",
      "Beta",
      "Delta",
      "Gamma",
    ]);
  });

  it("flat sorts list each role with its company, and its own Hide company", () => {
    const list = document.createElement("ul");
    calls.length = 0;
    renderQueue(list, dated, actions, { sort: "posted" });
    expect(lines(list)).toEqual([
      "Engineer (Acme)",
      "Engineer (Beta)",
      "Engineer (Gamma)",
      "Engineer (Delta)",
    ]);
    button(list, "Hide company")?.click();
    expect(calls).toEqual(["hide acme Acme"]);
  });

  it("one key per company, legal names aside", () => {
    expect(companyKey(item({ employer: "Acme Pvt Ltd" }))).toBe(
      companyKey(item({ employer: "acme" })),
    );
  });
});

describe("searching the queue", () => {
  const job = item({
    title: "Senior Backend Engineer",
    employer: "Acme Robotics",
    jobUrl: "https://www.linkedin.com/jobs/view/1",
    applicationLink: "https://careers.acme.com/jobs/7",
    target: { status: "matched", ats: "greenhouse", postingUrl: "https://job-boards.greenhouse.io/acme/jobs/7" },
  });
  it("every word, in any order and case, in its company, role, system or site", () => {
    expect(matchesSearch(job, "")).toBe(true);
    expect(matchesSearch(job, "acme backend")).toBe(true);
    expect(matchesSearch(job, "BACKEND senior")).toBe(true);
    expect(matchesSearch(job, "greenhouse")).toBe(true);
    expect(matchesSearch(job, "careers.acme")).toBe(true);
    expect(matchesSearch(job, "acme frontend")).toBe(false);
    expect(matchesSearch(job, "okta")).toBe(false);
  });
});

describe("filters, New, and where you apply", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const jobs = [
    item({ jobId: "today", postedAt: "2026-10-22", location: "Remote", foundAt: "2026-10-22T00:05:00Z" }),
    item({ jobId: "week", postedAt: "2026-10-17", location: "Chennai, Tamil Nadu, India", foundAt: "2026-10-18T00:05:00Z" }),
    item({
      jobId: "ready",
      postedAt: null,
      title: "Remote Backend Engineer",
      target: { status: "matched", ats: "ashby" },
      plan: { summary: { needsYou: 0 }, builtAt: "2026-10-20" },
    }),
  ];
  const ids = (filters: QueueFilters) =>
    jobs.filter((j) => passesFilters(j, filters, now)).map((j) => j.jobId);

  it("posted within a day or a few, Remote, Ready to fill; none set: everything", () => {
    expect(ids(NO_FILTERS)).toEqual(["today", "week", "ready"]);
    expect(ids({ ...NO_FILTERS, posted: "1" })).toEqual(["today"]);
    expect(ids({ ...NO_FILTERS, posted: "7" })).toEqual(["today", "week"]);
    expect(ids({ ...NO_FILTERS, remote: true })).toEqual(["today", "ready"]);
    expect(ids({ ...NO_FILTERS, ready: true })).toEqual(["ready"]);
  });

  it("jobs a rescore pushed below 70 are hidden until you ask; unscored ones show", () => {
    const scored = [
      item({ jobId: "high", score: 82 }),
      item({ jobId: "edge", score: 70 }),
      item({ jobId: "low", score: 61 }),
      item({ jobId: "capped", score: 25 }),
      item({ jobId: "unscored", score: null }),
    ];
    const shown = (filters: QueueFilters) =>
      scored.filter((j) => passesFilters(j, filters, now)).map((j) => j.jobId);
    expect(shown(NO_FILTERS)).toEqual(["high", "edge", "unscored"]);
    expect(shown({ ...NO_FILTERS, lowScores: true })).toEqual([
      "high",
      "edge",
      "low",
      "capped",
      "unscored",
    ]);
    expect(scored.filter(meetsMinScore).map((j) => j.jobId)).toEqual([
      "high",
      "edge",
      "unscored",
    ]);
  });

  it("New: found since you last looked (nothing is new the first time)", () => {
    const since = new Date("2026-10-20T00:00:00Z").getTime();
    expect(jobs.map((j) => isNew(j, since))).toEqual([true, false, false]);
    expect(isNew(jobs[0] as QueueItem, null)).toBe(false);
  });

  it("says where you apply, not what it isn't", () => {
    const at = (more: Partial<QueueItem>) => applyBadge(item(more))?.label;
    expect(at({ applicationLink: "https://acme.wd5.myworkdayjobs.com/x/apply" })).toBe("Apply on Workday");
    expect(at({ applicationLink: "https://careers.acme.com/jobs/1" })).toBe("Apply on company site");
    expect(at({ jobUrl: "https://www.linkedin.com/jobs/view/1" })).toBe("Apply on LinkedIn");
    expect(at({ target: { status: "matched", ats: "greenhouse" } })).toBe("On Greenhouse");
    expect(at({ target: { status: "closed" } })).toBe("Closed");
    expect(at({})).toBeUndefined();
  });
});

describe("posted within, by the time when there is one", () => {
  it("Last 24h: a posting from 30 hours ago is out; a plain date of yesterday is in", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    const within = (postedAt: string) =>
      passesFilters(item({ postedAt }), { ...NO_FILTERS, posted: "1" }, now);
    expect(within("2026-10-21T06:00:00Z")).toBe(false);
    expect(within("2026-10-21T18:00:00Z")).toBe(true);
    expect(within("2026-10-21")).toBe(true);
    expect(within("2026-10-20")).toBe(false);
  });
});
