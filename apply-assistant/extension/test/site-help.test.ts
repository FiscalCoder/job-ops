import { describe, expect, it } from "vitest";
import { recipeHost, showsValue } from "../src/fill/site-help";

describe("site help", () => {
  it("every Workday tenant shares one set of steps; other sites keep their own", () => {
    expect(recipeHost("https://acme.wd1.myworkdayjobs.com/en-US/External/job/x/apply")).toBe(
      "myworkdayjobs.com",
    );
    expect(recipeHost("https://wd3.myworkdaysite.com/recruiting/beta/jobs")).toBe(
      "myworkdaysite.com",
    );
    expect(recipeHost("https://careers.acme.com/apply?id=1")).toBe("careers.acme.com");
    expect(recipeHost("https://job-boards.greenhouse.io/acme/jobs/1")).toBe(
      "job-boards.greenhouse.io",
    );
  });

  it("a field shows the value as picked, or a number as formatted", () => {
    expect(showsValue("India +91", "India")).toBe(true);
    expect(showsValue("+91 98765 43210", "9876543210")).toBe(true);
    expect(showsValue("", "Email")).toBe(false);
    expect(showsValue("Phone", "Email")).toBe(false);
  });
});
