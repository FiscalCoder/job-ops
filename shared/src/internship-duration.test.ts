import { describe, expect, it } from "vitest";
import {
  durationFits,
  findDurationInText,
  formatDuration,
  parseDurationField,
  parseDurationSetting,
} from "./internship-duration";

describe("parseDurationField", () => {
  it.each([
    ["3 Months", 3, 3],
    ["1 Month", 1, 1],
    ["2-3 months", 2, 3],
    ["6 Weeks", 6 / 4.345, 6 / 4.345],
  ])("reads %s", (value, min, max) => {
    const range = parseDurationField(value);
    expect(range?.minMonths).toBeCloseTo(min);
    expect(range?.maxMonths).toBeCloseTo(max);
  });

  it.each([
    "",
    "Today",
    "Few hours ago",
    "₹ 7,000 /month",
    "Mumbai",
  ])("ignores %s", (value) => {
    expect(parseDurationField(value)).toBeNull();
  });
});

describe("findDurationInText", () => {
  it.each([
    ["Internship duration: 2 months. This is a paid internship", 2],
    ["Duration: 6 Month Internship with PPO", 6],
    ["based in Bangalore, with a duration of 6 months and a stipend", 6],
    ["<li>are available for duration of 3 months</li>", 3],
    ["Digital Marketing Intern (3 months - unpaid)", 3],
    ["Marketing Internship - 6 Months", 6],
    ["Marketing Manager (6 months notice)", null],
    ["This is a 3-month internship in Mumbai", 3],
    ["We offer a 3 month internship in Mumbai", 3],
    ["Summer internship for 8 weeks", 8 / 4.345],
  ])("reads the length from %s", (text, months) => {
    const range = findDurationInText(text);
    if (months === null) {
      expect(range).toBeNull();
    } else {
      expect(range?.maxMonths).toBeCloseTo(months);
    }
  });

  it("does not read experience or PPO timelines as the length", () => {
    expect(
      findDurationInText(
        "Need 6 months of experience in SEO. PPO after 12 months.",
      ),
    ).toBeNull();
  });
});

describe("parseDurationSetting", () => {
  it.each([
    ["2-3", 2, 3],
    ["2 - 3", 2, 3],
    ["2 to 3", 2, 3],
    ["3", 3, 3],
    ["2-", 2, 36],
    ["-3", 0, 3],
  ])("parses %s", (value, min, max) => {
    expect(parseDurationSetting(value)).toEqual({
      minMonths: min,
      maxMonths: max,
    });
  });

  it.each([undefined, "", "abc", "3-2"])("treats %s as any length", (value) => {
    expect(parseDurationSetting(value)).toBeNull();
  });
});

describe("durationFits", () => {
  const twoToThree = { minMonths: 2, maxMonths: 3 };

  it("keeps lengths inside or overlapping the range", () => {
    expect(durationFits({ minMonths: 3, maxMonths: 3 }, twoToThree)).toBe(true);
    expect(durationFits({ minMonths: 2, maxMonths: 2 }, twoToThree)).toBe(true);
    expect(durationFits({ minMonths: 1, maxMonths: 2 }, twoToThree)).toBe(true);
    expect(
      durationFits({ minMonths: 8 / 4.345, maxMonths: 8 / 4.345 }, twoToThree),
    ).toBe(true);
  });

  it("skips lengths outside the range", () => {
    expect(durationFits({ minMonths: 6, maxMonths: 6 }, twoToThree)).toBe(
      false,
    );
    expect(durationFits({ minMonths: 1, maxMonths: 1 }, twoToThree)).toBe(
      false,
    );
    expect(
      durationFits({ minMonths: 6 / 4.345, maxMonths: 6 / 4.345 }, twoToThree),
    ).toBe(false);
  });

  it("keeps postings when either side is unknown", () => {
    expect(durationFits(null, twoToThree)).toBe(true);
    expect(durationFits({ minMonths: 6, maxMonths: 6 }, null)).toBe(true);
  });
});

describe("formatDuration", () => {
  it("labels months and short internships", () => {
    expect(formatDuration({ minMonths: 3, maxMonths: 3 })).toBe("3 months");
    expect(formatDuration({ minMonths: 1, maxMonths: 1 })).toBe("4 weeks");
    expect(formatDuration({ minMonths: 2, maxMonths: 3 })).toBe("2-3 months");
    expect(formatDuration({ minMonths: 6 / 4.345, maxMonths: 6 / 4.345 })).toBe(
      "6 weeks",
    );
  });
});
