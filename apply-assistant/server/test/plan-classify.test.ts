import { describe, expect, it } from "vitest";
import { classifyField, type FieldRule } from "../src/plan/classify.js";
import { parseGreenhouseSchema } from "../src/plan/gh-schema.js";
import celonis from "./fixtures/gh-celonis.json" with { type: "json" };
import datadog from "./fixtures/gh-datadog.json" with { type: "json" };
import newrelic from "./fixtures/gh-newrelic.json" with { type: "json" };

const rulesFor = (payload: unknown) =>
  Object.fromEntries(
    parseGreenhouseSchema(payload).fields.map((f) => [
      f.ref,
      classifyField(f).rule,
    ]),
  );

const bank = (key: string): FieldRule => ({ kind: "bank", key });

describe("classifyField on real Greenhouse forms", () => {
  it("New Relic: identity, location, history, work authorisation, consent, education, EEO", () => {
    const rules = rulesFor(newrelic);
    expect(rules).toMatchObject({
      first_name: bank("identity.first_name"),
      last_name: bank("identity.last_name"),
      preferred_name: {
        kind: "bank",
        key: "identity.preferred_name",
        fallbackKey: "identity.first_name",
      },
      email: { kind: "profile", fact: "email" },
      phone: { kind: "profile", fact: "phone" },
      resume: { kind: "resume-file" },
      cover_letter: { kind: "cover-letter" },
      question_18984069008: bank("location.current_country"),
      question_18984070008: bank("location.state"),
      question_18984071008: { kind: "profile", fact: "linkedin" },
      question_18984072008: bank("history.worked_at_company"),
      question_18984073008: bank("history.worked_at_company"),
      question_18984074008: { kind: "work-auth", ask: "authorized" },
      question_18984075008: { kind: "work-auth", ask: "sponsorship" },
      question_18984076008: { kind: "consent" },
      question_18992930008: { kind: "question" },
      question_18992931008: { kind: "question" },
      location: bank("location.current_city"),
      latitude: { kind: "hidden" },
      longitude: { kind: "hidden" },
      "school--0": { kind: "education", part: "school" },
      "degree--0": { kind: "education", part: "degree" },
      "discipline--0": { kind: "education", part: "discipline" },
      veteran_status: { kind: "eeo", key: "eeo.veteran" },
    });
  });

  it("Datadog: links, consent pair, multi-selects, how-did-you-hear, EEO", () => {
    expect(rulesFor(datadog)).toMatchObject({
      question_69650952: { kind: "profile", fact: "linkedin" },
      question_69650953: { kind: "profile", fact: "website" },
      question_69650954: { kind: "consent" },
      question_69650955: { kind: "consent" },
      question_69650956: { kind: "work-auth", ask: "authorized" },
      question_69650957: bank("work.preferred_cities"),
      question_69650958: bank("profile.languages"),
      question_69650959: bank("misc.heard_about"),
      race: { kind: "eeo", key: "eeo.race" },
      gender: { kind: "eeo", key: "eeo.gender" },
    });
  });

  it("Celonis: most recent employer/title, salary, start date, consents", () => {
    expect(rulesFor(celonis)).toMatchObject({
      question_31995632003: { kind: "profile", fact: "recent_employer" },
      question_31995633003: { kind: "profile", fact: "recent_title" },
      question_31995635003: { kind: "work-auth", ask: "authorized" },
      question_31995636003: { kind: "work-auth", ask: "sponsorship" },
      question_31995637003: bank("comp.expected"),
      question_31995638003: bank("work.earliest_start_date"),
      question_31995639003: bank("misc.heard_about"),
      question_31995640003: { kind: "consent" },
      question_31995641003: { kind: "consent" },
      demographic_4023664003: { kind: "question" },
    });
  });

  it.each([
    ["What is your notice period?", bank("work.notice_period")],
    ["Current CTC (INR)", bank("comp.current")],
    ["Expected CTC", bank("comp.expected")],
    ["Are you willing to relocate?", bank("work.relocation")],
    ["Which city do you currently live in?", bank("location.current_city")],
    ["Where are you based?", bank("location.current_city")],
    [
      "How many years of professional experience do you have?",
      bank("profile.years_experience"),
    ],
    [
      "How many years of experience do you have with Kafka?",
      { kind: "question" },
    ],
    ["Date of birth", bank("identity.date_of_birth")],
    ["GitHub profile", { kind: "profile", fact: "github" }],
    ["Portfolio", { kind: "profile", fact: "website" }],
    ["What are your pronouns?", { kind: "eeo", key: "eeo.pronouns" }],
    ["Sexual orientation", { kind: "eeo", key: "eeo.other" }],
    [
      "Do you have the right to work in the UK?",
      { kind: "work-auth", ask: "authorized" },
    ],
    ["Why do you want to work here?", { kind: "question" }],
  ] as const)("label %s", (label, rule) => {
    const field = {
      ref: "question_1",
      label,
      type: "text" as const,
      required: true,
      options: [],
      section: "main" as const,
    };
    expect(classifyField(field).rule).toEqual(rule);
  });

  it("assigns the action class: protected for sensitive answers, confirm for consent/EEO/questions", () => {
    const field = (label: string) => ({
      ref: "question_1",
      label,
      type: "select" as const,
      required: true,
      options: [],
      section: "main" as const,
    });
    expect(classifyField(field("Expected CTC")).actionClass).toBe("protected");
    expect(
      classifyField(field("Do you require visa sponsorship?")).actionClass,
    ).toBe("protected");
    expect(
      classifyField(field("I agree to the privacy policy")).actionClass,
    ).toBe("confirm");
    expect(classifyField(field("Gender")).actionClass).toBe("confirm");
    expect(classifyField(field("Why us?")).actionClass).toBe("confirm");
    expect(classifyField(field("Where are you based?")).actionClass).toBe(
      "auto",
    );
  });
});
