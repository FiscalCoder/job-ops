import { describe, expect, it } from "vitest";
import { type BoardJob, matchOnBoard } from "../src/resolver/match.js";

const jd =
  "We are looking for a senior backend engineer to design and build scalable services in Go and Kubernetes. " +
  "You will own APIs, mentor engineers, and work closely with product to ship reliable features.";

const board: BoardJob[] = [
  {
    id: "1",
    title: "Senior Backend Engineer",
    location: "Bengaluru, India",
    url: "https://gh/1",
  },
  {
    id: "2",
    title: "Senior Backend Engineer",
    location: "Austin, TX",
    url: "https://gh/2",
  },
  {
    id: "3",
    title: "Account Executive",
    location: "Remote",
    url: "https://gh/3",
  },
];

describe("matchOnBoard", () => {
  it("asks for details of title candidates when no descriptions were provided", () => {
    const result = matchOnBoard(
      {
        title: "Senior Backend Engineer",
        location: "Bengaluru",
        description: jd,
      },
      board,
      {},
    );
    expect(result).toEqual({ status: "need-details", ghJobIds: ["1", "2"] });
  });

  it("matches on description and prefers the location that fits", () => {
    const details = { "1": jd, "2": jd };
    const result = matchOnBoard(
      {
        title: "Senior Backend Engineer",
        location: "Bengaluru, Karnataka",
        description: jd,
      },
      board,
      details,
    );
    expect(result).toMatchObject({
      status: "matched",
      job: { id: "1" },
      titleScore: 1,
    });
    expect(result.status === "matched" && result.descScore).toBeGreaterThan(
      0.55,
    );
  });

  it("returns possible when the title matches but the description only partly overlaps", () => {
    const partly =
      "We are looking for a senior backend engineer to design and build scalable services in Go and Kubernetes. " +
      "This role also covers on-call rotations for our legacy billing platform, vendor management, " +
      "quarterly roadmap planning with finance, and running the internal developer survey programme.";
    const result = matchOnBoard(
      { title: "Senior Backend Engineer", location: "", description: jd },
      [board[0] as BoardJob],
      { "1": partly },
    );
    expect(result.status).toBe("possible");
  });

  it("lets the title decide between near-identical descriptions (Senior vs Staff postings)", () => {
    const seniorVsStaff: BoardJob[] = [
      {
        id: "staff",
        title: "Staff Software Engineer - Java, Springboot",
        location: "Bengaluru",
        url: "https://gh/staff",
      },
      {
        id: "senior",
        title: "Senior Software Engineer - Java, Springboot",
        location: "Bengaluru",
        url: "https://gh/senior",
      },
    ];
    // Real case (Celonis): the Staff posting contains the whole Job Ops description (1.0),
    // the Senior posting reworded one sentence (~0.8). Both are clearly "the same team's job".
    const staffText = `${jd} Staff engineers also set technical direction across teams.`;
    const seniorText = jd.replace(
      "mentor engineers, and work closely with product",
      "pair with peers and partner with product managers",
    );
    const result = matchOnBoard(
      {
        title: "Senior Software Engineer - Java, Springboot",
        location: "Bengaluru",
        description: jd,
      },
      seniorVsStaff,
      { staff: staffText, senior: seniorText },
    );
    expect(result).toMatchObject({ status: "matched", job: { id: "senior" } });
  });

  it("returns none for an identical generic title when the description is a different job", () => {
    const otherJob =
      "Join our observability platform team to build agent telemetry pipelines in Java, " +
      "improve ingestion throughput, and partner with SRE on capacity planning for petabyte-scale data.";
    const result = matchOnBoard(
      { title: "Senior Backend Engineer", location: "", description: jd },
      [board[0] as BoardJob],
      { "1": otherJob },
    );
    expect(result).toEqual({ status: "none", reason: "descriptions differ" });
  });

  it("never auto-matches a different seniority level, even with the same description", () => {
    // Real case (Celonis): the Senior posting closed; only the Staff one is still open.
    const onlyStaff: BoardJob[] = [
      {
        id: "staff",
        title: "Staff Software Engineer - Java, Springboot",
        location: "Bengaluru",
        url: "https://gh/staff",
      },
    ];
    const result = matchOnBoard(
      {
        title: "Senior Software Engineer - Java, Springboot",
        location: "Bengaluru",
        description: jd,
      },
      onlyStaff,
      { staff: `${jd} Staff engineers also set technical direction.` },
    );
    expect(result).toMatchObject({ status: "possible", job: { id: "staff" } });
  });

  it("treats numeric and roman levels as the same level", () => {
    const result = matchOnBoard(
      { title: "Software Engineer 2", location: "", description: jd },
      [
        {
          id: "x",
          title: "Software Engineer II",
          location: "",
          url: "https://gh/x",
        },
      ],
      { x: jd },
    );
    expect(result).toMatchObject({ status: "matched", job: { id: "x" } });
  });

  it("returns none when no title is close enough", () => {
    const result = matchOnBoard(
      { title: "Data Scientist", location: "", description: jd },
      board,
      {},
    );
    expect(result).toEqual({
      status: "none",
      reason: "no title match on board",
    });
  });

  it("falls back to possible (never matched) when Job Ops has no description to compare", () => {
    const result = matchOnBoard(
      {
        title: "Senior Backend Engineer",
        location: "Bengaluru",
        description: "",
      },
      [board[0] as BoardJob],
      { "1": jd },
    );
    expect(result).toMatchObject({ status: "possible", job: { id: "1" } });
  });
});
