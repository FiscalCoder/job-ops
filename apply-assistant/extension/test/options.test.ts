import { describe, expect, it } from "vitest";
import { bestFound, sameWords } from "../src/fill/options";

describe("sameWords", () => {
  it("the same words in any order, plurals and small words aside", () => {
    expect(
      sameWords("Management Information Systems", "Information System Management"),
    ).toBe(true);
    expect(sameWords("Science, Computer", "Computer Science")).toBe(true);
    expect(sameWords("Bachelor of Science", "Bachelors Science")).toBe(true);
  });

  it("a word more or less is a different thing", () => {
    expect(
      sameWords(
        "Artificial Intelligence and Robotics",
        "Artificial Intelligence and Machine Learning",
      ),
    ).toBe(false);
    expect(sameWords("Computer Science", "Computer Science Engineering")).toBe(false);
    expect(sameWords("", "Computer Science")).toBe(false);
  });
});

describe("bestFound", () => {
  const found = [
    "Machine Learning",
    "Artificial Intelligence and Robotics",
    "Management Information Systems",
    "Computer Science",
  ];

  it("your answer as the list words it, else the same words in another order", () => {
    expect(bestFound(found, "Computer Science")).toBe("Computer Science");
    expect(bestFound(found, "Information System Management")).toBe(
      "Management Information Systems",
    );
  });

  it("nothing that is your answer: none (Claude picks then)", () => {
    expect(bestFound(found, "Artificial Intelligence and Machine Learning")).toBeNull();
    expect(bestFound([], "Computer Science")).toBeNull();
  });
});
