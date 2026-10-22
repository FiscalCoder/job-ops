// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { labelKey, readGenericPage } from "../src/fill/generic-driver";
import { pagedFill } from "../src/track/job-match";

/** Any company's own application page, read generically. */

if (!globalThis.CSS?.escape)
  vi.stubGlobal("CSS", { escape: (s: string) => s.replace(/["\\#.:]/g, "\\$&") });

// jsdom has no layout: everything with a box counts as visible here.
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  get() {
    return (this as HTMLElement).hidden || (this as HTMLElement).style.display === "none"
      ? null
      : document.body;
  },
});

const FORM = `
<header><input type="search" placeholder="Search jobs"></header>
<h1>Apply for Senior Engineer</h1>
<form>
  <label for="fn">First name *</label><input id="fn" name="first_name" required>
  <label>Last name <input name="last_name" required></label>
  <input type="email" aria-label="Email address" name="email">
  <div class="field"><label>Phone</label><input type="tel" name="phone"></div>
  <input type="password" name="pw" aria-label="Create a password">
  <div class="field"><label>Resume/CV</label><button type="button">Upload</button><input type="file" name="cv" style="display:none"></div>
  <label for="country">Country</label>
  <select id="country"><option value="">Select…</option><option value="IN">India</option><option value="US">United States</option></select>
  <div class="field"><label id="loc">Current location</label><input role="combobox" aria-autocomplete="list" aria-labelledby="loc"></div>
  <div class="field"><label id="np">Notice period</label><div role="combobox" aria-labelledby="np" tabindex="0">Select…</div></div>
  <fieldset><legend>Years of experience *</legend>
    <label><input type="radio" name="years" value="a"> 0-2</label>
    <label><input type="radio" name="years" value="b"> 3-5</label>
    <label><input type="radio" name="years" value="c"> 5+</label>
  </fieldset>
  <label><input type="checkbox" name="privacy"> I agree to the privacy notice</label>
  <input type="hidden" name="csrf" value="x">
  <button type="submit">Submit application</button>
</form>`;

describe("readGenericPage", () => {
  it("each field once, by a selector that finds it again, with its label, kind and choices", () => {
    document.body.innerHTML = FORM;
    const page = readGenericPage();
    expect(page.system).toBe("generic");
    expect(page.step).toContain("Apply for Senior Engineer");
    expect(page.fields.map((f) => [f.label, f.kind, f.required])).toEqual([
      ["First name", "text", true],
      ["Last name", "text", true],
      ["Email address", "text", false],
      ["Phone", "text", false],
      ["Resume/CV", "file", false],
      ["Country", "dropdown", false],
      ["Current location", "search", false],
      ["Notice period", "dropdown", false],
      ["Years of experience", "radio", true],
      ["I agree to the privacy notice", "checkbox", false],
    ]);
    const byLabel = (label: string) => page.fields.find((f) => f.label === label);
    // The placeholder isn't a choice.
    expect(byLabel("Country")?.options).toEqual(["India", "United States"]);
    expect(byLabel("Years of experience")).toMatchObject({
      ref: 'input[name="years"]',
      options: ["0-2", "3-5", "5+"],
    });
    // Every ref finds its field again.
    for (const f of page.fields)
      expect(document.querySelector(f.ref), f.label).not.toBeNull();
    // Not the site's search box, a password or a hidden token.
    expect(page.fields.some((f) => /search|password|csrf/i.test(f.key))).toBe(false);
  });

  it("questions are keyed the same however they're punctuated", () => {
    expect(labelKey("Notice period *")).toBe("notice period");
    expect(labelKey("Notice  period:")).toBe("notice period");
  });
});

describe("pagedFill", () => {
  it("Workday's apply flow, any company page, never LinkedIn or the job boards", () => {
    expect(
      pagedFill("https://acme.wd1.myworkdayjobs.com/en-US/External/job/X_R1/apply/applyManually"),
    ).toBe("workday");
    expect(pagedFill("https://careers.acme.com/jobs/123/apply")).toBe("generic");
    expect(pagedFill("https://acme.wd1.myworkdayjobs.com/en-US/External/job/X_R1")).toBeNull();
    expect(pagedFill("https://www.linkedin.com/jobs/view/1")).toBeNull();
    expect(pagedFill("https://www.naukri.com/job-listings-x-1")).toBeNull();
    expect(pagedFill("http://careers.acme.com/apply")).toBeNull();
  });
});
