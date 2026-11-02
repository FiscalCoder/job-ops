import { describe, expect, it } from "vitest";
import {
  getPostingAgeDays,
  getPostingAgeHours,
  partitionByPostingAge,
  partitionByPostingAgeHours,
} from "./posting-age";

const NOW = new Date("2026-10-11T12:00:00Z");

describe("getPostingAgeDays", () => {
  it("returns null when the source gave no date", () => {
    expect(getPostingAgeDays(null, NOW)).toBeNull();
    expect(getPostingAgeDays("   ", NOW)).toBeNull();
    expect(getPostingAgeDays("soon", NOW)).toBeNull();
  });

  it("measures ISO timestamps and plain dates", () => {
    expect(getPostingAgeDays("2026-10-01T12:00:00Z", NOW)).toBe(10);
    expect(getPostingAgeDays("2026-09-11", NOW)).toBe(30);
    expect(getPostingAgeDays("2026-10-10 12:00:00", NOW)).toBeGreaterThan(0);
  });

  it("never reports a negative age for future-dated postings", () => {
    expect(getPostingAgeDays("2026-12-01T00:00:00Z", NOW)).toBe(0);
  });

  it("understands relative phrases", () => {
    expect(getPostingAgeDays("today", NOW)).toBe(0);
    expect(getPostingAgeDays("Yesterday", NOW)).toBe(1);
    expect(getPostingAgeDays("5 hours ago", NOW)).toBe(0);
    expect(getPostingAgeDays("3 days ago", NOW)).toBe(3);
    expect(getPostingAgeDays("2 weeks ago", NOW)).toBe(14);
    expect(getPostingAgeDays("30+ days ago", NOW)).toBe(30);
    expect(getPostingAgeDays("1 month ago", NOW)).toBe(30);
  });
});

describe("partitionByPostingAge", () => {
  const jobs = [
    { id: "fresh", datePosted: "2026-10-05T00:00:00Z" },
    { id: "old", datePosted: "2026-08-01T00:00:00Z" },
    { id: "undated", datePosted: null },
    { id: "boundary", datePosted: "2026-09-11T12:00:00Z" },
  ];

  it("drops only postings dated past the limit", () => {
    const { fresh, stale } = partitionByPostingAge(jobs, 30, NOW);
    expect(fresh.map((job) => job.id)).toEqual([
      "fresh",
      "undated",
      "boundary",
    ]);
    expect(stale.map((job) => job.id)).toEqual(["old"]);
  });

  it("keeps everything when the limit is disabled", () => {
    const { fresh, stale } = partitionByPostingAge(jobs, 0, NOW);
    expect(fresh).toHaveLength(jobs.length);
    expect(stale).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [...jobs];
    partitionByPostingAge(input, 30, NOW);
    expect(input).toEqual(jobs);
  });
});

describe("getPostingAgeHours", () => {
  it("measures timestamps in hours, and relative phrases", () => {
    expect(getPostingAgeHours("2026-10-11T02:00:00Z", NOW)).toBe(10);
    expect(getPostingAgeHours("5 hours ago", NOW)).toBe(5);
    expect(getPostingAgeHours("2 days ago", NOW)).toBe(48);
    expect(getPostingAgeHours("today", NOW)).toBe(0);
    expect(getPostingAgeHours(null, NOW)).toBeNull();
  });

  it("a plain date counts from the end of that day (it may have been posted late)", () => {
    // Today: the day hasn't ended yet.
    expect(getPostingAgeHours("2026-10-11", NOW)).toBe(0);
    // The 10th ended 12 h ago.
    expect(getPostingAgeHours("2026-10-10", NOW)).toBe(12);
    expect(getPostingAgeHours("2026-10-09", NOW)).toBe(36);
  });
});

describe("partitionByPostingAgeHours", () => {
  const jobs = [
    { id: "new", datePosted: "2026-10-11T01:00:00Z" },
    { id: "yesterday", datePosted: "2026-10-10" },
    { id: "old", datePosted: "2026-10-08T12:00:00Z" },
    { id: "undated", datePosted: null },
  ];

  it("keeps the last 24 hours (and undated postings), drops the rest", () => {
    const { fresh, stale } = partitionByPostingAgeHours(jobs, 24, NOW);
    expect(fresh.map((j) => j.id)).toEqual(["new", "yesterday", "undated"]);
    expect(stale.map((j) => j.id)).toEqual(["old"]);
  });

  it("keeps everything when the limit is off", () => {
    expect(partitionByPostingAgeHours(jobs, 0, NOW).fresh).toHaveLength(4);
  });
});
