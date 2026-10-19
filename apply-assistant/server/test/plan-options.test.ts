import { describe, expect, it } from "vitest";
import { countryOf, currencyOf } from "../src/plan/country.js";
import {
  findDeclineOption,
  pickOption,
  pickOptions,
} from "../src/plan/options.js";

const opts = (...labels: string[]) =>
  labels.map((label, i) => ({ label, value: String(i + 1) }));

describe("pickOption", () => {
  it("prefers exact, then starts-with, then whole word, then contains", () => {
    const options = opts("Yes, with sponsorship", "No", "Yes");
    expect(pickOption(options, "yes")?.label).toBe("Yes");
    expect(
      pickOption(
        opts("Indiana", "India", "British Indian Ocean Territory"),
        "India",
      )?.label,
    ).toBe("India");
    expect(
      pickOption(opts("United Kingdom", "Kingdom of Spain"), "united")?.label,
    ).toBe("United Kingdom");
    expect(
      pickOption(opts("Referral", "Job board - LinkedIn"), "LinkedIn")?.label,
    ).toBe("Job board - LinkedIn");
  });

  it("falls back to fuzzy matching for small spelling differences", () => {
    expect(pickOption(opts("Bengaluru", "Mumbai"), "Bengaluru ")?.label).toBe(
      "Bengaluru",
    );
    expect(pickOption(opts("Karnataka", "Kerala"), "Karnatka")?.label).toBe(
      "Karnataka",
    );
  });

  it("returns null when nothing is close", () => {
    expect(pickOption(opts("Germany", "France"), "India")).toBeNull();
    expect(pickOption([], "anything")).toBeNull();
    expect(pickOption(opts("Yes"), "")).toBeNull();
  });
});

describe("pickOptions (multi-select)", () => {
  it("matches each wanted value and reports the ones it could not place", () => {
    const result = pickOptions(opts("English", "Hindi", "German"), [
      "english",
      "Hindi",
      "Klingon",
    ]);
    expect(result.picked.map((o) => o.label)).toEqual(["English", "Hindi"]);
    expect(result.missing).toEqual(["Klingon"]);
  });
});

describe("findDeclineOption", () => {
  it.each([
    "I don't wish to answer",
    "Decline To Self Identify",
    "I prefer not to answer",
    "Prefer not to say",
    "I do not want to answer",
  ])("finds %s", (label) => {
    expect(findDeclineOption(opts("Male", "Female", label))?.label).toBe(label);
  });

  it("returns null when there is no decline choice", () => {
    expect(findDeclineOption(opts("Yes", "No"))).toBeNull();
  });
});

describe("countryOf", () => {
  it.each([
    ["Bangalore, India", "India"],
    ["Bengaluru", "India"],
    ["Remote - Germany", "Germany"],
    ["London, UK", "United Kingdom"],
    ["Amsterdam", "Netherlands"],
    ["Dublin, Ireland; Remote", "Ireland"],
    ["Singapore", "Singapore"],
    ["Tokyo, Japan", "Japan"],
    ["New York, NY, United States", "United States"],
    ["San Francisco, CA, USA", "United States"],
  ])("%s → %s", (location, country) => {
    expect(countryOf(location)).toBe(country);
  });

  it("returns null when no single country is named", () => {
    expect(countryOf("Remote")).toBeNull();
    expect(countryOf("")).toBeNull();
    expect(countryOf("Berlin or London")).toBeNull();
  });
});

describe("currencyOf", () => {
  it.each([
    ["India", "INR"],
    ["Germany", "EUR"],
    ["Dublin, Ireland", "EUR"],
    ["United Kingdom", "GBP"],
    ["Singapore", "SGD"],
    ["Atlantis", null],
    [null, null],
  ])("%s → %s", (country, currency) => {
    expect(currencyOf(country)).toBe(currency);
  });
});
