import { describe, expect, it } from "vitest";
import { experienceMonths, resumeForPrompt } from "../src/claude/questions.js";
import type { ResumeFacts } from "../src/plan/resume-facts.js";
import { tailoredFor } from "../src/plan/tailored-resume.js";

const base: ResumeFacts = {
  email: null,
  phone: null,
  links: { linkedin: null, github: null, website: null },
  experience: [
    {
      company: "Athenahealth",
      title: "SMTS",
      location: "Chennai",
      description: "",
      start: { year: 2025, month: 9 },
      end: null,
      current: true,
    },
    {
      company: "Hueint",
      title: "Product Engineer",
      location: "Chennai",
      description: "",
      start: { year: 2019, month: 12 },
      end: { year: 2025, month: 8 },
      current: false,
    },
    // Overlaps the role above: counted once.
    {
      company: "Side gig",
      title: "Consultant",
      location: "",
      description: "",
      start: { year: 2021, month: 1 },
      end: { year: 2021, month: 6 },
      current: false,
    },
  ],
  education: [],
  summary: "Base summary",
  skills: [{ name: "Base", keywords: ["Java"] }],
  projects: [
    { id: "proj-a", name: "Alpha", description: "A" },
    { id: "proj-b", name: "Beta", description: "B" },
  ],
};

describe("tailoredFor", () => {
  it("takes this job's summary, headline, skills and picked projects", () => {
    const resume = tailoredFor(base, {
      tailoredSummary: "Tailored summary",
      tailoredHeadline: "Forward Deployed Engineer",
      tailoredSkills: JSON.stringify([
        { name: "Proficient", keywords: ["React", " Node.js "] },
      ]),
      selectedProjectIds: "proj-b",
    });
    expect(resume.summary).toBe("Tailored summary");
    expect(resume.headline).toBe("Forward Deployed Engineer");
    expect(resume.skills).toEqual([
      { name: "Proficient", keywords: ["React", "Node.js"] },
    ]);
    expect(resume.projects?.map((p) => p.name)).toEqual(["Beta"]);
    expect(resume.experience).toBe(base.experience);
  });

  it("keeps the design resume when the job isn't tailored, and its skills when they don't parse", () => {
    expect(tailoredFor(base, { tailoredSummary: null })).toBe(base);
    const resume = tailoredFor(base, {
      tailoredSummary: "Tailored",
      tailoredSkills: "not json",
    });
    expect(resume.skills).toBe(base.skills);
    expect(resume.projects).toEqual([]);
  });
});

describe("experience in the prompt", () => {
  it("counts months worked once, to today", () => {
    // Dec 2019 to Oct 2026, the overlap counted once: 6 years 11 months.
    expect(experienceMonths(base, new Date(2026, 9, 27))).toBe(83);
    const prompt = resumeForPrompt(
      tailoredFor(base, {
        tailoredSummary: "Tailored",
        tailoredHeadline: "Lead Engineer",
        selectedProjectIds: "proj-a",
      }),
      new Date(2026, 9, 27),
    );
    expect(prompt).toContain(
      "Total professional experience: 6 years 11 months",
    );
    expect(prompt).toContain("Headline: Lead Engineer");
    expect(prompt).toContain("Summary: Tailored");
    expect(prompt).toContain("- Alpha: A");
    expect(prompt).not.toContain("Beta");
  });
});
