// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bestEquivalentOption, equivalentTerms } from "../src/fill/equivalents";
import { trimmedForm } from "../src/fill/form-snapshot";
import { bestFound, bestOption, bestOptionAmong } from "../src/fill/options";

describe("the same answer worded another way", () => {
  it("finds a degree a list abbreviates (the misses that went to Claude's takeover)", () => {
    const short = ["GED", "HS", "AA", "BA", "BS", "MA", "MS", "PhD"];
    // The level alone never guesses a subject: your resume's degree decides it.
    expect(bestOption(short, "Bachelor's Degree")).toBeNull();
    expect(short[bestOptionAmong(short, ["Bachelor's Degree", "B.Tech", "Bachelors"]) ?? -1]).toBe("BS");
    expect(short[bestOptionAmong(short, ["Master's Degree", "M.Tech", "Masters"]) ?? -1]).toBe("MS");
    expect(short[bestOption(short, "Doctorate") ?? -1]).toBe("PhD");
    const pg = ["Diploma", "Post-Graduate Diploma", "Bachelor's"];
    expect(pg[bestOption(pg, "PG Diploma") ?? -1]).toBe("Post-Graduate Diploma");
    const btech = ["High School", "Bachelor of Technology (B.Tech)", "Master of Technology"];
    expect(btech[bestOptionAmong(btech, ["Bachelor's Degree", "B.Tech"]) ?? -1]).toBe(
      "Bachelor of Technology (B.Tech)",
    );
  });

  it("matches a marketing or business graduate's own degree, not an engineer's", () => {
    const short = ["BA", "BS", "BCom", "BBA", "MBA", "MS"];
    expect(short[bestOptionAmong(short, ["Bachelor's Degree", "B.Com", "Bachelors"]) ?? -1]).toBe("BCom");
    expect(short[bestOptionAmong(short, ["Bachelor's Degree", "Bachelor of Business Administration"]) ?? -1]).toBe("BBA");
    expect(short[bestOptionAmong(short, ["Bachelor's Degree", "Bachelor of Arts"]) ?? -1]).toBe("BA");
    expect(short[bestOptionAmong(short, ["Master's Degree", "PGDM"]) ?? -1]).toBe("MBA");
    expect(short[bestOptionAmong(short, ["Bachelor's Degree", "BSc"]) ?? -1]).toBe("BS");
    // A list without your degree in any wording we know: nothing here (Claude picks next).
    expect(bestOptionAmong(["BA", "BS"], ["Bachelor's Degree", "BBA"])).toBeNull();
    // A list that has the level itself keeps it.
    expect(bestOptionAmong(["Bachelor's Degree", "BS", "BCom"], ["Bachelor's Degree", "B.Com"])).toBe(0);
    expect(bestOptionAmong(["Bachelors", "Masters"], ["Bachelor's Degree", "B.Com"])).toBe(0);
  });

  it("finds an Indian state or a source as a list words it", () => {
    const states = ["KA", "TN", "TS", "MH"];
    expect(states[bestOption(states, "Tamil Nadu") ?? -1]).toBe("TN");
    const sources = ["Referral", "Job Board", "Company Website", "Other"];
    expect(sources[bestOption(sources, "LinkedIn") ?? -1]).toBe("Job Board");
    expect(bestFound(["Linked In", "Indeed"], "LinkedIn")).toBe("Linked In");
  });

  it("changes nothing a list already words your way, and never matches a short form inside a word", () => {
    expect(bestOption(["Bachelor's Degree", "BS"], "Bachelor's Degree")).toBe(0);
    expect(bestOption(["Female", "Male"], "Male")).toBe(1);
    expect(bestEquivalentOption(["BS in Physics, Other", "Associate"], "Bachelor's Degree")).toBeNull();
    expect(bestEquivalentOption(["TNT Express"], "Tamil Nadu")).toBeNull();
    expect(equivalentTerms("Something else entirely")).toEqual([]);
    expect(equivalentTerms("bachelors")).toContain("Bachelor's Degree");
    expect(equivalentTerms("bachelors")).not.toContain("BS");
    // A wording in two groups belongs to its own: BSc is a science degree, not engineering.
    expect(equivalentTerms("Bachelor of Science")[0]).toBe("BS");
    expect(equivalentTerms("BE")[0]).toBe("B.E.");
  });
});

describe("the closer read's HTML", () => {
  it("drops noise but keeps every field and what tells it apart", () => {
    const longText = "We build things. ".repeat(80);
    const countries = Array.from({ length: 60 }, (_, i) => `<option value="c${i}">Country ${i}</option>`).join("");
    document.body.innerHTML = `
      <form id="f">
        <div><div><div><p>${longText}</p></div></div></div>
        <label for="deg" class="css-1x2y3z label-text field_label">Degree</label>
        <div><div><select id="deg" name="degree" class="sc-AbC123 select-input"><option>BS</option><option>MS</option></select></div></div>
        <select id="country" name="country">${countries}</select>
        <div role="group" aria-labelledby="g1"><span id="g1">Notice period</span><input id="np" name="notice" value="typed by you"></div>
      </form>`;
    const html = trimmedForm(["#deg", "#country", "#np"], 60_000);
    expect(html).toContain('data-aa-field="0"');
    expect(html).toContain('data-aa-field="1"');
    expect(html).toContain('data-aa-field="2"');
    expect(html).toContain("Degree");
    expect(html).toContain("Notice period");
    expect(html).toContain('aria-labelledby="g1"');
    expect(html).not.toContain("typed by you");
    // Long text cut, a long list keeps its first 20 choices, hashed class names gone.
    expect(html.match(/We build things\./g)?.length ?? 0).toBeLessThan(30);
    expect(html).toContain("Country 19");
    expect(html).not.toContain("Country 20<");
    expect(html).toContain("40 more choices");
    expect(html).toContain('class="label-text field_label"'.replace(" field_label", ""));
    expect(html).not.toContain("css-1x2y3z");
    expect(html).not.toContain("sc-AbC123");
    // Bare wrappers around one element are gone.
    expect(html).not.toContain("<div><div>");
  });
});
