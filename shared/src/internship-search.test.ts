import { describe, expect, it } from "vitest";
import {
  isInternshipTitle,
  toInternshipKeyword,
  toInternshipKeywords,
} from "./internship-search";

describe("toInternshipKeyword", () => {
  it.each([
    ["Marketing Intern", "Marketing"],
    ["Marketing Internship", "Marketing"],
    ["Summer Intern Marketing", "Marketing"],
    ["B2B Marketing Intern", "B2B Marketing"],
    ["Intern", ""],
    ["Go-to-market (GTM) intern", "Go-to-market GTM"],
  ])("turns %s into %s", (term, keyword) => {
    expect(toInternshipKeyword(term)).toBe(keyword);
  });
});

describe("toInternshipKeywords", () => {
  it("drops blanks and repeats while keeping order", () => {
    expect(
      toInternshipKeywords([
        "Marketing Intern",
        "Product Marketing Intern",
        "Marketing Internship",
        "MBA Marketing Intern",
        "Summer Intern Marketing",
        "Intern",
        "Digital Marketing Intern",
      ]),
    ).toEqual([
      "Marketing",
      "Product Marketing",
      "MBA Marketing",
      "Digital Marketing",
    ]);
  });
});

describe("isInternshipTitle", () => {
  it.each([
    ["Marketing Intern", true],
    ["Social Media Marketing Internship", true],
    ["Influencer Marketing | Intern", true],
    ["Internal Communications Manager", false],
    ["International Growth Marketing Manager", false],
    [undefined, false],
  ])("%s → %s", (title, expected) => {
    expect(isInternshipTitle(title)).toBe(expected);
  });
});
