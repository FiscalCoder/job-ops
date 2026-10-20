import { describe, expect, it } from "vitest";
import {
  degreeLevel,
  parsePeriod,
  resumeFacts,
} from "../src/plan/resume-facts.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

describe("parsePeriod", () => {
  it.each([
    [
      "September 2023 - Present",
      { start: { year: 2023, month: 9 }, end: null, current: true },
    ],
    [
      "Jan 2020 – Aug 2023",
      {
        start: { year: 2020, month: 1 },
        end: { year: 2023, month: 8 },
        current: false,
      },
    ],
    [
      "03/2018 - 12/2019",
      {
        start: { year: 2018, month: 3 },
        end: { year: 2019, month: 12 },
        current: false,
      },
    ],
    [
      "2015 - 2019",
      {
        start: { year: 2015, month: null },
        end: { year: 2019, month: null },
        current: false,
      },
    ],
    ["2019", { start: null, end: { year: 2019, month: null }, current: false }],
    ["", { start: null, end: null, current: false }],
    ["sometime", { start: null, end: null, current: false }],
  ])("%s", (input, expected) => {
    expect(parsePeriod(input)).toEqual(expected);
  });
});

describe("degreeLevel", () => {
  it.each([
    ["B.Tech", "bachelor"],
    ["BE", "bachelor"],
    ["B.Sc", "bachelor"],
    ["Bachelor of Engineering", "bachelor"],
    ["M.Tech", "master"],
    ["MCA", "master"],
    ["MS", "master"],
    ["PhD", "doctorate"],
    ["XII Science", "high_school"],
    ["Higher Secondary", "high_school"],
    ["Diploma", "associate"],
    ["Certificate of Something", null],
    ["PG Diploma", null],
    ["Post Graduate Diploma in Management", null],
  ])("%s → %s", (degree, level) => {
    expect(degreeLevel(degree)).toBe(level);
  });
});

describe("resumeFacts", () => {
  it("extracts contact, links, visible experience (most recent first) and education", () => {
    const facts = resumeFacts(fakeDesignResume);
    expect(facts.email).toBe("test@example.com");
    expect(facts.phone).toBe("9876543210");
    expect(facts.links).toEqual({
      linkedin: "https://linkedin.com/in/test",
      github: "https://github.com/test",
      website: "https://example.dev",
    });
    expect(facts.experience.map((e) => e.company)).toEqual(["Acme", "Beta"]);
    expect(facts.experience[0]).toMatchObject({
      title: "Senior Engineer",
      current: true,
      start: { year: 2023, month: 9 },
      description: "Built things",
    });
    expect(facts.education[0]).toMatchObject({
      school: "Some Institute of Technology",
      level: "bachelor",
      area: "Computer Science",
      endYear: 2019,
    });
    expect(facts.summary).toBe("Full-stack engineer.");
    expect(facts.skills).toEqual([
      { name: "Frontend", keywords: ["React", "TypeScript"] },
    ]);
  });

  it("adds https:// to bare links", () => {
    const bare = structuredClone(fakeDesignResume);
    bare.basics.website.url = "example.dev";
    expect(resumeFacts(bare).links.website).toBe("https://example.dev");
  });

  it("orders education highest level first", () => {
    const flipped = structuredClone(fakeDesignResume);
    flipped.sections.education.items.reverse();
    expect(resumeFacts(flipped).education.map((e) => e.level)).toEqual([
      "bachelor",
      "high_school",
    ]);
  });

  it("copes with a resume missing optional sections", () => {
    const facts = resumeFacts({ basics: { name: "X" }, sections: {} });
    expect(facts).toMatchObject({
      email: null,
      phone: null,
      experience: [],
      education: [],
      summary: "",
      skills: [],
      links: { linkedin: null, github: null, website: null },
    });
  });
});
