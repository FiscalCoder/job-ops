// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  focusSearchBox,
  PLACEHOLDER,
  readGenericPage,
  shownValue,
} from "../src/fill/generic-driver";
import { labelKey } from "../src/fill/site-help";
import { isSupportedPosting, pagedFill } from "../src/track/job-match";

/** Any company's own application page, read generically. */

// As the browser's: other characters escaped, and a leading digit as a code point (iCIMS ids).
vi.stubGlobal("CSS", {
  escape: (s: string) =>
    s
      .replace(/[^\w-]/g, "\\$&")
      .replace(/^(-?)(\d)/, (_, dash: string, d: string) => `${dash}\\3${d} `),
});

// jsdom has no layout: everything with a box counts as visible here.
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  get() {
    return (this as HTMLElement).hidden ||
      (this as HTMLElement).style.display === "none"
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
    const byLabel = (label: string) =>
      page.fields.find((f) => f.label === label);
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
    expect(page.fields.some((f) => /search|password|csrf/i.test(f.key))).toBe(
      false,
    );
  });

  it("questions are keyed the same however they're punctuated", () => {
    expect(labelKey("Notice period *")).toBe("notice period");
    expect(labelKey("Notice  period:")).toBe("notice period");
  });
});

// react-select as Greenhouse renders it, after "India +91" was picked (Fanatics run).
const REACT_SELECT = `
<form>
  <label id="country-label" for="country">Country</label>
  <div class="select__container"><div class="select__control">
    <div class="select__value-container select__value-container--has-value">
      <div class="select__single-value"><span>+91</span></div>
      <div class="select__input-container"><input class="select__input" id="country" role="combobox" aria-autocomplete="list" aria-labelledby="country-label" value=""></div>
    </div>
  </div><input required tabindex="-1" aria-hidden="true" class="requiredInput" value=""></div>
  <label for="phone">Phone</label><input id="phone" type="tel">
  <textarea id="g-recaptcha-response-100000" name="g-recaptcha-response"></textarea>
</form>`;

describe("react-select dropdowns", () => {
  it("one field each (not its hidden required stand-in), no captcha token", () => {
    document.body.innerHTML = REACT_SELECT;
    expect(readGenericPage().fields.map((f) => [f.label, f.kind])).toEqual([
      ["Country", "search"],
      ["Phone", "text"],
    ]);
  });

  it("the pick shows beside the input's own container", () => {
    document.body.innerHTML = REACT_SELECT;
    expect(shownValue("#country")).toBe("+91");
    // Never another field's value.
    expect(shownValue("#phone")).toBe("");
  });

  it("a typeahead's picks are its tokens, without their remove buttons (Virtusa)", () => {
    document.body.innerHTML = `<div class="rbt"><div class="rbt-input-multi"><div class="rbt-input-wrapper">
      <div class="rbt-token rbt-token-removeable">Remote<button class="rbt-token-remove-button" type="button"><span aria-hidden="true">×</span><span class="sr-only">Remove</span></button></div>
      <div class="rbt-token">Hybrid<button type="button">×</button></div>
      <div><input id="wm" aria-autocomplete="list"><input aria-hidden="true" class="rbt-input-hint" readonly></div></div></div></div>`;
    expect(shownValue("#wm")).toBe("Remote, Hybrid");
  });
});

/**
 * iCIMS (Atlassian): one fieldset per job, already filled from the uploaded resume; dropdowns are
 * a link standing in for a hidden select, with a search box that lists choices as you type.
 */
const ICIMS_JOB = (id: string, n: number, employer: string, state: string) => `
<fieldset class="iCIMS_CollectionGroup"><legend><span id="rcf3211_${id}_label">Professional Experience (${n})<span class="Field_Required"><span>* </span><span class="sr-only">required.</span></span></span></legend>
  <div data-collection="rcf3211" data-index="${n}"><label for="${id}_PersonProfileFields.rcf3212">Employer</label>
    <input type="text" id="${id}_PersonProfileFields.rcf3212" value="${employer}" aria-required="true"></div>
  <div data-collection="rcf3211" data-index="${n}"><label id="label_${id}_PersonProfileFields.rcf3217" for="${id}_PersonProfileFields.rcf3217">State</label>
    <select id="${id}_PersonProfileFields.rcf3217" hidden><option selected=""></option></select>
    <a id="${id}_PersonProfileFields.rcf3217_icimsDropdown" role="combobox" aria-labelledby="label_${id}_PersonProfileFields.rcf3217" tabindex="0"><span class="dropdown-text">${state}</span></a>
    <div id="${id}_PersonProfileFields.rcf3217_icimsDropdown_ctnr" class="dropdown-container">
      <input type="text" class="dropdown-search" placeholder="— Type to Search —" role="combobox" hidden>
      <ul role="listbox"></ul></div></div>
  <div data-collection="rcf3211" data-index="${n}"><label for="${id}_PersonProfileFields.rcf3214_Month">Start Date Month</label>
    <select id="${id}_PersonProfileFields.rcf3214_Month"><option value="0"></option><option value="01">Jan</option><option value="12" selected>Dec</option></select></div>
</fieldset>`;

describe("iCIMS work history", () => {
  it("each field knows its job's block and what it shows; prompts and blank choices aren't values", () => {
    document.body.innerHTML = `<form>${ICIMS_JOB("34393095", 2, "Hueint", "— Make a Selection —")}${ICIMS_JOB("-4", 3, "", "Karnataka")}</form>`;
    const fields = readGenericPage().fields;
    expect(
      fields.map((f) => [f.label, f.kind, f.block?.heading, f.value ?? ""]),
    ).toEqual([
      ["Employer", "text", "Professional Experience (2)", "Hueint"],
      ["State", "dropdown", "Professional Experience (2)", ""],
      ["Start Date Month", "dropdown", "Professional Experience (2)", "Dec"],
      ["Employer", "text", "Professional Experience (3)", ""],
      ["State", "dropdown", "Professional Experience (3)", "Karnataka"],
      ["Start Date Month", "dropdown", "Professional Experience (3)", "Dec"],
    ]);
    expect(new Set(fields.map((f) => f.block?.id)).size).toBe(2);
    expect(fields[2]?.options).toEqual(["Jan", "Dec"]);
    // The read-back of an untouched dropdown shows nothing picked, not its prompt.
    expect(shownValue(fields[1]?.ref ?? "")).toBe("");
    expect(shownValue(fields[4]?.ref ?? "")).toBe("Karnataka");
  });

  it("an opened dropdown's own search box is found and focused, never another field", () => {
    document.body.innerHTML = `<form>${ICIMS_JOB("34393095", 2, "Hueint", "")}</form>`;
    const search = document.querySelector<HTMLInputElement>(".dropdown-search");
    const ref = readGenericPage().fields[1]?.ref ?? "";
    // Closed: hidden, so nothing to type into.
    expect(focusSearchBox(ref)).toBe(false);
    // Opened (jsdom has no layout: a shown box gets a rect).
    search?.removeAttribute("hidden");
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
      this: HTMLElement,
    ) {
      return (this.hidden ? [] : [{}]) as unknown as DOMRectList;
    });
    expect(focusSearchBox(ref)).toBe(true);
    expect(document.activeElement).toBe(search);
    vi.restoreAllMocks();
  });
});

describe("dropdown prompts", () => {
  it("are never choices", () => {
    for (const prompt of ["— Make a Selection —", "Select…", "Please select", "-- Choose one --", "No states available"])
      expect(PLACEHOLDER.test(prompt), prompt).toBe(true);
    for (const choice of ["Tamil Nadu", "Selection Committee", "Other"])
      expect(PLACEHOLDER.test(choice), choice).toBe(false);
  });
});

/** Rippling: labels by id, a file input inside a "Drop or select" label, unlabelled questions. */
const RIPPLING = `<form>
  <div data-testid="field"><div><span id="field-56-label">Cover letter</span></div>
    <div><div id="file-input-58">Total 0 file selected</div>
      <label aria-labelledby="file-input-58 field-56-label">Drop or select (.doc / .docx / .pdf)<input type="file" title=""></label></div></div>
  <div data-testid="field"><div><span id="field-39-label">Location</span><span>*</span></div>
    <div><input id="field-39" aria-label="textbox" aria-labelledby="field-39-label" name="Qg8J2SVPIQz"></div></div>
  <div><div><p>What is your current salary package?</p></div>
    <div data-testid="field"><div><input id="field-88" name="PzLD6fU-UVZ"></div></div>
    <div><p>0/50</p></div></div>
  <div><div><p>Notice period in days</p></div>
    <div data-testid="field"><div><input id="field-92" name="QACqteXH3UV"></div></div>
    <div><p>0/50</p></div></div>
</form>`;

describe("fields without a proper label", () => {
  it("take the text they point to, or the question just above them (Rippling)", () => {
    document.body.innerHTML = RIPPLING;
    expect(readGenericPage().fields.map((f) => [f.label, f.kind])).toEqual([
      // jsdom has no layout, so the screen-reader text stays in.
      ["Total 0 file selected Cover letter", "file"],
      ["Location", "text"],
      ["What is your current salary package?", "text"],
      ["Notice period in days", "text"],
    ]);
  });
});

describe("Oracle's apply flow", () => {
  it("leaves its help chat's upload out, and new marks never reuse kept ones", () => {
    document.body.innerHTML = `<form>
      <label for="r">Upload Resume</label><input type="file" id="r">
      <input type="file" aria-label="Phone">
      <div class="oda-chat-wrapper"><input class="oda-chat-none" type="file" tabindex="-1" aria-hidden="true"></div>
    </form>`;
    const first = readGenericPage().fields;
    expect(first.map((f) => [f.label, f.ref])).toEqual([
      ["Upload Resume", "#r"],
      ["Phone", '[data-ac-ref="ac0"]'],
    ]);
    // The page draws the field again, without our mark; one kept elsewhere is ac0.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form><input type="file" aria-label="Other"></form>',
    );
    document.querySelector('[data-ac-ref="ac0"]')?.remove();
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<input type="file" aria-label="Kept" data-ac-ref="ac0">',
    );
    const again = readGenericPage().fields.map((f) => f.ref);
    expect(new Set(again).size).toBe(again.length);
  });
});

describe("isSupportedPosting", () => {
  it("Greenhouse, Ashby and Lever postings, not their boards or other sites", () => {
    expect(
      isSupportedPosting(
        "https://job-boards.greenhouse.io/fanaticscommerce/jobs/4405584009?gh_src=x",
      ),
    ).toBe(true);
    expect(isSupportedPosting("https://boards.greenhouse.io/acme/jobs/1")).toBe(
      true,
    );
    expect(
      isSupportedPosting(
        "https://jobs.ashbyhq.com/acme/0f6b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d/application",
      ),
    ).toBe(true);
    expect(
      isSupportedPosting(
        "https://jobs.lever.co/acme/0f6b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d/apply",
      ),
    ).toBe(true);
    expect(isSupportedPosting("https://job-boards.greenhouse.io/acme")).toBe(
      false,
    );
    expect(isSupportedPosting("https://careers.acme.com/jobs/123")).toBe(false);
  });
});

describe("pagedFill", () => {
  it("Workday's apply flow, any company page, never LinkedIn or the job boards", () => {
    expect(
      pagedFill(
        "https://acme.wd1.myworkdayjobs.com/en-US/External/job/X_R1/apply/applyManually",
      ),
    ).toBe("workday");
    expect(pagedFill("https://careers.acme.com/jobs/123/apply")).toBe(
      "generic",
    );
    expect(
      pagedFill("https://acme.wd1.myworkdayjobs.com/en-US/External/job/X_R1"),
    ).toBeNull();
    expect(pagedFill("https://www.linkedin.com/jobs/view/1")).toBeNull();
    expect(pagedFill("https://www.naukri.com/job-listings-x-1")).toBeNull();
    expect(pagedFill("http://careers.acme.com/apply")).toBeNull();
  });
});
