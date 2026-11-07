// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bestEquivalentOption, equivalentTerms } from "../src/fill/equivalents";
import { trimmedForm } from "../src/fill/form-snapshot";
import { bestFound, bestOption } from "../src/fill/options";

describe("the same answer worded another way", () => {
  it("finds a degree a list abbreviates (the misses that went to Claude's takeover)", () => {
    const short = ["GED", "HS", "AA", "BA", "BS", "MA", "MS", "PhD"];
    expect(short[bestOption(short, "Bachelor's Degree") ?? -1]).toBe("BS");
    expect(short[bestOption(short, "Master's Degree") ?? -1]).toBe("MS");
    expect(short[bestOption(short, "Doctorate") ?? -1]).toBe("PhD");
    const pg = ["Diploma", "Post-Graduate Diploma", "Bachelor's"];
    expect(pg[bestOption(pg, "PG Diploma") ?? -1]).toBe("Post-Graduate Diploma");
    const btech = ["High School", "Bachelor of Technology (B.Tech)", "Master of Technology"];
    expect(btech[bestOption(btech, "Bachelor's Degree") ?? -1]).toBe("Bachelor of Technology (B.Tech)");
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
    expect(equivalentTerms("bachelors")).toContain("B.Tech");
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
