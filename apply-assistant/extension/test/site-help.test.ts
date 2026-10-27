import { describe, expect, it } from "vitest";
import { keptNumber, sameNumber } from "../src/fill/options";
import { recipeHost, showsValue } from "../src/fill/site-help";

describe("site help", () => {
  it("every Workday tenant shares one set of steps; other sites keep their own", () => {
    expect(
      recipeHost(
        "https://acme.wd1.myworkdayjobs.com/en-US/External/job/x/apply",
      ),
    ).toBe("myworkdayjobs.com");
    expect(
      recipeHost("https://wd3.myworkdaysite.com/recruiting/beta/jobs"),
    ).toBe("myworkdaysite.com");
    expect(recipeHost("https://careers.acme.com/apply?id=1")).toBe(
      "careers.acme.com",
    );
    expect(recipeHost("https://job-boards.greenhouse.io/acme/jobs/1")).toBe(
      "job-boards.greenhouse.io",
    );
  });

  it("a field shows the value as picked, or a number as formatted", () => {
    expect(showsValue("India +91", "India")).toBe(true);
    expect(showsValue("+91 98765 43210", "9876543210")).toBe(true);
    expect(showsValue("", "Email")).toBe(false);
    expect(showsValue("Phone", "Email")).toBe(false);
    // A retyped number appended to the old one is not the number (Workday salary, J&J).
    expect(showsValue("4000004000000", "4000000 INR per year")).toBe(false);
  });
});

describe("numbers in fields", () => {
  it("sameNumber allows a country code in front, not a second number", () => {
    expect(sameNumber("+91 79048 95653", "7904895653")).toBe(true);
    expect(sameNumber("4000004000000", "4000000")).toBe(false);
    expect(sameNumber("", "")).toBe(false);
  });

  it("keptNumber: a numbers-only field kept just the answer's number", () => {
    expect(keptNumber("4000000", "4000000 INR per year")).toBe(true);
    expect(keptNumber("4,000,000", "4000000 INR per year")).toBe(true);
    expect(keptNumber("400000", "4000000 INR per year")).toBe(false);
    expect(keptNumber("4000000 INR", "4000000 INR per year")).toBe(false);
    expect(keptNumber("", "Notice")).toBe(false);
  });
});
