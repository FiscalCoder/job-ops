import { describe, expect, it } from "vitest";
import { classifyField } from "../src/plan/classify.js";
import type { FormField, FormSchema } from "../src/plan/form-schema.js";
import { buildPlan } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * Questions from real forms (GitLab, Instawork, 2026-10-21) that the rules used to answer with
 * the wrong kind of value: a country for a Yes/No, a company name for a Yes/No, a website URL
 * for "do you have publications".
 */

const yesNo = [
  { label: "Yes", value: "1" },
  { label: "No", value: "0" },
];
const field = (label: string, patch: Partial<FormField> = {}): FormField => ({
  ref: "q",
  label,
  type: "select",
  required: true,
  options: yesNo,
  section: "main",
  ...patch,
});
const ruleOf = (label: string, patch?: Partial<FormField>) =>
  classifyField(field(label, patch)).rule;

const bank = new Map([
  ["identity.first_name", "Test"],
  ["identity.last_name", "C"],
  ["location.current_city", "Chennai"],
  ["location.state", "Tamil Nadu"],
  ["location.current_country", "India"],
  ["history.worked_at_company", "No"],
  ["work.relocation", "Yes"],
]);

const plan = (fields: FormField[], withBank = bank) =>
  buildPlan({
    schema: {
      postingId: "1",
      title: "Engineer",
      location: "Remote",
      education: null,
      fields,
      hash: "h",
    } satisfies FormSchema,
    resume: resumeFacts(fakeDesignResume),
    bank: withBank,
  });

describe("Yes/No questions", () => {
  it("never take a value rule (a company name, a country, a city)", () => {
    expect(
      ruleOf("Is your current employer a client of ours?"),
    ).toEqual({ kind: "question" });
    // Its own Yes/No answer, not the employer's name.
    expect(
      ruleOf(
        "Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?",
      ),
    ).toEqual({ kind: "bank", key: "history.restrictive_covenants" });
    expect(ruleOf("Is your current country of residence in the EU?")).toEqual({
      kind: "question",
    });
    // A text field asking the same keeps its rule.
    expect(ruleOf("Current employer", { type: "text", options: [] })).toEqual({
      kind: "profile",
      fact: "recent_employer",
    });
  });

  it("keep the rules that do answer Yes/No", () => {
    expect(
      ruleOf("Have you previously worked at or consulted for GitLab?"),
    ).toEqual({
      kind: "bank",
      key: "history.worked_at_company",
    });
    expect(ruleOf("Will you require visa sponsorship?")).toEqual({
      kind: "work-auth",
      ask: "sponsorship",
    });
    expect(ruleOf("Are you willing to relocate?")).toEqual({
      kind: "bank",
      key: "work.relocation",
    });
  });

  it("answer 'Are you located in <place>?' from your saved location", () => {
    const located = (label: string, ref: string) => field(label, { ref });
    const built = plan([
      located("Are you located in India?", "india"),
      located("Are you based in the United States?", "us"),
      located("Do you currently live in Chennai?", "city"),
      located("Are you located in Bengaluru?", "other-city"),
      located("Are you located in EMEA?", "region"),
    ]);
    const answer = (ref: string) =>
      built.entries.find((e) => e.ref === ref) ?? { status: "missing" };
    expect(answer("india")).toMatchObject({
      status: "fill",
      value: "Yes",
      actionClass: "auto",
    });
    expect(answer("us")).toMatchObject({ status: "fill", value: "No" });
    expect(answer("city")).toMatchObject({ status: "fill", value: "Yes" });
    // Another city in your country, or a region: not guessed (Claude or you).
    expect(answer("other-city")).toMatchObject({ status: "needs-you" });
    expect(answer("region")).toMatchObject({ status: "needs-you" });
  });

  it("says what to add when no location is saved", () => {
    const [only] = plan(
      [field("Are you located in India?")],
      new Map([["identity.first_name", "Test"]]),
    ).entries;
    expect(only).toMatchObject({
      status: "needs-you",
      reason: "Add your current country and city",
    });
  });
});

describe("label rules", () => {
  it("fill 'the name you'd prefer us to use' from your preferred or first name", () => {
    expect(
      ruleOf(
        "What's the name you'd prefer us to use throughout the interview process?",
        { type: "text", options: [] },
      ),
    ).toEqual({
      kind: "bank",
      key: "identity.preferred_name",
      fallbackKey: "identity.first_name",
    });
  });

  it("only give your website for labels that ask for the link", () => {
    const text = { type: "text" as const, options: [] };
    expect(
      ruleOf(
        "Do you have any publications (blog posts, articles on research journals)?",
        text,
      ),
    ).toEqual({ kind: "question" });
    for (const label of [
      "Website",
      "Portfolio URL",
      "Link to your portfolio",
      "Personal website",
      "Blog",
    ])
      expect(ruleOf(label, text)).toEqual({ kind: "profile", fact: "website" });
  });
});
