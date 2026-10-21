// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readWorkdayPage, workdayStep } from "../src/fill/workday-driver";
import { isWorkdayApply } from "../src/track/job-match";

/**
 * The Workday page reader on the recorded LPL Financial pages (2026-10-21; personal values
 * replaced by fakes): what the server is asked to plan on each page.
 */

if (!globalThis.CSS?.escape)
  vi.stubGlobal("CSS", { escape: (s: string) => s.replace(/["\\]/g, "\\$&") });

const load = (name: string) => {
  const html = readFileSync(
    path.join(process.cwd(), "test/fixtures/workday", `${name}.html`),
    "utf8",
  );
  document.documentElement.innerHTML = html
    .replace(/^<!doctype html>\s*/i, "")
    .replace(/^<html[^>]*>|<\/html>$/g, "");
};

describe("readWorkdayPage", () => {
  it("My Information: each field once, by its stable id, with its kind and required flag", () => {
    load("my-information");
    const page = readWorkdayPage();
    expect(page.step).toBe("My Information");
    expect(workdayStep()).toBe("My Information");
    const byKey = (key: string) => page.fields.find((f) => f.key === key);
    expect(byKey("legalName--firstName")).toMatchObject({
      ref: "name--legalName--firstName",
      kind: "text",
      label: "Given Name(s)",
      required: true,
    });
    expect(byKey("country")).toMatchObject({
      ref: "country--country",
      kind: "dropdown",
      required: true,
    });
    expect(byKey("source")).toMatchObject({
      kind: "search",
      label: "How Did You Hear About Us?",
    });
    expect(byKey("countryPhoneCode")?.kind).toBe("search");
    expect(byKey("candidateIsPreviousWorker")).toMatchObject({
      ref: "previousWorker--candidateIsPreviousWorker",
      kind: "radio",
      options: ["Yes", "No"],
      required: true,
    });
    expect(byKey("preferredCheck")?.kind).toBe("checkbox");
    expect(new Set(page.fields.map((f) => f.ref)).size).toBe(
      page.fields.length,
    );
    // Workday's header menus aren't form fields.
    expect(page.fields.some((f) => /utility/i.test(f.ref))).toBe(false);
  });

  it("Application Questions: every question is a field with its question as the label", () => {
    load("application-questions");
    const page = readWorkdayPage();
    expect(page.step).toBe("Application Questions");
    const dropdowns = page.fields.filter((f) => f.kind === "dropdown");
    expect(dropdowns.length).toBeGreaterThanOrEqual(10);
    expect(
      page.fields.find((f) => f.label === "Are you 18 or older?"),
    ).toMatchObject({ kind: "dropdown", required: true });
    expect(
      page.fields.find((f) => f.label === "What is your current fixed salary?"),
    ).toMatchObject({ kind: "textarea", required: true });
    for (const f of page.fields) expect(f.ref).toMatch(/^primaryQuestionnaire--/);
  });

  it("My Experience: work history and dates as such (the server leaves them to Workday)", () => {
    load("my-experience");
    const page = readWorkdayPage();
    expect(
      page.fields.filter((f) => f.ref.startsWith("workExperience-")).length,
    ).toBeGreaterThan(8);
    expect(page.fields.some((f) => f.kind === "date")).toBe(true);
    // The resume was already uploaded on the first page: nothing to attach here.
    expect(page.fields.some((f) => f.ref === "file-upload-input-ref")).toBe(
      false,
    );
  });

  it("Voluntary Disclosures: gender and the terms checkbox", () => {
    load("voluntary-disclosures");
    const page = readWorkdayPage();
    expect(page.fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["gender", "dropdown", false],
      ["acceptTermsAndAgreements", "checkbox", true],
    ]);
    expect(page.fields[1]?.options).toEqual([
      "Yes, I have read and consent to the terms and conditions",
    ]);
  });

  it("Review: nothing to fill", () => {
    load("review");
    expect(readWorkdayPage()).toMatchObject({ step: "Review", fields: [] });
  });
});

describe("isWorkdayApply", () => {
  it("is true only on Workday's apply flow", () => {
    expect(
      isWorkdayApply(
        "https://lplfinancial.wd1.myworkdayjobs.com/en-US/External/job/Bangalore/Engineer_R1/apply/applyManually",
      ),
    ).toBe(true);
    expect(
      isWorkdayApply("https://wd5.myworkdaysite.com/recruiting/acme/x/job/1/apply"),
    ).toBe(true);
    expect(
      isWorkdayApply(
        "https://lplfinancial.wd1.myworkdayjobs.com/en-US/External/job/Bangalore/Engineer_R1",
      ),
    ).toBe(false);
    expect(isWorkdayApply("https://example.com/apply")).toBe(false);
  });
});

describe("Workday application pages belong to their job page", () => {
  it("matches the job saved with its Workday listing address", async () => {
    const { jobForAddress } = await import("../src/track/job-match");
    const item = {
      jobId: "j1",
      title: "Engineer",
      employer: "LPL",
      score: 80,
      jobUrl:
        "https://lplfinancial.wd1.myworkdayjobs.com/en-US/External/job/Bangalore/Engineer_R1",
      target: { status: "none" },
      plan: null,
    };
    expect(
      jobForAddress(
        "https://lplfinancial.wd1.myworkdayjobs.com/en-US/External/job/Bangalore/Engineer_R1/apply/applyManually",
        [item],
      ),
    ).toMatchObject({ how: "listing", item: { jobId: "j1" } });
    expect(
      jobForAddress(
        "https://lplfinancial.wd1.myworkdayjobs.com/en-US/External/job/Bangalore/Other_R2/apply",
        [item],
      ),
    ).toBeNull();
  });
});
