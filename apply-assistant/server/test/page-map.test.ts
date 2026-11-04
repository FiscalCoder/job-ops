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
import { usedEntries } from "../src/plan/history-blocks.js";
import { buildPlan } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { parseWorkdayPage, type WorkdayPage } from "../src/plan/workday-schema.js";
import { openStore } from "../src/store/db.js";
import { createPageMapsRepo } from "../src/store/page-maps-repo.js";
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

  it("a map kept in the database is used after a restart, without asking again", async () => {
    const db = openStore(":memory:");
    const store = createPageMapsRepo(db);
    const create = vi.fn<MessagesApi["create"]>(async () => reply);
    await createPageMapper({ messages: { create }, model: "claude-haiku-5-5", store }).map("u1", "", page);
    // A new server: a new mapper with nothing in memory.
    const restarted = createPageMapper({ messages: { create }, model: "claude-haiku-5-5", store });
    expect(await restarted.map("u1", "", page)).toEqual(map);
    expect(create).toHaveBeenCalledTimes(1);
    // Another user's same layout is theirs to map.
    await restarted.map("u2", "", page);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("a kept map that no longer fits the reply's shape is asked for again", async () => {
    const create = vi.fn<MessagesApi["create"]>(async () => reply);
    const store = { get: () => ({ fields: "old shape" }), set: vi.fn() };
    const mapper = createPageMapper({ messages: { create }, model: "claude-haiku-5-5", store });
    expect(await mapper.map("u1", "", page)).toEqual(map);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledOnce();
  });

  it("an answer it can't use: no map (the page reader alone)", async () => {
    const create = vi.fn<MessagesApi["create"]>(
      async () => ({ ...reply, content: [{ type: "text", text: '{"fields":"nope"}' }] }) as Anthropic.Message,
    );
    const mapper = createPageMapper({ messages: { create }, model: "claude-haiku-5-5" });
    expect(await mapper.map("u1", "", page)).toBeNull();
  });
});

describe("Claude's closer read (a field got stuck, or you asked)", () => {
  const answer = (fields: PageMap["fields"]) =>
    ({
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ fields, add: [] }) }],
      usage: { input_tokens: 9_000, output_tokens: 400 },
    }) as unknown as Anthropic.Message;
  const closer = map.fields.map((f) =>
    f.ref === "#q7" ? { ...f, meaning: "phone" as const } : f,
  );

  it("always asks the stronger model with the form's HTML, and its map is the one kept", async () => {
    const create = vi.fn<MessagesApi["create"]>(async (body) =>
      body.messages[0]?.content.toString().includes("<form")
        ? answer(closer)
        : answer(map.fields),
    );
    const mapper = createPageMapper({
      messages: { create },
      model: "claude-haiku-5-5",
      deepModel: "claude-sonnet-5-5",
    });
    expect((await mapper.map("u1", "", page))?.fields).toEqual(map.fields);
    const html = '<form><label>Phone</label><input data-aa-field="1"></form>';
    const read = await mapper.map("u1", "", page, undefined, { snapshot: html });
    expect(read?.fields.find((f) => f.ref === "#q7")?.meaning).toBe("phone");
    const deep = create.mock.calls[1]?.[0];
    expect(deep?.model).toBe("claude-sonnet-5-5");
    expect(String(deep?.messages[0]?.content)).toContain(html);
    // The same layout later: the closer read's map, without asking again.
    expect(await mapper.map("u1", "", page)).toEqual(read);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("a multi-page form: Claude is told the pages before this one", () => {
    const prompt = pageMapPrompt(page, ["/apply · Personal details", "/apply · Experience"]);
    expect(prompt.split("\n")[0]).toBe(
      "Earlier pages of this application: /apply · Personal details / /apply · Experience",
    );
  });
});

describe("a form with one job per page", () => {
  const resume = resumeFacts(fakeDesignResume);
  // Page 2 of a form: one more job to give ("Previous employer").
  const second: WorkdayPage = {
    system: "generic",
    step: "/apply/2 · Previous employer",
    fields: [
      field("#co", "Company", "text", { block: { id: "Work-0", heading: "Previous employer" } }),
      field("#ti", "Job title", "text", { block: { id: "Work-0", heading: "Previous employer" } }),
    ],
  };
  const titleOn = (elsewhere?: Parameters<typeof parseGenericPage>[3]) =>
    buildPlan({
      schema: parseGenericPage(second, "Engineer", resume, elsewhere),
      resume,
      bank: new Map(),
    }).entries.find((e) => e.ref === "#co")?.value;

  it("takes the job earlier pages didn't; alone, the first job as before", () => {
    expect(titleOn()).toBe(resume.experience[0]?.company);
    const first = usedEntries(["history.experience.0.companyName", "email", undefined]);
    expect([...first.experience]).toEqual([0]);
    expect(titleOn(first)).toBe(resume.experience[1]?.company);
  });
});

describe("Workday pages take Claude's map only where Workday's keys say nothing", () => {
  const workday: WorkdayPage = {
    step: "Application Questions",
    fields: [
      field("legalName--firstName", "First Name", "text", { key: "legalName--firstName", meaning: "last_name" }),
      field("x--q3", "Your profile link", "text", { key: "q3", meaning: "linkedin" }),
    ],
  };
  const schema = parseWorkdayPage(workday, "Engineer");
  it("its own key wins; an unknown one gets Claude's meaning", () => {
    expect(schema.fields.map((f) => f.canonical)).toEqual(["first_name", "linkedin"]);
  });
});

describe("Zoho Recruit (ePlane): address, country and the phone's country code", () => {
  const resume = resumeFacts(fakeDesignResume);
  const zoho: WorkdayPage = {
    system: "generic",
    step: "/jobs/Careers/2111 · Engineer",
    fields: [
      field("[name=street]", "Street", "text"),
      field("[name=country]", "Country", "text"),
      field("[name=mobile]", "Mobile", "text"),
      // The (+91) list beside Mobile: no label of its own; Claude's map calls it the phone.
      field("#code", "", "dropdown", { meaning: "phone" }),
      field("#code2", "Mobile", "search"),
      // A label that says nothing; Claude's map: the expected salary.
      field("[name=rec-form_9]", "rec-form_9", "text", { meaning: "expected_salary" }),
    ],
  };
  const plan = buildPlan({
    schema: parseGenericPage(zoho, "Engineer", resume),
    resume,
    bank: new Map([
      ["location.address_line1", "12 Home Street"],
      ["location.current_country", "India"],
      ["location.current_city", "Chennai"],
      ["comp.expected", "30 LPA"],
    ]),
  });
  const of = (ref: string) => plan.entries.find((e) => e.ref === ref)?.value;

  it("the street and country are your street and country, not your city", () => {
    expect(of("[name=street]")).toBe("12 Home Street");
    expect(of("[name=country]")).toBe("India");
  });
  it("the number in the box; a list where the phone goes takes your country (its +91)", () => {
    expect(of("[name=mobile]")).toBe(resume.phone);
    expect(of("#code")).toBe("India");
    expect(of("#code2")).toBe("India");
  });
  it("a field the map names (salary) gets that answer", () => {
    expect(of("[name=rec-form_9]")).toBe("30 LPA");
  });
});

describe("you tell Claude what to do on the page (mid-fill)", () => {
  const photo: WorkdayPage = {
    system: "generic",
    step: "/oneclick-ui · Software Engineer",
    fields: [
      field("#avatar", "Upload image", "file"),
      field("#drop", "Choose a file", "file"),
    ],
  };
  const yours: PageMap = {
    fields: [
      { ref: "#avatar", meaning: "attachment", section: "none", entry: 0, input: "plain" },
      { ref: "#drop", meaning: "resume", section: "none", entry: 0, input: "plain" },
    ],
    add: [],
  };

  it("your words go to Claude, first, with the page's HTML", async () => {
    const create = vi.fn<MessagesApi["create"]>(async () => ({
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(yours) }],
      usage: { input_tokens: 9_000, output_tokens: 200 },
    }) as unknown as Anthropic.Message);
    const mapper = createPageMapper({
      messages: { create },
      model: "claude-haiku-5-5",
      deepModel: "claude-sonnet-5-5",
    });
    await mapper.map("u1", "", photo, undefined, {
      snapshot: "<form></form>",
      note: "the resume goes in the Resume dropzone, not the profile image",
    });
    const text = String(create.mock.calls[0]?.[0].messages[0]?.content);
    expect(text.split("\n")[0]).toContain(
      'the resume goes in the Resume dropzone, not the profile image',
    );
  });

  it("then Claude's meanings come before the labels' (which upload is the resume, too)", () => {
    const resume = resumeFacts(fakeDesignResume);
    const plan = (followed: boolean) =>
      buildPlan({
        schema: parseGenericPage(mergePageMap(photo, yours, { followed }), "Engineer", resume),
        resume,
        bank: new Map(),
      });
    const of = (p: ReturnType<typeof plan>, ref: string) => p.entries.find((e) => e.ref === ref);
    const told = plan(true);
    expect(of(told, "#avatar")?.status).toBe("skip");
    expect(of(told, "#drop")?.source).toBe("jobops:tailored-pdf");
    // Without your word, the first upload is still taken for the resume, as before.
    expect(of(plan(false), "#avatar")?.source).toBe("jobops:tailored-pdf");
  });
});

describe("fields Claude found in the page's HTML that the reader didn't (inside a web component)", () => {
  const missed: PageMap = {
    fields: [],
    add: [],
    missed: [
      { selector: "#spl-form-element_10", label: "City", kind: "text", meaning: "location", input: "autocomplete" },
      // A mark only the HTML sent to Claude has: never a selector for the live page.
      { selector: "[data-aa-field='3']", label: "Email", kind: "text", meaning: "email", input: "plain" },
      // The reader has it already (same label, or same selector).
      { selector: "#fn2", label: "First Name", kind: "text", meaning: "first_name", input: "plain" },
      { selector: "#fn", label: "Given name", kind: "text", meaning: "first_name", input: "plain" },
    ],
  };
  const merged = mergePageMap(page, missed);

  it("are added with Claude's selector, kind, meaning and input; the reader's fields stay as they were", () => {
    expect(merged.fields.slice(0, page.fields.length)).toEqual(page.fields);
    expect(merged.fields.slice(page.fields.length)).toEqual([
      {
        ref: "#spl-form-element_10",
        key: "",
        label: "City",
        kind: "text",
        required: false,
        options: [],
        context: "found by Claude in the page's HTML",
        meaning: "location",
        widget: "autocomplete",
      },
    ]);
  });

  it("are planned like the reader's (your city goes in)", () => {
    const schema = parseGenericPage(merged, "Engineer", resumeFacts(fakeDesignResume));
    expect(schema.fields.some((f) => f.ref === "#spl-form-element_10")).toBe(true);
  });

  it("a map without them (older ones) adds nothing", () => {
    expect(mergePageMap(page, { fields: [], add: [] }).fields).toEqual(page.fields);
  });
});

describe("fields behind a button (an entry's Edit, a closed section)", () => {
  const withButtons: WorkdayPage = {
    ...page,
    cards: [{ heading: "Experience", text: "Edit experience Lead Acme · Lead Acme 2021" }],
    revealers: [
      { ref: '[data-ac-reveal="r0"]', label: "Edit experience Lead Acme", heading: "Experience", collapsed: false },
      { ref: '[data-ac-reveal="r1"]', label: "Additional questions", heading: "Questions", collapsed: true },
    ],
  };

  it("Claude is told the cards and the buttons", () => {
    const prompt = pageMapPrompt(withButtons);
    expect(prompt).toContain("Entries shown as cards (filled already):\nExperience | Edit experience Lead Acme");
    expect(prompt).toContain('[data-ac-reveal="r1"] | Additional questions | Questions | collapsed');
  });

  it("the buttons Claude picks are marked to click; the others aren't", () => {
    const merged = mergePageMap(withButtons, { fields: [], add: [], reveal: ['[data-ac-reveal="r1"]'] });
    expect(merged.revealers?.map((r) => r.reveal ?? false)).toEqual([false, true]);
  });
});
