import { describe, expect, it } from "vitest";
import { isListPick, pickToForget } from "../src/fill/pick-memory";
import type { Step } from "../src/fill/supervisor";

const step = (over: { result?: string; reason?: string; value?: string }): Step =>
  ({
    seq: 3,
    state: "filled",
    value: over.value ?? "Information Systems",
    ...(over.result ? { result: over.result } : {}),
    entry: {
      ref: "f1",
      label: "Field of Study",
      type: "select",
      value: over.value ?? "Information Systems",
      source: "resume:education.discipline",
      ...(over.reason ? { reason: over.reason } : {}),
    },
  }) as unknown as Step;

describe("forgetting a list pick you corrected", () => {
  it("knows a list pick: Claude's at fill time, at plan time, or a remembered one", () => {
    expect(isListPick(step({ result: 'Claude picked "Information Systems" of 12 choices seen across searches' }))).toBe(true);
    expect(isListPick(step({ reason: 'Claude picked the closest to "Information System Management"' }))).toBe(true);
    expect(isListPick(step({ result: 'picked "Information Systems" as before for this answer (no Claude call)' }))).toBe(true);
    expect(isListPick(step({ result: "filled" }))).toBe(false);
  });

  it("forgets it when you edit it to something else or fill it yourself", () => {
    const picked = step({ result: 'Claude picked "Information Systems" from the list' });
    expect(pickToForget({ type: "edit", value: "Computer Science" }, picked)).toBe("Information Systems");
    expect(pickToForget({ type: "i-did-it" }, picked)).toBe("Information Systems");
  });

  it("keeps it when you only confirm it, and for fields no pick filled", () => {
    const picked = step({ result: 'Claude picked "Information Systems" from the list' });
    expect(pickToForget({ type: "edit", value: "Information Systems" }, picked)).toBeNull();
    expect(pickToForget({ type: "approve" }, picked)).toBeNull();
    expect(pickToForget({ type: "i-did-it" }, step({ result: "filled" }))).toBeNull();
    expect(pickToForget({ type: "i-did-it" }, undefined)).toBeNull();
  });
});
