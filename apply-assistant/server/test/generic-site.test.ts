import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagesApi } from "../src/claude/answerer.js";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { parseGenericPage } from "../src/plan/generic-schema.js";
import { buildPlan } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import type { WorkdayPage } from "../src/plan/workday-schema.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * Any company's own application page, read generically by the extension: planned from labels,
 * with Claude's steps for fields the extension can't fill by itself, kept as per-site recipes.
 */

type Field = WorkdayPage["fields"][number];
const field = (
  ref: string,
  label: string,
  kind: Field["kind"],
  more: Partial<Field> = {},
): Field => ({
  ref,
  key: ref,
  label,
  kind,
  required: false,
  options: [],
  ...more,
});

const careersPage: WorkdayPage = {
  system: "generic",
  step: "/careers/apply/123 · Apply for Senior Engineer",
  fields: [
    field("#first", "First Name *", "text", { required: true }),
    field("#last", "Last name", "text", { required: true }),
    field("#mail", "Email address", "text", { required: true }),
    field("#tel", "Mobile number", "text"),
    field("#cv", "Upload your CV", "file", { required: true }),
    field("#gender", "Gender", "dropdown", {
      options: ["Male", "Female", "Prefer not to say"],
    }),
    field("#city", "Which city do you live in?", "text", { required: true }),
    field("#privacy", "I agree to the privacy notice", "checkbox", {
      required: true,
    }),
  ],
};

const bank = new Map([
  ["identity.first_name", "Sam"],
  ["identity.last_name", "T"],
  ["location.current_city", "Bengaluru"],
]);

describe("a company's own page, planned from its labels", () => {
  it("names, email, phone, resume, city and consent from what you've saved; gender declines", () => {
    const plan = buildPlan({
      schema: parseGenericPage(careersPage, "Senior Engineer"),
      resume: resumeFacts(fakeDesignResume),
      bank,
    });
    const of = (ref: string) => plan.entries.find((e) => e.ref === ref);
    expect(of("#first")).toMatchObject({ status: "fill", value: "Sam" });
    expect(of("#last")).toMatchObject({ status: "fill", value: "T" });
    expect(of("#mail")?.source).toBe("resume:email");
    expect(of("#tel")?.source).toBe("resume:phone");
    expect(of("#cv")).toMatchObject({
      status: "fill",
      source: "jobops:tailored-pdf",
    });
    expect(of("#gender")).toMatchObject({
      status: "fill",
      value: "Prefer not to say",
      section: "demographic",
    });
    expect(of("#city")).toMatchObject({ status: "fill", value: "Bengaluru" });
    expect(of("#privacy")).toMatchObject({
      status: "fill",
      value: "I agree to the privacy notice",
      actionClass: "confirm",
    });
  });

  it("the resume goes only where a resume is asked for, not into Oracle's other attachments", () => {
    const oracle: WorkdayPage = {
      system: "generic",
      step: "/apply/section/1 · step 1 of 3",
      fields: [
        field("#import", "Import your profile from resume", "file"),
        field("#resume", "Upload Resume", "file"),
        field("#attachment", "Upload Attachment", "file"),
        field("#letter", "Cover Letter", "file"),
      ],
    };
    const plan = buildPlan({
      schema: parseGenericPage(oracle, "Senior Engineer"),
      resume: resumeFacts(fakeDesignResume),
      bank,
    });
    const of = (ref: string) => plan.entries.find((e) => e.ref === ref);
    expect(of("#import")?.source).toBe("jobops:tailored-pdf");
    expect(of("#resume")?.source).toBe("jobops:tailored-pdf");
    expect(of("#attachment")?.status).toBe("skip");
    expect(of("#letter")?.status).toBe("skip");

    // No upload names the resume: the first unnamed one is it, a second isn't.
    const unnamed = buildPlan({
      schema: parseGenericPage(
        {
          ...oracle,
          fields: [
            field("#a", "Drop or select", "file"),
            field("#b", "Upload", "file"),
            field("#c", "Supporting documents", "file", { required: true }),
          ],
        },
        "Senior Engineer",
      ),
      resume: resumeFacts(fakeDesignResume),
      bank,
    });
    const in2 = (ref: string) => unnamed.entries.find((e) => e.ref === ref);
    expect(in2("#a")?.source).toBe("jobops:tailored-pdf");
    expect(in2("#b")?.status).toBe("skip");
    expect(in2("#c")?.status).toBe("needs-you");
  });
});

const job: JobOpsJob = {
  id: "job-1",
  title: "Senior Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://careers.acme.example/jobs/123",
  applicationLink: null,
  suitabilityScore: 80,
};
const jobOps: JobOpsApi = {
  login: async () => ({ token: "good", expiresIn: 3600 }),
  me: async (t) => {
    if (t === "good") return { id: "u1", username: "me", isSystemAdmin: true };
    throw new JobOpsError(401, "UNAUTHORIZED", "nope");
  },
  listJobs: async () => ({ jobs: [job], total: 1, revision: "r" }),
  getJob: async (_t, id) => {
    if (id !== "job-1") throw new JobOpsError(404, "NOT_FOUND", "no job");
    return { ...job, location: "Bengaluru", jobDescription: "x" };
  },
  updateJob: async () => {},
  addNote: async () => {},
  markApplied: async () => {},
  skipJob: async () => {},
  getPdf: async () => new Uint8Array(),
  getDesignResume: async () => fakeDesignResume,
};

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(reply: () => unknown) {
  const create = vi.fn<MessagesApi["create"]>(
    async () =>
      ({
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(reply()) }],
        usage: { input_tokens: 2_000, output_tokens: 80 },
      }) as unknown as Anthropic.Message,
  );
  const server = createApp({
    jobOps,
    db: openStore(":memory:"),
    authCacheSeconds: 60,
    claude: {
      messages: { create },
      mapModel: "claude-haiku-5-5",
      draftModel: "claude-sonnet-5-5",
    },
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { call, create };
}

describe("Claude's steps for a field, and the recipes they become", () => {
  it("steps come back checked; your answer is masked in the trail; unusable steps are refused", async () => {
    let reply: unknown = {
      steps: [
        { action: "click", value: ".select__control" },
        { action: "type", value: "Bengaluru" },
        { action: "wait", value: "500" },
        { action: "pick", value: "Bengaluru, Karnataka" },
      ],
      why: "A searchable dropdown",
    };
    const { call, create } = await start(() => reply);
    const ask = {
      label: "Current location",
      wanted: "Bengaluru",
      html: '<div class="select__control"><input data-ac-target="1"></div>',
      failure: "No choice matching",
    };
    const acted = await call("POST", "/plans/job-1/act", ask);
    expect(acted.status).toBe(200);
    expect(acted.json.data.steps).toHaveLength(4);
    const prompt = String(create.mock.calls[0]?.[0].messages[0]?.content);
    expect(prompt).toContain('data-ac-target="1"');
    expect(create.mock.calls[0]?.[0].model).toBe("claude-sonnet-5-5");

    const trail = (await call("GET", "/trace/jobs/job-1")).json.data.events;
    const act = trail.find((e: any) => e.kind === "act");
    expect(JSON.stringify(act.data.steps)).not.toContain('Bengaluru"');
    expect(act.data.steps[1].value).toBe("{value}");

    // A key that isn't allowed: nothing is run.
    reply = { steps: [{ action: "press", value: "F5" }], why: "reload" };
    expect((await call("POST", "/plans/job-1/act", ask)).status).toBe(422);
    expect(
      (await call("POST", "/plans/job-1/act", { label: "x" })).status,
    ).toBe(400);
  });

  it("a recipe is kept per site and question, with how often it worked", async () => {
    const { call } = await start(() => ({ steps: [], why: "" }));
    const steps = [
      { action: "click", value: ".select__control" },
      { action: "type", value: "{value}" },
      { action: "press", value: "Enter" },
    ];
    const host = "careers.acme.example";
    await call("POST", "/recipes", {
      host,
      label: "Current location *",
      steps,
      ok: true,
      jobId: "job-1",
    });
    await call("POST", "/recipes", {
      host,
      label: "current location",
      steps,
      ok: true,
    });
    await call("POST", "/recipes", {
      host,
      label: "Current location",
      steps,
      ok: false,
    });
    const recipes = (await call("GET", `/recipes?host=${host}`)).json.data;
    expect(recipes).toEqual([
      expect.objectContaining({
        labelKey: "current location",
        steps,
        worked: 2,
        failed: 1,
      }),
    ]);
    expect(
      (await call("GET", "/recipes?host=other.example")).json.data,
    ).toEqual([]);
    expect((await call("GET", "/recipes?host=bad host!")).status).toBe(400);
  });
});
