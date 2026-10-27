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
import { buildKit, type KitInput } from "../src/kit/kit.js";
import type { FillPlan, PlanEntry } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { createAnswerBankRepo } from "../src/store/answer-bank-repo.js";
import { openStore } from "../src/store/db.js";
import { runAsUser } from "../src/store/owner.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

const entry = (patch: Partial<PlanEntry>): PlanEntry => ({
  ref: "q",
  label: "Question",
  section: "main",
  type: "text",
  required: true,
  actionClass: "confirm",
  status: "fill",
  value: "x",
  optionValues: null,
  source: "claude",
  ...patch,
});

const plan = (entries: PlanEntry[]): FillPlan =>
  ({
    schemaHash: "h",
    jobCountry: "India",
    entries,
    summary: {},
  }) as unknown as FillPlan;

const input = (patch: Partial<KitInput> = {}): KitInput => ({
  job: {
    jobId: "job-1",
    title: "Engineer",
    employer: "Acme",
    location: "Bengaluru",
    applyUrl: "https://acme.example/jobs/1",
    tailoredSummary: "Full-stack engineer with 5 years in TypeScript.",
  },
  resume: resumeFacts(fakeDesignResume),
  bank: new Map([
    ["identity.first_name", "Test"],
    ["identity.last_name", "C"],
    ["work.notice_period", "30"],
    ["eeo.gender", "Decline to self-identify"],
    ["misc.heard_about", ""],
  ]),
  plan: null,
  ...patch,
});

const group = (kit: ReturnType<typeof buildKit>, name: string) =>
  kit.groups.find((g) => g.name === name);

describe("buildKit", () => {
  it("groups the answer bank and resume, leaving out empty answers", () => {
    const kit = buildKit(input());
    expect(kit.groups.map((g) => g.name)).toEqual([
      "You",
      "Links",
      "Work and location",
      "Education",
      "This job",
      "Sensitive",
    ]);
    expect(group(kit, "You")?.items).toEqual(
      expect.arrayContaining([
        { key: "you:full_name", label: "Full name", value: "Test C" },
        {
          key: "bank:identity.preferred_name",
          label: "Preferred first name",
          value: "Test",
        },
        { key: "resume:email", label: "Email", value: "test@example.com" },
      ]),
    );
    expect(group(kit, "Links")?.items.map((i) => i.key)).toEqual([
      "resume:linkedin",
      "resume:github",
      "resume:website",
    ]);
    const work = group(kit, "Work and location")?.items ?? [];
    expect(work[0]).toMatchObject({ value: "Acme" });
    expect(work.map((i) => i.key)).toContain("bank:work.notice_period");
    expect(work.map((i) => i.key)).not.toContain("bank:misc.heard_about");
    expect(group(kit, "Sensitive")?.items).toEqual([
      expect.objectContaining({ key: "bank:eeo.gender", sensitive: true }),
    ]);
  });

  it("adds the job's own plan answers, but not what other groups already show", () => {
    const kit = buildKit(
      input({
        plan: plan([
          entry({ ref: "why", label: "Why Acme?", value: "Because…" }),
          entry({
            ref: "langs",
            label: "Languages",
            type: "multiselect",
            value: ["English", "Tamil"],
            source: "bank:profile.languages",
          }),
          entry({ ref: "first_name", source: "bank:identity.first_name" }),
          entry({ ref: "email", source: "resume:email" }),
          entry({ ref: "resume", type: "file", source: "jobops:tailored-pdf" }),
          entry({ ref: "open", status: "needs-you", value: null }),
          entry({
            ref: "notice",
            label: "Notice period?",
            value: "30",
            source: "bank:work.notice_period",
            bankKey: "work.notice_period",
          }),
          entry({
            ref: "auth",
            label: "Authorised to work in India?",
            value: "Yes",
            source: "bank:work.authorized_countries (job in India)",
            bankKey: "work.authorized_countries",
          }),
        ]),
      }),
    );
    expect(group(kit, "This job")?.items).toEqual([
      expect.objectContaining({ key: "jobops:tailored_summary" }),
      { key: "plan:why", label: "Why Acme?", value: "Because…" },
      { key: "plan:langs", label: "Languages", value: "English, Tamil" },
      {
        key: "plan:auth",
        label: "Authorised to work in India?",
        value: "Yes",
      },
    ]);
  });

  it("drops groups with nothing in them", () => {
    const kit = buildKit(
      input({
        bank: new Map(),
        job: { ...input().job, tailoredSummary: null },
      }),
    );
    expect(kit.groups.map((g) => g.name)).not.toContain("This job");
    expect(kit.groups.map((g) => g.name)).not.toContain("Sensitive");
  });
});

const job: JobOpsJob = {
  id: "job-1",
  title: "Senior Backend Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://www.linkedin.com/jobs/view/1",
  applicationLink: "https://careers.acme.example/apply/1",
  suitabilityScore: 82,
};

/** What the fake Job Ops was asked to do, and the job's status there. */
const jobOpsLog: string[] = [];
let jobStatus = "ready";

const jobOps: JobOpsApi = {
  login: async () => ({ token: "good", expiresIn: 3600 }),
  me: async (t) => {
    if (t === "good") return { id: "u1", username: "me", isSystemAdmin: true };
    throw new JobOpsError(401, "UNAUTHORIZED", "nope");
  },
  listJobs: async () => ({ jobs: [job], total: 1, revision: "r" }),
  getJob: async (_t, id) => {
    if (id !== job.id) throw new JobOpsError(404, "NOT_FOUND", "Job not found");
    return {
      ...job,
      status: jobStatus,
      location: "Bengaluru",
      jobDescription: "Build APIs",
      tailoredSummary: "Backend engineer.",
    };
  },
  updateJob: async () => {},
  addNote: async (_t, _id, note) => {
    jobOpsLog.push(`note: ${note.title}`);
  },
  getPdf: async () => new Uint8Array(),
  markApplied: async () => {
    jobOpsLog.push("apply");
    jobStatus = "applied";
  },
  skipJob: async () => {
    jobOpsLog.push("skip");
    jobStatus = "skipped";
  },
  getDesignResume: async () => fakeDesignResume,
};

const claudeReply = (answers: object[]) =>
  ({
    model: "fake",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ answers }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as unknown as Anthropic.Message;

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(create?: MessagesApi["create"]) {
  const db = openStore(":memory:");
  // The signed-in test user ("u1", see jobOps.me) has this saved answer.
  runAsUser("u1", () =>
    createAnswerBankRepo(db).upsert({
      key: "work.notice_period",
      value: "30",
      isProtected: true,
      updatedBy: "you",
    }),
  );
  const server = createApp({
    jobOps,
    db,
    authCacheSeconds: 60,
    claude: create
      ? { messages: { create }, mapModel: "haiku", draftModel: "sonnet" }
      : null,
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
}

describe("kit routes", () => {
  it("serves the kit with Job Ops' application link when no posting is matched", async () => {
    const call = await start();
    const { body } = await call("/kit/job-1");
    expect(body.data.job).toMatchObject({
      applyUrl: "https://careers.acme.example/apply/1",
      tailoredSummary: "Backend engineer.",
    });
    expect(
      body.data.groups.flatMap((g: { items: { key: string }[] }) =>
        g.items.map((i) => i.key),
      ),
    ).toContain("bank:work.notice_period");
    expect((await call("/kit/nope")).status).toBe(404);
  });

  it("answers a pasted question with Claude, and says so when Claude is off", async () => {
    expect(
      (await (await start())("/kit/job-1/answer", { question: "Notice?" }))
        .status,
    ).toBe(503);
    close?.();

    const create = vi.fn<MessagesApi["create"]>();
    create.mockResolvedValueOnce(
      claudeReply([
        {
          ref: "kit",
          kind: "bank",
          bank_key: "work.notice_period",
          answer: [],
          confidence: 0.9,
          why: "Saved notice period",
        },
      ]),
    );
    const call = await start(create);
    const { status, body } = await call("/kit/job-1/answer", {
      question: "What is your notice period in days?",
    });
    expect(status).toBe(200);
    expect(body.data).toEqual({
      value: "30",
      how: "your saved answer (work.notice_period)",
    });
    expect((await call("/kit/job-1/answer", { question: "x" })).status).toBe(
      400,
    );
  });

  it("your instruction on how to write it goes to Claude as yours, and may run past a short answer", async () => {
    const skills = Array.from({ length: 40 }, (_, i) => `Skill ${i}`);
    const create = vi.fn<MessagesApi["create"]>();
    create.mockResolvedValueOnce(
      claudeReply([
        {
          ref: "kit",
          kind: "answer",
          bank_key: "",
          answer: skills,
          confidence: 0.9,
          why: "Skills from the resume",
        },
      ]),
    );
    const call = await start(create);
    const { status, body } = await call("/kit/job-1/answer", {
      question: "What relevant skills make you a great fit?",
      instruction: "comma-separated skills only",
    });
    expect(status).toBe(200);
    expect(body.data.value).toBe(skills.join(", "));
    const sent = String(create.mock.calls[0]?.[0].messages[0]?.content);
    expect(sent).toContain(
      '<candidate_instruction ref="kit">\ncomma-separated skills only',
    );
    expect(sent).toContain('<question ref="kit" type="text" from="candidate">');
  });

  it("marks a job applied or skipped with Job Ops' own actions, once", async () => {
    const call = await start();
    jobOpsLog.length = 0;
    jobStatus = "ready";
    const skipped = await call("/kit/job-1/outcome", { outcome: "skipped" });
    expect(skipped.body.data).toEqual({ status: "skipped" });
    expect(
      (await call("/kit/job-1/outcome", { outcome: "skipped" })).status,
    ).toBe(409);
    // A skipped job can still be applied to (you changed your mind).
    const applied = await call("/kit/job-1/outcome", { outcome: "applied" });
    expect(applied.body.data).toEqual({ status: "applied" });
    const again = await call("/kit/job-1/outcome", { outcome: "skipped" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(
      "Job Ops already has this job as Applied",
    );
    expect(jobOpsLog).toEqual(["skip", "apply", "note: Applied by hand"]);
    expect(
      (await call("/kit/job-1/outcome", { outcome: "maybe" })).status,
    ).toBe(400);
    expect(
      (await call("/kit/nope/outcome", { outcome: "applied" })).status,
    ).toBe(404);
    jobStatus = "ready";
  });
});
