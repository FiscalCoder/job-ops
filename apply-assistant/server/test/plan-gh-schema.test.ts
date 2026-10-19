import { describe, expect, it } from "vitest";
import { parseGreenhouseSchema } from "../src/plan/gh-schema.js";
import celonis from "./fixtures/gh-celonis.json" with { type: "json" };
import datadog from "./fixtures/gh-datadog.json" with { type: "json" };
import newrelic from "./fixtures/gh-newrelic.json" with { type: "json" };

const byRef = (schema: ReturnType<typeof parseGreenhouseSchema>, ref: string) =>
  schema.fields.find((f) => f.ref === ref);

describe("parseGreenhouseSchema (real ?questions=true payloads)", () => {
  it("reads the main questions with their type, requiredness and options", () => {
    const schema = parseGreenhouseSchema(newrelic);
    expect(schema.ghJobId).toBe("5453390008");
    expect(byRef(schema, "first_name")).toMatchObject({
      label: "First Name",
      type: "text",
      required: true,
      section: "main",
    });
    expect(byRef(schema, "resume")).toMatchObject({
      type: "file",
      required: true,
    });
    expect(byRef(schema, "cover_letter")).toMatchObject({
      type: "file",
      required: false,
    });
    const country = byRef(schema, "question_18984069008");
    expect(country?.type).toBe("select");
    expect(country?.options.length).toBe(196);
    expect(country?.options[0]).toEqual({
      label: expect.any(String),
      value: expect.any(String),
    });
  });

  it("drops the paste-instead textareas that ride along with file questions", () => {
    const schema = parseGreenhouseSchema(newrelic);
    expect(byRef(schema, "resume_text")).toBeUndefined();
    expect(byRef(schema, "cover_letter_text")).toBeUndefined();
  });

  it("adds location questions, keeping the hidden coordinates as hidden", () => {
    const schema = parseGreenhouseSchema(newrelic);
    expect(byRef(schema, "location")).toMatchObject({
      type: "text",
      section: "location",
    });
    expect(byRef(schema, "latitude")?.type).toBe("hidden");
  });

  it("adds the Education section only when the posting has one", () => {
    const withEducation = parseGreenhouseSchema(newrelic);
    expect(withEducation.education).toBe("required");
    expect(
      withEducation.fields
        .filter((f) => f.section === "education")
        .map((f) => f.ref),
    ).toEqual(["school--0", "degree--0", "discipline--0"]);
    expect(byRef(withEducation, "school--0")?.required).toBe(true);

    const without = parseGreenhouseSchema(datadog);
    expect(without.education).toBeNull();
    expect(without.fields.some((f) => f.section === "education")).toBe(false);
  });

  it("strips the [] suffix from multi-select names and flattens EEO compliance", () => {
    const schema = parseGreenhouseSchema(datadog);
    expect(byRef(schema, "question_69650957")?.type).toBe("multiselect");
    const eeo = schema.fields
      .filter((f) => f.section === "compliance")
      .map((f) => f.ref);
    expect(eeo).toEqual(["veteran_status", "race", "gender"]);
  });

  it("reads demographic questions with their answer options", () => {
    const schema = parseGreenhouseSchema(celonis);
    const demo = schema.fields.filter((f) => f.section === "demographic");
    expect(demo.length).toBe(celonis.demographic_questions.questions.length);
    expect(demo[0]?.ref).toBe("demographic_4023664003");
    expect(demo[0]?.options.at(-1)?.label).toBe("I prefer not to answer");
  });

  it("gives the same hash for the same form and a different one when it changes", () => {
    const a = parseGreenhouseSchema(newrelic);
    const b = parseGreenhouseSchema(structuredClone(newrelic));
    expect(a.hash).toBe(b.hash);
    const changed = structuredClone(newrelic);
    const first = changed.questions[0];
    if (!first) throw new Error("fixture has no questions");
    first.required = false;
    expect(parseGreenhouseSchema(changed).hash).not.toBe(a.hash);
  });

  it("maps unknown field types to 'unknown' instead of failing", () => {
    const odd = structuredClone(datadog);
    const field = odd.questions[0]?.fields[0];
    if (!field) throw new Error("fixture has no fields");
    field.type = "something_new";
    expect(parseGreenhouseSchema(odd).fields[0]?.type).toBe("unknown");
  });

  it("rejects payloads that are not a Greenhouse job", () => {
    expect(() => parseGreenhouseSchema({ hello: "world" })).toThrow(
      /Greenhouse/,
    );
  });
});
