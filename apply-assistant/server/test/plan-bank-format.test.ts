import { describe, expect, it } from "vitest";
import { formatBankValue } from "../src/plan/bank-format.js";
import type { FormField } from "../src/plan/gh-schema.js";
import { parseGreenhouseSchema } from "../src/plan/gh-schema.js";
import { buildPlan } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";
import celonis from "./fixtures/gh-celonis.json" with { type: "json" };

const field = (
  label: string,
  type: FormField["type"] = "text",
  options: string[] = [],
): FormField => ({
  ref: "question_1",
  label,
  type,
  required: true,
  options: options.map((o, i) => ({ label: o, value: String(i) })),
  section: "main",
});

describe("formatBankValue", () => {
  it("notice period: '30 days' in text, a bare number when the question asks in days", () => {
    expect(
      formatBankValue("days", "30", field("Notice period?"), null),
    ).toEqual({ value: "30 days", alternatives: [] });
    expect(
      formatBankValue("days", "30", field("Notice period (in days)"), null),
    ).toEqual({ value: "30", alternatives: [] });
    expect(formatBankValue("days", "0", field("Notice period?"), null)).toEqual(
      { value: "Immediate", alternatives: [] },
    );
  });

  it("notice period: offers month/week phrasings for selects", () => {
    expect(
      formatBankValue("days", "30", field("Notice period", "select"), null),
    ).toEqual({
      value: "30 days",
      alternatives: ["1 month", "30"],
    });
    expect(
      formatBankValue("days", "28", field("Notice", "select"), null),
    ).toMatchObject({
      alternatives: ["4 weeks", "28"],
    });
  });

  it("money: LPA, plain amount, or amount with currency, by what the question asks", () => {
    expect(
      formatBankValue(
        "money",
        "INR 3000000",
        field("Current CTC (in LPA)"),
        "India",
      ),
    ).toEqual({ value: "30", alternatives: [] });
    expect(
      formatBankValue(
        "money",
        "INR 3250000",
        field("Expected CTC in lakhs"),
        "India",
      ),
    ).toEqual({ value: "32.5", alternatives: [] });
    expect(
      formatBankValue("money", "INR 3000000", field("Current CTC"), "India"),
    ).toEqual({ value: "3000000", alternatives: [] });
    expect(
      formatBankValue(
        "money",
        "INR 3000000",
        field("Expected salary (INR)"),
        "India",
      ),
    ).toEqual({ value: "3000000", alternatives: [] });
    expect(
      formatBankValue(
        "money",
        "INR 3000000",
        field("Salary expectation"),
        null,
      ),
    ).toEqual({
      value: "3000000 INR per year",
      alternatives: [],
    });
  });

  it("money: a job paid in your currency gets the plain yearly amount; monthly-only fields the month", () => {
    // Workday (J&J): a numbers-only box; "4000000 INR per year" kept only the digits.
    expect(
      formatBankValue(
        "money",
        "INR 4000000",
        field("What is your base salary expectation (annual or monthly)?"),
        "India",
      ),
    ).toEqual({ value: "4000000", alternatives: [] });
    expect(
      formatBankValue(
        "money",
        "INR 3000000",
        field("Expected monthly salary"),
        "India",
      ),
    ).toEqual({ value: "250000", alternatives: [] });
  });

  it("money: never converts currencies; a job paid in another currency needs you", () => {
    expect(
      formatBankValue(
        "money",
        "INR 4000000",
        field("Salary expectation"),
        "Germany",
      ),
    ).toEqual({
      needsYou: "Your saved amount is in INR; this job is in Germany (EUR)",
    });
  });

  it("dates: ISO unless the question names another format", () => {
    expect(
      formatBankValue("date", "2026-11-20", field("Start date"), null),
    ).toEqual({ value: "2026-11-20", alternatives: [] });
    expect(
      formatBankValue(
        "date",
        "2026-11-20",
        field("Start date (DD/MM/YYYY)"),
        null,
      ),
    ).toEqual({ value: "20/11/2026", alternatives: [] });
    expect(
      formatBankValue(
        "date",
        "2026-11-20",
        field("Start date mm/dd/yyyy"),
        null,
      ),
    ).toEqual({ value: "11/20/2026", alternatives: [] });
  });

  it("leaves other kinds and unparseable values alone", () => {
    expect(formatBankValue("text", "Chennai", field("City"), null)).toEqual({
      value: "Chennai",
      alternatives: [],
    });
    expect(formatBankValue("money", "30 LPA", field("CTC"), null)).toEqual({
      value: "30 LPA",
      alternatives: [],
    });
  });
});

describe("planner with formatted bank answers", () => {
  const resume = resumeFacts(fakeDesignResume);

  it("matches '30 days' to a '1 month' choice", () => {
    const schema = {
      ...parseGreenhouseSchema(celonis),
      fields: [
        field("What is your notice period?", "select", [
          "Immediate",
          "1 month",
          "2 months",
        ]),
      ],
    };
    const plan = buildPlan({
      schema,
      resume,
      bank: new Map([["work.notice_period", "30"]]),
    });
    expect(plan.entries[0]).toMatchObject({
      status: "fill",
      value: "1 month",
      optionValues: ["1"],
    });
  });

  it("asks you for an INR salary on a German job", () => {
    const payload = {
      ...structuredClone(celonis),
      location: { name: "Munich, Germany" },
    };
    const plan = buildPlan({
      schema: parseGreenhouseSchema(payload),
      resume,
      bank: new Map([["comp.expected", "INR 4000000"]]),
    });
    const salary = plan.entries.find((e) => e.label === "Salary Expectation");
    expect(salary).toMatchObject({
      status: "needs-you",
      bankKey: "comp.expected",
    });
    expect(salary?.reason).toContain("Germany");
  });
});
