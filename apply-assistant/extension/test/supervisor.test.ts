import { describe, expect, it } from "vitest";
import {
  maskValue,
  nextAction,
  type PlanEntry,
  type RunEvent,
  type RunState,
  reduce,
  startRun,
} from "../src/fill/supervisor";

const entry = (ref: string, patch: Partial<PlanEntry> = {}): PlanEntry => ({
  ref,
  label: ref,
  section: "main",
  type: "text",
  required: true,
  actionClass: "auto",
  status: "fill",
  value: `${ref}-value`,
  optionValues: null,
  source: "bank:x",
  ...patch,
});

const run = (entries: PlanEntry[], countdownSeconds = 3) =>
  startRun(entries, { countdownSeconds });
const apply = (state: RunState, ...events: RunEvent[]) =>
  events.reduce(reduce, state);

describe("startRun", () => {
  it("drops skipped entries and always puts the resume last", () => {
    const state = run([
      entry("resume", { type: "file" }),
      entry("first_name"),
      entry("latitude", { status: "skip" }),
      entry("email"),
    ]);
    expect(state.steps.map((s) => s.entry.ref)).toEqual([
      "first_name",
      "email",
      "resume",
    ]);
    expect(state.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it("goes straight to review when there is nothing to fill", () => {
    expect(nextAction(run([]))).toEqual({ kind: "review" });
  });
});

describe("gates", () => {
  it("auto: counts down, then fills", () => {
    let state = run([entry("first_name")]);
    expect(nextAction(state)).toMatchObject({ kind: "countdown", seconds: 3 });
    state = reduce(state, { type: "countdown-finished" });
    expect(nextAction(state)).toMatchObject({ kind: "fill" });
    expect(state.steps[0]).toMatchObject({
      decision: "approved",
      decidedBy: "countdown",
    });
  });

  it("auto with a 0 s countdown waits for your approval on every action", () => {
    const state = run([entry("first_name")], 0);
    expect(nextAction(state)).toMatchObject({ kind: "wait-for-you" });
    expect(reduce(state, { type: "countdown-finished" })).toBe(state);
    expect(nextAction(reduce(state, { type: "approve" }))).toMatchObject({
      kind: "fill",
    });
  });

  it("confirm and protected always wait for your click, even after 'approve remaining auto'", () => {
    let state = run([
      entry("first_name"),
      entry("consent", { actionClass: "confirm" }),
      entry("ctc", { actionClass: "protected" }),
    ]);
    state = apply(state, { type: "approve-remaining-auto" });
    expect(state.steps[0]).toMatchObject({
      state: "running",
      decidedBy: "you",
    });
    state = apply(state, { type: "filled", result: "ok" });
    expect(nextAction(state)).toMatchObject({
      kind: "wait-for-you",
      step: { entry: { ref: "consent" } },
    });
    expect(apply(state, { type: "countdown-finished" })).toBe(state);
    state = apply(state, { type: "approve" }, { type: "filled", result: "ok" });
    expect(nextAction(state)).toMatchObject({
      kind: "wait-for-you",
      step: { entry: { ref: "ctc" } },
    });
  });

  it("after 'approve remaining auto', later auto steps fill without a countdown", () => {
    let state = run([entry("a"), entry("b")]);
    state = apply(
      state,
      { type: "approve-remaining-auto" },
      { type: "filled", result: "ok" },
    );
    expect(nextAction(state)).toMatchObject({ kind: "countdown", seconds: 0 });
    state = apply(state, { type: "countdown-finished" });
    expect(nextAction(state)).toMatchObject({
      kind: "fill",
      step: { entry: { ref: "b" } },
    });
  });

  it("needs-you: waits; you can type the answer, do it yourself, or skip", () => {
    const state = run([
      entry("q1", {
        status: "needs-you",
        value: null,
        reason: "No saved answer",
      }),
      entry("q2", { status: "needs-you", value: null }),
      entry("q3", { status: "needs-you", value: null }),
    ]);
    expect(nextAction(state)).toMatchObject({
      kind: "wait-for-you",
      step: { note: "No saved answer" },
    });
    expect(reduce(state, { type: "approve" })).toBe(state);
    let next = apply(state, { type: "edit", value: "Yes" });
    expect(nextAction(next)).toMatchObject({
      kind: "fill",
      step: { value: "Yes", decision: "edited" },
    });
    next = apply(
      next,
      { type: "filled", result: "ok" },
      { type: "i-did-it", value: "typed on the page" },
    );
    expect(next.steps[1]).toMatchObject({
      state: "you-did-it",
      decidedBy: "you",
    });
    next = apply(next, { type: "skip" });
    expect(next.steps[2]).toMatchObject({ state: "skipped" });
    expect(nextAction(next)).toEqual({ kind: "review" });
  });
});

describe("failures, pause, abort, submit", () => {
  it("a value that didn't stick comes back to you with the reason", () => {
    let state = run([entry("phone")]);
    state = apply(
      state,
      { type: "countdown-finished" },
      { type: "fill-failed", reason: "Value didn't stick" },
    );
    expect(nextAction(state)).toMatchObject({
      kind: "wait-for-you",
      step: { note: "Value didn't stick" },
    });
    state = apply(state, { type: "approve" }, { type: "filled", result: "ok" });
    expect(nextAction(state)).toEqual({ kind: "review" });
  });

  it("after two failed attempts, Approve stops retrying; editing the value tries again", () => {
    let state = run([entry("phone")]);
    state = apply(
      state,
      { type: "countdown-finished" },
      { type: "fill-failed", reason: "x" },
    );
    state = apply(
      state,
      { type: "approve" },
      { type: "fill-failed", reason: "still x" },
    );
    expect(state.steps[0]?.attempts).toBe(2);
    expect(apply(state, { type: "approve" })).toBe(state);
    state = apply(state, { type: "edit", value: "+91 98765" });
    expect(nextAction(state)).toMatchObject({
      kind: "fill",
      step: { attempts: 0 },
    });
  });

  it("pause holds everything until resume", () => {
    let state = apply(run([entry("a")]), { type: "pause" });
    expect(nextAction(state)).toEqual({ kind: "paused" });
    expect(apply(state, { type: "countdown-finished" })).toBe(state);
    state = apply(state, { type: "resume" });
    expect(nextAction(state)).toMatchObject({ kind: "countdown" });
  });

  it("ignores fill results that arrive when nothing is running", () => {
    const state = run([entry("a")]);
    expect(reduce(state, { type: "filled", result: "ok" })).toBe(state);
    expect(reduce(state, { type: "fill-failed", reason: "x" })).toBe(state);
  });

  it("abort ends the run; submit is only something you report", () => {
    expect(apply(run([entry("a")]), { type: "abort" })).toMatchObject({
      phase: "finished",
      outcome: "aborted",
    });
    const reviewed = apply(
      run([entry("a")]),
      { type: "countdown-finished" },
      { type: "filled", result: "ok" },
    );
    expect(reviewed.phase).toBe("review");
    const done = apply(reviewed, { type: "submitted" });
    expect(done).toMatchObject({ phase: "finished", outcome: "submitted" });
    expect(nextAction(done)).toEqual({ kind: "finished" });
    expect(reduce(done, { type: "approve" })).toBe(done);
  });
});

describe("maskValue", () => {
  it("keeps only the first character and the length", () => {
    expect(maskValue("Bengaluru")).toBe("B***(9)");
    expect(maskValue(["English", "Tamil"])).toBe("E***(14)");
    expect(maskValue("No")).toBe("**");
    expect(maskValue(null)).toBeNull();
  });
});
