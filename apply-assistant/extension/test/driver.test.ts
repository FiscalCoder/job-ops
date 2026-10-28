import { describe, expect, it } from "vitest";
import { ashbyFormUrl } from "../src/fill/ashby-driver";
import {
  bestOption,
  ethnicityAnswer,
  rankOption,
  selectionMatches,
  selectorFor,
} from "../src/fill/driver";
import { leverFormUrl } from "../src/fill/lever-driver";

describe("driver helpers", () => {
  it("maps plan refs to Greenhouse DOM ids", () => {
    expect(selectorFor("first_name")).toBe(
      '[id="first_name"], fieldset[id="first_name[]"]',
    );
    expect(selectorFor("location")).toBe("#candidate-location");
    expect(selectorFor('bad"ref')).toBe(
      '[id="badref"], fieldset[id="badref[]"]',
    );
  });

  it("ranks options like the M0 spike: exact > starts-with > word > contains", () => {
    expect(rankOption("India", "india")).toBe(0);
    expect(rankOption("India +91", "India")).toBe(1);
    expect(rankOption("Republic of India", "India")).toBe(2);
    expect(rankOption("Indiana", "Indi")).toBe(1);
    // Another word after your answer is another place; punctuation after it, the place itself.
    expect(rankOption("Bengaluru Rural", "Bengaluru")).toBe(1.5);
    expect(
      bestOption(["Bengaluru Rural", "Bengaluru, Karnataka"], "Bengaluru"),
    ).toBe(1);
    expect(rankOption("Germany", "India")).toBe(9);
  });

  it("picks India +91 over British Indian Ocean Territory", () => {
    expect(
      bestOption(["British Indian Ocean Territory +246", "India +91"], "India"),
    ).toBe(1);
    expect(bestOption(["Yes", "No"], "No")).toBe(1);
    expect(bestOption(["Yes", "No"], "Maybe")).toBeNull();
  });

  it("accepts a dropdown that shows only part of the chosen option", () => {
    expect(selectionMatches("+91", "India +91")).toBe(true);
    expect(selectionMatches("India", "India")).toBe(true);
    expect(selectionMatches("+246", "India +91")).toBe(false);
    expect(selectionMatches("", "India")).toBe(false);
  });

  it("never takes Female for Male, nor typed-over text for the pick (Oracle)", () => {
    expect(rankOption("Female", "Male")).toBe(9);
    expect(bestOption(["Female", "Male"], "Male")).toBe(1);
    expect(bestOption(["Female"], "Male")).toBeNull();
    expect(selectionMatches("Female", "Male")).toBe(false);
    expect(selectionMatches("+9+91", "+91")).toBe(false);
    expect(selectionMatches("DR.Mr.", "Mr.")).toBe(false);
    expect(selectionMatches("MR.", "Mr.")).toBe(true);
    expect(selectionMatches("+91", "India (+91)")).toBe(true);
  });
});

describe("ethnicityAnswer (Greenhouse shows Race only after Hispanic/Latino: No)", () => {
  it("derives the Hispanic/Latino answer from the saved race answer", () => {
    expect(ethnicityAnswer("Asian")).toBe("No");
    expect(ethnicityAnswer("Two or More Races")).toBe("No");
    expect(ethnicityAnswer("Hispanic or Latino")).toBe("Yes");
    expect(ethnicityAnswer("Decline To Self Identify")).toBe("Decline");
    expect(ethnicityAnswer("I don't wish to answer")).toBe("Decline");
  });
});

describe("ashbyFormUrl", () => {
  it("opens the posting's application tab", () => {
    expect(
      ashbyFormUrl("https://jobs.ashbyhq.com/elevenlabs/c7d5?utm_source=x"),
    ).toBe("https://jobs.ashbyhq.com/elevenlabs/c7d5/application?utm_source=x");
    expect(
      ashbyFormUrl("https://jobs.ashbyhq.com/elevenlabs/c7d5/application"),
    ).toBe("https://jobs.ashbyhq.com/elevenlabs/c7d5/application");
  });
});

describe("leverFormUrl", () => {
  it("opens the posting's apply page", () => {
    expect(
      leverFormUrl("https://jobs.lever.co/valiantys/38ee?lever-source=x"),
    ).toBe("https://jobs.lever.co/valiantys/38ee/apply?lever-source=x");
    expect(leverFormUrl("https://jobs.lever.co/valiantys/38ee/apply")).toBe(
      "https://jobs.lever.co/valiantys/38ee/apply",
    );
  });
});
