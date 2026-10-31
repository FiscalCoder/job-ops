import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { MessagesApi } from "../src/claude/answerer.js";
import {
  createPageMapper,
  mergePageMap,
  type PageMap,
  pageMapPrompt,
} from "../src/claude/page-map.js";
import { parseGenericPage } from "../src/plan/generic-schema.js";
import { buildPlan } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import type { WorkdayPage } from "../src/plan/workday-schema.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * Claude's map of a company's page: what each field takes, which job it belongs to, what kind
 * of input it is. It only fills what the page reader left out.
 */

type Field = WorkdayPage["fields"][number];
const field = (ref: string, label: string, kind: Field["kind"], more: Partial<Field> = {}): Field => ({
  ref,
  key: ref,
  label,
  kind,
  required: false,
  options: [],
  ...more,
});

const page: WorkdayPage = {
  system: "generic",
  step: "/apply · Engineer",
  fields: [
    field("#fn", "First Name", "text"),
    // A label that says nothing; the reader can't tell.
    field("#q7", "Field 7", "text", { context: "placeholder: you@example.com" }),
    // Numbered entries the reader didn't group (no heading it knows).
    field("#co_0", "Company", "text"),
    field("#ti_0", "Title", "text"),
    field("#skills", "Skills", "text", { context: "placeholder: Add new skill" }),
    // Already in a block the reader found: never moved.
    field("#co_9", "Company", "text", { block: { id: "Work-1", heading: "Work History (1)" } }),
  ],
};

const map: PageMap = {
  fields: [
    { ref: "#fn", meaning: "last_name", section: "none", entry: 0, input: "plain" },
    { ref: "#q7", meaning: "email", section: "none", entry: 0, input: "plain" },
    { ref: "#co_0", meaning: "question", section: "experience", entry: 0, input: "plain" },
    { ref: "#ti_0", meaning: "question", section: "experience", entry: 0, input: "plain" },
    { ref: "#skills", meaning: "skills", section: "none", entry: 0, input: "tags" },
    { ref: "#co_9", meaning: "question", section: "experience", entry: 5, input: "plain" },
  ],
  add: ["Work Experience"],
};

describe("merging Claude's map into the page", () => {
  const merged = mergePageMap(page, map);
  const at = (ref: string) => merged.fields.find((f) => f.ref === ref);

  it("fields with no job get Claude's; ones the reader grouped keep theirs", () => {
    expect(at("#co_0")?.block).toEqual({ id: "Experience-0", heading: "Experience" });
    expect(at("#co_9")?.block).toEqual({ id: "Work-1", heading: "Work History (1)" });
    expect(at("#fn")?.block).toBeUndefined();
  });

  it("input kinds the reader can't see go along as hints; Add buttons it saw are added", () => {
    expect(at("#skills")?.widget).toBe("tags");
    expect(merged.addable).toEqual(["Work Experience"]);
  });

  it("a meaning is used only where the label says nothing: the reader's own wins", () => {
    const resume = resumeFacts(fakeDesignResume);
    const plan = buildPlan({
      schema: parseGenericPage(merged, "Engineer", resume),
      resume,
      bank: new Map([
        ["identity.first_name", "Testy"],
        ["identity.last_name", "User"],
      ]),
    });
    const of = (ref: string) => plan.entries.find((e) => e.ref === ref);
    // "First Name" stays the first name, whatever Claude said.
    expect(of("#fn")?.value).toBe("Testy");
    // "Field 7" is the email, from Claude's map.
    expect(of("#q7")?.value).toBe(resume.email);
    // The block Claude saw: the job's company and title.
    expect(of("#co_0")?.value).toBe("Acme");
    expect(of("#ti_0")?.value).toBe("Senior Engineer");
    expect(of("#skills")?.widget).toBe("tags");
  });
});

describe("asking Claude for the map", () => {
  const reply = {
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(map) }],
    usage: { input_tokens: 2_000, output_tokens: 400 },
  } as unknown as Anthropic.Message;

  it("one call per page layout: the same form again is remembered; the prompt is one line per field", async () => {
    const create = vi.fn<MessagesApi["create"]>(async () => reply);
    const mapper = createPageMapper({ messages: { create }, model: "claude-haiku-5-5" });
    const usage = vi.fn();
    expect(await mapper.map("u1", "", page, usage)).toEqual(map);
    // Typed values don't change the layout.
    const typed = { ...page, fields: page.fields.map((f) => ({ ...f, value: "x" })) };
    expect(await mapper.map("u1", "", typed)).toEqual(map);
    expect(create).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(pageMapPrompt(page).split("\n")).toContain("#q7 | text | Field 7 | #q7 | placeholder: you@example.com");
  });

  it("an answer it can't use: no map (the page reader alone)", async () => {
    const create = vi.fn<MessagesApi["create"]>(
      async () => ({ ...reply, content: [{ type: "text", text: '{"fields":"nope"}' }] }) as Anthropic.Message,
    );
    const mapper = createPageMapper({ messages: { create }, model: "claude-haiku-5-5" });
    expect(await mapper.map("u1", "", page)).toBeNull();
  });
});
