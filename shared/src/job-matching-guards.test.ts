import { describe, expect, it } from "vitest";
import { deduplicateJobsByTitleAndEmployer } from "./job-matching";
import { levelsOf, mayBeSameJob } from "./job-matching-guards";
import type { CreateJobInput } from "./types/jobs";

const job = (title: string, location?: string): CreateJobInput => ({
  source: "linkedin",
  title,
  employer: "Acme Pvt Ltd",
  jobUrl: `https://example.com/${encodeURIComponent(title + (location ?? ""))}`,
  location,
});

describe("dedupe guards", () => {
  it("folds level spellings together", () => {
    expect(levelsOf("SDE-2")).toBe(levelsOf("SDE II"));
    expect(levelsOf("Sr. Engineer")).toBe(levelsOf("Senior Engineer"));
    expect(levelsOf("Backend Engineer")).toBe("");
  });

  it("keeps postings for different levels apart", () => {
    expect(
      deduplicateJobsByTitleAndEmployer([
        job("Software Engineer I", "Bengaluru"),
        job("Software Engineer II", "Bengaluru"),
      ]),
    ).toHaveLength(2);
  });

  it("keeps the same title in different cities apart", () => {
    expect(
      deduplicateJobsByTitleAndEmployer([
        job("Data Engineer", "Bengaluru, Karnataka, India"),
        job("Data Engineer", "Pune, Maharashtra, India"),
      ]),
    ).toHaveLength(2);
  });

  it("still merges one job listed with different spellings of its place", () => {
    expect(
      mayBeSameJob(job("Data Engineer", "Bangalore"), job("Data Engineer", "Bengaluru, Karnataka")),
    ).toBe(true);
    expect(
      mayBeSameJob(job("Data Engineer", "Remote, India"), job("Data Engineer", "Hyderabad")),
    ).toBe(true);
    expect(mayBeSameJob(job("Data Engineer"), job("Data Engineer", "Pune"))).toBe(true);
    expect(
      deduplicateJobsByTitleAndEmployer([
        job("Senior Data Engineer", "Bangalore, India"),
        job("Senior Data Engineer", "Bengaluru"),
      ]),
    ).toHaveLength(1);
  });
});
