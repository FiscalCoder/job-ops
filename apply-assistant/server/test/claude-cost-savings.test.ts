import { describe, expect, it } from "vitest";
import { usageOfMessage } from "../src/claude/pricing.js";
import {
  draftPromptBlocks,
  mapPrompt,
  mapPromptBlocks,
  type Question,
  type QuestionContext,
} from "../src/claude/questions.js";
import type { FormField } from "../src/plan/gh-schema.js";
import { currentRoleEndDate } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

const context: QuestionContext = {
  job: { title: "Engineer", employer: "Acme", description: "Build APIs." },
  resume: resumeFacts(fakeDesignResume),
  bank: new Map([["location.current_city", "Bengaluru"]]),
};

const question: Question = {
  ref: "q1",
  label: "Do you have Python experience?",
  type: "select",
  options: ["Yes", "No"],
  required: true,
} as Question;

describe("cached prompt prefixes", () => {
  it("puts your resume and saved answers first, then the job, both cached; the questions last", () => {
    const blocks = mapPromptBlocks([question], context);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.text).toMatch(/^<resume>[\s\S]*<saved_answers>[\s\S]*Bengaluru/);
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]?.text).toMatch(/^<job>\nEngineer at Acme/);
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[2]?.text).toMatch(/^<questions>/);
    expect(blocks[2]?.cache_control).toBeUndefined();
    // The one-text form says the same, in the same order.
    expect(mapPrompt([question], context)).toBe(blocks.map((b) => b.text).join("\n\n"));
  });

  it("keeps the cached part the same across jobs and questions", () => {
    const other = { ...context, job: { title: "SRE", employer: "Beta", description: null } };
    const a = mapPromptBlocks([question], context);
    const b = mapPromptBlocks([{ ...question, ref: "q2", label: "Notice period?" }], other);
    expect(b[0]?.text).toBe(a[0]?.text);
    const draft = draftPromptBlocks(question, context);
    expect(draft.map((d) => Boolean(d.cache_control))).toEqual([true, true, false]);
    expect(draft[1]?.text).toBe(a[1]?.text);
  });
});

describe("cost with cached prompt parts", () => {
  it("counts cache writes at 1.25x and reads at 0.1x of the input price", () => {
    const plain = usageOfMessage({
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 1_000, output_tokens: 100 },
    });
    expect(plain.inputTokens).toBe(1_000);
    expect(plain.cost).toBeCloseTo((1_000 * 2 + 100 * 10) / 1e6, 10);
    const cachedUsage = usageOfMessage({
      model: "claude-sonnet-5-5",
      usage: {
        input_tokens: 200,
        output_tokens: 100,
        cache_creation_input_tokens: 4_000,
        cache_read_input_tokens: 6_000,
      },
    });
    expect(cachedUsage.inputTokens).toBe(200 + 5_000 + 600);
    expect(cachedUsage.cost).toBeCloseTo(((200 + 5_000 + 600) * 2 + 100 * 10) / 1e6, 10);
  });
});

describe("an end date for the job you're still in", () => {
  const field = (label: string, required = false) =>
    ({ ref: "f", label, type: "select", required, options: [] }) as unknown as FormField;
  const why = "Resume lists this role as present; no end date to give";

  it("is left empty when optional and Claude says the role is current", () => {
    expect(currentRoleEndDate(field("End date month"), why)).toBe(true);
    expect(currentRoleEndDate(field("End date year"), why)).toBe(true);
    expect(currentRoleEndDate(field("To Year"), "Currently employed here")).toBe(true);
    expect(currentRoleEndDate(field("End Date"), "This is the ongoing role")).toBe(true);
  });

  it("still asks you when required, for other fields, or for other reasons", () => {
    expect(currentRoleEndDate(field("End date month", true), why)).toBe(false);
    expect(currentRoleEndDate(field("Start date month"), why)).toBe(false);
    expect(currentRoleEndDate(field("Reason for leaving"), why)).toBe(false);
    expect(currentRoleEndDate(field("End date year"), "Not on your resume")).toBe(false);
  });
});
