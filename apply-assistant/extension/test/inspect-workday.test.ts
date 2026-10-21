// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { watchForm } from "../src/track/inspect";

/**
 * The recorder on real Workday pages (LPL Financial, 2026-10-21; personal values replaced by
 * fakes): question labels, search-and-pick answers, step names, no header noise.
 */

vi.stubGlobal("chrome", { runtime: { sendMessage: async () => {} } });

const load = (name: string) => {
  const html = readFileSync(
    path.join(process.cwd(), "test/fixtures/workday", `${name}.html`),
    "utf8",
  );
  document.documentElement.innerHTML = html
    .replace(/^<!doctype html>\s*/i, "")
    .replace(/^<html[^>]*>|<\/html>$/g, "");
};

describe("watchForm on Workday", () => {
  it("My Information: questions as labels, picked items as answers, the step name", () => {
    load("my-information");
    const page = watchForm(false);
    expect(page.heading).toBe("My Information");
    const field = (automationId: string) =>
      page.fields.filter((f) => f.automationId === automationId);
    expect(field("formField-country")[0]).toMatchObject({
      type: "dropdown",
      label: "Country",
      value: "India",
    });
    expect(field("formField-source")[0]).toMatchObject({
      type: "multiselect",
      label: "How Did You Hear About Us?",
      value: ["Other Website/Social Media"],
    });
    expect(field("formField-candidateIsPreviousWorker")[0]).toMatchObject({
      type: "radio",
      label:
        "Have you worked for LPL Financial as an employee or contingent worker?",
      options: ["Yes", "No"],
    });
    expect(field("formField-legalName--firstName")[0]).toMatchObject({
      label: "Given Name(s)",
      required: true,
    });
    expect(
      page.fields.some((f) => f.automationId === "utilityMenuButton"),
    ).toBe(false);
  });

  it("Application Questions: each dropdown carries its question, not its answer", () => {
    load("application-questions");
    const page = watchForm(false);
    expect(page.heading).toBe("Application Questions");
    const dropdowns = page.fields.filter((f) => f.type === "dropdown");
    expect(dropdowns.length).toBeGreaterThanOrEqual(10);
    for (const d of dropdowns) {
      expect(d.label).not.toMatch(/Required$/);
      expect(d.label.length).toBeGreaterThan(10);
    }
  });
});
