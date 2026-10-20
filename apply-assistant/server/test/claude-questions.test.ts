import { describe, expect, it } from "vitest";
import {
  cacheKey,
  checkMapItem,
  type MapItem,
  mapPrompt,
  parseMapReply,
  type Question,
  type QuestionContext,
  savedAnswersForPrompt,
} from "../src/claude/questions.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

const context: QuestionContext = {
  job: { title: "Engineer", employer: "Acme", description: "Build APIs." },
  resume: resumeFacts(fakeDesignResume),
  bank: new Map([
    ["identity.first_name", "Test"],
    ["location.current_city", "Bengaluru"],
    ["comp.expected", "INR 4000000"],
    ["eeo.gender", "Male"],
    ["identity.date_of_birth", "1995-01-01"],
  ]),
};

const yesNo: Question = {
  ref: "q1",
  label: "Do you have Python experience?",
  type: "select",
  options: ["Yes", "No"],
};
const text: Question = {
  ref: "q2",
  label: "Years with React?",
  type: "text",
  options: [],
};

const item = (patch: Partial<MapItem>): MapItem => ({
  ref: "q1",
  kind: "answer",
  bank_key: "",
  answer: [],
  confidence: 0.9,
  why: "Resume shows it",
  ...patch,
});

describe("what Claude is sent", () => {
  it("withholds private saved answers but lists their keys", () => {
    const saved = savedAnswersForPrompt(context.bank);
    expect(saved).toContain("location.current_city — Current city: Bengaluru");
    expect(saved).toContain(
      "comp.expected — Expected compensation (yearly): (saved, private)",
    );
    expect(saved).toContain(
      "identity.first_name — First name: (saved, private)",
    );
    expect(saved).toContain("eeo.gender — Gender (EEO): (saved, private)");
    expect(saved).toContain("work.relocation — Willing to relocate: (empty)");
    expect(saved).not.toMatch(/4000000|1995|Male|Test/);
  });

  it("puts the job, resume, saved answers and questions in tagged blocks", () => {
    const prompt = mapPrompt([yesNo], context);
    expect(prompt).toContain("<job>\nEngineer at Acme\n\nBuild APIs.\n</job>");
    expect(prompt).toContain(
      "Senior Engineer at Acme (2023-09 to present): Built things",
    );
    expect(prompt).toContain("- Frontend: React, TypeScript");
    expect(prompt).toContain('<question ref="q1" type="select">');
    expect(prompt).toContain("Choices:\n- Yes\n- No");
  });

  it("changes the cache key when anything sent changes", () => {
    const base = cacheKey("map", "m", yesNo, context);
    expect(cacheKey("map", "m", yesNo, context)).toBe(base);
    expect(cacheKey("map", "m2", yesNo, context)).not.toBe(base);
    expect(cacheKey("draft", "m", yesNo, context)).not.toBe(base);
    expect(
      cacheKey("map", "m", yesNo, {
        ...context,
        bank: new Map([...context.bank, ["work.relocation", "Yes"]]),
      }),
    ).not.toBe(base);
  });
});

describe("checking Claude's reply", () => {
  it("parses the structured reply and rejects other shapes", () => {
    expect(parseMapReply(JSON.stringify({ answers: [item({})] }))).toHaveLength(
      1,
    );
    expect(() => parseMapReply('{"answers":[{"ref":1}]}')).toThrow();
    expect(() => parseMapReply("not json")).toThrow();
  });

  it("accepts a choice only when it is one of the form's choices", () => {
    expect(checkMapItem(yesNo, item({ answer: ["yes"] }), "m")).toMatchObject({
      kind: "answer",
      value: "Yes",
    });
    expect(checkMapItem(yesNo, item({ answer: ["Maybe"] }), "m")).toMatchObject(
      {
        kind: "unknown",
        why: "Claude's answer isn't one of the form's choices",
      },
    );
  });

  it("keeps several choices for multi-select", () => {
    const multi: Question = {
      ...yesNo,
      type: "multiselect",
      options: ["A", "B", "C"],
    };
    expect(
      checkMapItem(multi, item({ answer: ["A", "C"] }), "m"),
    ).toMatchObject({
      value: ["A", "C"],
    });
  });

  it("clamps confidence and limits short answers", () => {
    expect(
      checkMapItem(
        text,
        item({ ref: "q2", answer: ["4"], confidence: 7 }),
        "m",
      ),
    ).toMatchObject({ kind: "answer", value: "4", confidence: 1 });
    expect(
      checkMapItem(text, item({ ref: "q2", answer: ["x".repeat(301)] }), "m"),
    ).toMatchObject({ kind: "unknown" });
  });

  it("passes saved-answer pointers only for real keys", () => {
    expect(
      checkMapItem(
        text,
        item({ kind: "bank", bank_key: "work.relocation" }),
        "m",
      ),
    ).toMatchObject({ kind: "bank", key: "work.relocation" });
    expect(
      checkMapItem(text, item({ kind: "bank", bank_key: "made.up" }), "m"),
    ).toMatchObject({ kind: "unknown" });
  });

  it("drafts only text questions, and treats a missing item as unknown", () => {
    expect(checkMapItem(text, item({ kind: "write" }), "m")).toEqual({
      kind: "write",
    });
    expect(checkMapItem(yesNo, item({ kind: "write" }), "m")).toMatchObject({
      kind: "unknown",
    });
    expect(checkMapItem(yesNo, undefined, "m")).toMatchObject({
      kind: "unknown",
      why: "Claude gave no answer for this question",
    });
    expect(checkMapItem(yesNo, item({ answer: [" "] }), "m")).toMatchObject({
      kind: "unknown",
    });
  });
});
