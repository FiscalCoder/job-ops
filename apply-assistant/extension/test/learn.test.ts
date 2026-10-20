import { describe, expect, it } from "vitest";
import { learnable } from "../src/fill/controller";
import { decisionEvent } from "../src/fill/run-trace";
import type { PlanEntry, Step } from "../src/fill/supervisor";

const entry = (patch: Partial<PlanEntry> = {}): PlanEntry => ({
  ref: "q1",
  label: "How did you hear about Acme?",
  section: "main",
  type: "text",
  required: true,
  actionClass: "confirm",
  status: "fill",
  value: "Claude's guess",
  optionValues: null,
  source: "claude:haiku (80%)",
  ...patch,
});

const step = (patch: Partial<Step> = {}, e: Partial<PlanEntry> = {}): Step => ({
  seq: 3,
  entry: entry(e),
  state: "done",
  value: "LinkedIn",
  decision: "edited",
  decidedBy: "you",
  ...patch,
});

describe("learnable: which of your answers are remembered", () => {
  it("your edits and your own answers to form questions", () => {
    expect(learnable(step())).toBe(true);
    expect(
      learnable(step({ decision: "you-did-it", state: "you-did-it" })),
    ).toBe(true);
    expect(
      learnable(
        step({}, { source: "learned: you gave this answer on 2026-10-21" }),
      ),
    ).toBe(true);
    expect(learnable(step({}, { source: "question" }))).toBe(true);
  });

  it("not approvals, skips, files, protected or voluntary answers, or fixed sources", () => {
    expect(learnable(step({ decision: "approved" }))).toBe(false);
    expect(learnable(step({ decision: "skipped", state: "skipped" }))).toBe(
      false,
    );
    expect(learnable(step({ state: "awaiting-you" }))).toBe(false);
    expect(learnable(step({}, { type: "file" }))).toBe(false);
    expect(learnable(step({}, { actionClass: "protected" }))).toBe(false);
    expect(learnable(step({}, { section: "demographic" }))).toBe(false);
    expect(learnable(step({}, { section: "compliance" }))).toBe(false);
    for (const source of [
      "bank:misc.heard_about",
      "resume:github",
      "jobops:tailored-pdf",
      "rule:consent",
    ])
      expect(learnable(step({}, { source }))).toBe(false);
  });
});

describe("decisionEvent", () => {
  it("records what the plan proposed, so a re-confirm isn't counted as a change", () => {
    const current = step({ value: "Claude's guess", decision: undefined });
    expect(decisionEvent({ type: "edit", value: "LinkedIn" }, current)).toEqual(
      {
        message: "You edited step 3 (How did you hear about Acme?)",
        stepSeq: 3,
        data: {
          type: "edit",
          value: "LinkedIn",
          planned: "Claude's guess",
          actionClass: "confirm",
          source: "claude:haiku (80%)",
        },
      },
    );
    expect(decisionEvent({ type: "abort" }, undefined)?.data).toEqual({
      type: "abort",
    });
  });
});
