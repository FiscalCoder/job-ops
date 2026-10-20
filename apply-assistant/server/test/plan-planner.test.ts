import { describe, expect, it } from "vitest";
import type { ClaudeAnswer } from "../src/claude/questions.js";
import { parseGreenhouseSchema } from "../src/plan/gh-schema.js";
import { buildPlan, type FillPlan } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";
import celonis from "./fixtures/gh-celonis.json" with { type: "json" };
import datadog from "./fixtures/gh-datadog.json" with { type: "json" };
import newrelic from "./fixtures/gh-newrelic.json" with { type: "json" };

const resume = resumeFacts(fakeDesignResume);

const fullBank = new Map([
  ["identity.first_name", "Test"],
  ["identity.last_name", "C"],
  ["location.current_city", "Bengaluru"],
  ["location.state", "Karnataka"],
  ["location.current_country", "India"],
  ["work.authorized_countries", "India"],
  ["history.worked_at_company", "No"],
  ["comp.expected", "30 LPA"],
  ["work.earliest_start_date", "30 days"],
  ["misc.heard_about", "LinkedIn"],
  ["work.preferred_cities", "Bengaluru, Remote"],
  ["profile.languages", "English, Hindi"],
]);

const entry = (plan: FillPlan, ref: string) => {
  const found = plan.entries.find((e) => e.ref === ref);
  if (!found) throw new Error(`no entry ${ref}`);
  return found;
};

const withLocation = (payload: typeof newrelic, name: string) => ({
  ...structuredClone(payload),
  location: { name },
});

describe("buildPlan", () => {
  it("fills identity from the bank, never from the resume, and falls back for preferred name", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: fullBank,
    });
    expect(entry(plan, "first_name")).toMatchObject({
      status: "fill",
      value: "Test",
      source: "bank:identity.first_name",
    });
    expect(entry(plan, "last_name")).toMatchObject({ value: "C" });
    expect(entry(plan, "preferred_name")).toMatchObject({
      value: "Test",
      source: "bank:identity.first_name",
    });
    expect(entry(plan, "email")).toMatchObject({
      value: "test@example.com",
      source: "resume:email",
    });
  });

  it("asks you for identity and city when the bank is empty instead of guessing", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: new Map(),
    });
    expect(entry(plan, "first_name")).toMatchObject({
      status: "needs-you",
      bankKey: "identity.first_name",
    });
    expect(entry(plan, "location")).toMatchObject({
      status: "needs-you",
      bankKey: "location.current_city",
    });
  });

  it("matches bank answers to the form's own choices", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: fullBank,
    });
    const country = entry(plan, "question_18984069008");
    expect(country).toMatchObject({ status: "fill", value: "India" });
    expect(country.optionValues).toHaveLength(1);
    expect(entry(plan, "question_18984072008")).toMatchObject({ value: "No" });
  });

  it("answers authorisation and sponsorship from your countries and the job's country", () => {
    const india = buildPlan({
      schema: parseGreenhouseSchema(withLocation(newrelic, "Bangalore, India")),
      resume,
      bank: fullBank,
    });
    expect(india.jobCountry).toBe("India");
    expect(entry(india, "question_18984074008")).toMatchObject({
      value: "Yes",
      actionClass: "protected",
    });
    expect(entry(india, "question_18984075008")).toMatchObject({ value: "No" });

    const germany = buildPlan({
      schema: parseGreenhouseSchema(withLocation(newrelic, "Berlin, Germany")),
      resume,
      bank: fullBank,
    });
    expect(entry(germany, "question_18984074008")).toMatchObject({
      value: "No",
    });
    expect(entry(germany, "question_18984075008")).toMatchObject({
      value: "Yes",
    });
  });

  it("uses Job Ops' location when the posting's doesn't name a country, else asks you", () => {
    const remote = parseGreenhouseSchema(withLocation(newrelic, "Remote"));
    const fromJobOps = buildPlan({
      schema: remote,
      resume,
      bank: fullBank,
      jobLocation: "Pune, India",
    });
    expect(entry(fromJobOps, "question_18984074008")).toMatchObject({
      value: "Yes",
    });
    const unknown = buildPlan({ schema: remote, resume, bank: fullBank });
    expect(entry(unknown, "question_18984074008")).toMatchObject({
      status: "needs-you",
      reason: "Couldn't tell which country this job is in",
    });
  });

  it("fills education from the resume, proposes consent and EEO decline for your click", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: fullBank,
    });
    expect(entry(plan, "school--0")).toMatchObject({
      value: "Some Institute of Technology",
      actionClass: "confirm",
    });
    expect(entry(plan, "degree--0")).toMatchObject({
      value: "Bachelor's Degree",
    });
    expect(entry(plan, "discipline--0")).toMatchObject({
      value: "Computer Science",
    });
    expect(entry(plan, "question_18984076008")).toMatchObject({
      status: "fill",
      actionClass: "confirm",
      source: "rule:consent",
    });
    expect(entry(plan, "veteran_status")).toMatchObject({
      value: "I don't wish to answer",
      actionClass: "confirm",
    });
  });

  it("leaves optional unknowns empty but flags required unknowns", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: fullBank,
    });
    expect(entry(plan, "cover_letter").status).toBe("skip");
    expect(entry(plan, "latitude")).toMatchObject({
      status: "skip",
      reason: "Filled by the page",
    });
    expect(entry(plan, "question_18992930008")).toMatchObject({
      status: "needs-you",
      actionClass: "confirm",
    });
  });

  it("handles multi-selects, reporting choices the form doesn't offer", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(datadog),
      resume,
      bank: fullBank,
    });
    const languages = entry(plan, "question_69650958");
    expect(languages).toMatchObject({
      status: "fill",
      value: ["English", "Hindi"],
    });
    expect(languages.optionValues).toHaveLength(2);
    const cities = entry(plan, "question_69650957");
    expect(cities.reason ?? "").toMatch(/Not offered|^$/);
  });

  it("flags a bank answer that matches none of the choices", () => {
    const bank = new Map([...fullBank, ["misc.heard_about", "Carrier pigeon"]]);
    const plan = buildPlan({
      schema: parseGreenhouseSchema(datadog),
      resume,
      bank,
    });
    expect(entry(plan, "question_69650959")).toMatchObject({
      status: "needs-you",
      reason:
        'Your answer "Carrier pigeon" matches none of the form\'s choices',
    });
  });

  it("uses the most recent job for employer/title and keeps protected salary from the bank", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(celonis),
      resume,
      bank: fullBank,
    });
    expect(entry(plan, "question_31995632003")).toMatchObject({
      value: "Acme",
    });
    expect(entry(plan, "question_31995633003")).toMatchObject({
      value: "Senior Engineer",
    });
    expect(entry(plan, "question_31995637003")).toMatchObject({
      value: "30 LPA",
      actionClass: "protected",
    });
  });

  it("summarises counts and an estimated time", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: fullBank,
    });
    const { summary } = plan;
    expect(summary.fill + summary.needsYou + summary.skipped).toBe(
      plan.entries.length,
    );
    expect(summary.auto + summary.confirm + summary.protected).toBe(
      summary.fill,
    );
    expect(summary.needsYou).toBeGreaterThan(0);
    expect(summary.estMinutes).toBeGreaterThan(1);
  });

  it("sets the phone's country right before the phone number", () => {
    const plan = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: fullBank,
    });
    const refs = plan.entries.map((e) => e.ref);
    expect(refs.indexOf("country")).toBe(refs.indexOf("phone") - 1);
    expect(entry(plan, "country")).toMatchObject({
      status: "fill",
      value: "India",
      required: false,
    });
  });
});

describe("buildPlan with Claude's answers", () => {
  const SELECT = "question_18992931008";
  const TEXT = "question_18992930008";
  const plan = (claude: Map<string, ClaudeAnswer>, bank = fullBank) =>
    buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank,
      claude,
    });

  it("fills a checked answer, gated on your click, with its confidence and reason", () => {
    const built = plan(
      new Map([
        [
          SELECT,
          {
            kind: "answer",
            value: "Yes",
            confidence: 0.85,
            why: "Python on resume",
            model: "claude-haiku-5-5",
          },
        ],
      ]),
    );
    expect(entry(built, SELECT)).toMatchObject({
      status: "fill",
      actionClass: "confirm",
      value: "Yes",
      source: "claude:haiku (85%): Python on resume",
    });
  });

  it("shows an unsure guess as a suggestion and waits for you", () => {
    const built = plan(
      new Map([
        [
          SELECT,
          {
            kind: "answer",
            value: "Yes",
            confidence: 0.3,
            why: "Maybe",
            model: "claude-haiku-5-5",
          },
        ],
      ]),
    );
    expect(entry(built, SELECT)).toMatchObject({
      status: "needs-you",
      reason: expect.stringContaining("unsure guess (30%): Yes"),
    });
  });

  it("uses your saved answer when Claude points to one, keeping protected keys protected", () => {
    const built = plan(
      new Map([
        [
          TEXT,
          {
            kind: "bank",
            key: "comp.expected",
            confidence: 0.9,
            why: "Pay",
            model: "claude-haiku-5-5",
          },
        ],
      ]),
    );
    expect(entry(built, TEXT)).toMatchObject({
      status: "fill",
      actionClass: "protected",
      source: "claude:haiku → bank:comp.expected (90%)",
      bankKey: "comp.expected",
    });
  });

  it("asks you to save an answer when Claude points to an empty one", () => {
    const built = plan(
      new Map([
        [
          TEXT,
          {
            kind: "bank",
            key: "work.relocation",
            confidence: 0.9,
            why: "x",
            model: "claude-haiku-5-5",
          },
        ],
      ]),
    );
    expect(entry(built, TEXT)).toMatchObject({
      status: "needs-you",
      bankKey: "work.relocation",
    });
  });

  it("fills drafts for your review, and passes on Claude's reason when it can't answer", () => {
    const built = plan(
      new Map<string, ClaudeAnswer>([
        [
          TEXT,
          {
            kind: "draft",
            value: "Yes, at Acme I ran Meraki.",
            model: "claude-sonnet-5-5",
          },
        ],
        [
          SELECT,
          {
            kind: "unknown",
            why: "Not on your resume",
            model: "claude-haiku-5-5",
          },
        ],
      ]),
    );
    expect(entry(built, TEXT)).toMatchObject({
      status: "fill",
      actionClass: "confirm",
      source: "claude:sonnet draft",
    });
    expect(entry(built, SELECT)).toMatchObject({
      status: "needs-you",
      reason: "Claude: Not on your resume",
    });
  });

  it("says why there's no answer when Claude isn't available", () => {
    const built = buildPlan({
      schema: parseGreenhouseSchema(newrelic),
      resume,
      bank: fullBank,
      claudeProblem: "Claude couldn't be reached",
    });
    expect(entry(built, SELECT)).toMatchObject({
      status: "needs-you",
      reason: "Claude couldn't be reached",
    });
  });
});
