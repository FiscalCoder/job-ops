import { describe, expect, it, vi } from "vitest";
import type { ApplyClient } from "../src/lib/api";
import { KeptAnswers, keepable, stillShows } from "../src/fill/kept-answers";
import type { PlanEntry, Step } from "../src/fill/supervisor";

const entry = (more: Partial<PlanEntry> = {}): PlanEntry => ({
  ref: "#q",
  label: "Are you open to relocation?",
  section: "main",
  type: "select",
  required: true,
  actionClass: "confirm",
  status: "fill",
  value: "Yes",
  optionValues: null,
  source: "claude:haiku (85%): open to moving",
  ...more,
});

const step = (more: Partial<Step> = {}, entryMore: Partial<PlanEntry> = {}): Step => ({
  seq: 1,
  entry: entry(entryMore),
  state: "done",
  value: "Yes",
  decision: "approved",
  ...more,
});

describe("which of Claude's answers can be kept", () => {
  it("a choice Claude made and the run filled", () => {
    expect(keepable(step())).toBe(true);
  });

  it("not text, drafts, unsure guesses, saved answers it pointed to, or ones you changed", () => {
    expect(keepable(step({}, { type: "textarea" }))).toBe(false);
    expect(keepable(step({}, { source: "claude:sonnet draft" }))).toBe(false);
    expect(keepable(step({}, { check: "Claude was unsure (30%) about Yes" }))).toBe(false);
    expect(keepable(step({}, { source: "claude:haiku → bank:comp.expected (90%)" }))).toBe(false);
    expect(keepable(step({ decision: "edited" }))).toBe(false);
    expect(keepable(step({}, { source: "bank:identity.email" }))).toBe(false);
    expect(keepable(step({}, { section: "demographic" }))).toBe(false);
    expect(keepable(step({ state: "skipped" }))).toBe(false);
  });

  it("a multi-choice counts only while every pick still shows", () => {
    expect(stillShows("Docker, Kubernetes", ["Docker", "Kubernetes"])).toBe(true);
    expect(stillShows("Docker", ["Docker", "Kubernetes"])).toBe(false);
  });
});

describe("remembering them when you submit", () => {
  const client = () => {
    const learn = vi.fn().mockResolvedValue({});
    return { learn, client: { learn } as unknown as ApplyClient };
  };

  it("only what still showed the last time the page was looked at", async () => {
    const kept = new KeptAnswers();
    const relocate = step();
    const notice = step({ seq: 2, value: "30 days" }, { label: "Notice period", value: "30 days" });
    await kept.note([relocate, notice], async (e) => (e.label === "Notice period" ? "30 days" : "Yes"));
    // You changed the notice period on the page before submitting.
    await kept.note([relocate, notice], async (e) => (e.label === "Notice period" ? "60 days" : "Yes"));
    const { learn, client: api } = client();
    expect(await kept.remember(api, "job-1")).toBe(1);
    expect(learn).toHaveBeenCalledWith({
      jobId: "job-1",
      label: "Are you open to relocation?",
      type: "select",
      value: "Yes",
      how: "accepted",
    });
  });
});
