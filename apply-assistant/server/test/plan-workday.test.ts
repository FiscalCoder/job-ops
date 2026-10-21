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
import { buildPlan } from "../src/plan/planner.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import {
  parseWorkdayPage,
  type WorkdayPage,
} from "../src/plan/workday-schema.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * Workday pages as the extension reads them (field sets from the LPL Financial application,
 * 2026-10-21): planned one page at a time.
 */

type Field = WorkdayPage["fields"][number];
const field = (
  key: string,
  label: string,
  kind: Field["kind"],
  more: Partial<Field> = {},
): Field => ({
  ref: `x--${key}`,
  key,
  label,
  kind,
  required: false,
  options: [],
  ...more,
});

const myInformation: WorkdayPage = {
  step: "My Information",
  fields: [
    field("source", "How Did You Hear About Us?", "search", {
      required: true,
    }),
    field(
      "candidateIsPreviousWorker",
      "Have you worked for LPL Financial as an employee or contingent worker?",
      "radio",
      { required: true, options: ["Yes", "No"] },
    ),
    field("country", "Country", "dropdown", {
      required: true,
      options: ["India", "United States of America"],
    }),
    field("legalName--firstName", "Given Name(s)", "text", { required: true }),
    field("legalName--lastName", "Family Name", "text", { required: true }),
    field("legalName--firstNameLocal", "Local Given Name(s)", "text"),
    field("preferredCheck", "I have a preferred name", "checkbox"),
    field("addressLine1", "Address Line 1", "text"),
    field("city", "City", "text"),
    field("phoneType", "Phone Device Type", "dropdown", {
      required: true,
      options: ["Landline", "Mobile"],
    }),
    field("countryPhoneCode", "Country Phone Code", "search", {
      required: true,
    }),
    field("phoneNumber", "Phone Number", "text", { required: true }),
  ],
};

const bank = new Map([
  ["identity.first_name", "Sam"],
  ["identity.last_name", "T"],
  ["location.current_country", "India"],
  ["location.current_city", "Bengaluru"],
  ["history.worked_at_company", "No"],
  ["misc.heard_about", "LinkedIn"],
]);

const planOf = (page: WorkdayPage) =>
  buildPlan({
    schema: parseWorkdayPage(page, "Engineer"),
    resume: resumeFacts(fakeDesignResume),
    bank,
  });
const entry = (plan: ReturnType<typeof planOf>, key: string) =>
  plan.entries.find((e) => e.ref === `x--${key}`);

describe("Workday page plans", () => {
  it("My Information: names, country, phone and source from your bank; extras left alone", () => {
    const plan = planOf(myInformation);
    expect(entry(plan, "legalName--firstName")).toMatchObject({
      status: "fill",
      value: "Sam",
    });
    expect(entry(plan, "country")).toMatchObject({
      status: "fill",
      value: "India",
    });
    expect(entry(plan, "countryPhoneCode")).toMatchObject({
      status: "fill",
      value: "India",
    });
    expect(entry(plan, "phoneType")).toMatchObject({
      status: "fill",
      value: "Mobile",
    });
    expect(entry(plan, "candidateIsPreviousWorker")).toMatchObject({
      status: "fill",
      value: "No",
    });
    expect(entry(plan, "source")).toMatchObject({
      status: "fill",
      value: "LinkedIn",
    });
    expect(entry(plan, "city")).toMatchObject({
      status: "fill",
      value: "Bengaluru",
    });
    for (const key of ["legalName--firstNameLocal", "preferredCheck"])
      expect(entry(plan, key)?.status).toBe("skip");
    // Optional and unknown: left empty, not asked.
    expect(entry(plan, "addressLine1")?.status).toBe("skip");
  });

  it("My Experience: work history, dates and skills are Workday's (from your resume)", () => {
    const plan = planOf({
      step: "My Experience",
      fields: [
        {
          ...field("jobTitle", "Job Title", "text", { required: true }),
          ref: "workExperience-192--jobTitle",
        },
        field("skills", "Type to Add Skills", "search"),
        field("startDate", "From", "date"),
        field("", "Upload a file (5MB max)", "file"),
      ],
    });
    expect(plan.entries.map((e) => e.status)).toEqual([
      "skip",
      "skip",
      "skip",
      "fill",
    ]);
    expect(plan.entries[3]?.source).toBe("jobops:tailored-pdf");
  });

  it("Voluntary Disclosures: the terms checkbox is consent; gender declines without an answer", () => {
    const plan = planOf({
      step: "Voluntary Disclosures",
      fields: [
        field("gender", "Gender", "dropdown", {
          options: ["Male", "Female", "I do not wish to answer"],
        }),
        field(
          "acceptTermsAndAgreements",
          "Yes, I have read and consent to the terms and conditions",
          "checkbox",
          {
            required: true,
            options: [
              "Yes, I have read and consent to the terms and conditions*",
            ],
          },
        ),
      ],
    });
    expect(plan.entries[0]).toMatchObject({
      status: "fill",
      value: "I do not wish to answer",
      section: "demographic",
    });
    expect(plan.entries[1]).toMatchObject({
      status: "fill",
      value: "Yes, I have read and consent to the terms and conditions",
      actionClass: "confirm",
    });
  });
});

const job: JobOpsJob = {
  id: "job-1",
  title: "Engineer",
  employer: "LPL Financial",
  status: "ready",
  jobUrl: "https://lplfinancial.wd1.myworkdayjobs.com/en-US/External/job/1",
  applicationLink: null,
  suitabilityScore: 80,
};

const jobOps: JobOpsApi = {
  login: async () => ({ token: "good", expiresIn: 3600 }),
  me: async (t) => {
    if (t === "good") return { id: "u1", username: "me" };
    throw new JobOpsError(401, "UNAUTHORIZED", "nope");
  },
  listJobs: async () => ({ jobs: [job], total: 1, revision: "r" }),
  getJob: async (_t, id) => {
    if (id !== "job-1") throw new JobOpsError(404, "NOT_FOUND", "no job");
    return { ...job, location: "Bengaluru, India", jobDescription: "x" };
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

describe("POST /plans/:jobId/page", () => {
  it("plans the page you're on, asks Claude only the open questions, and traces it", async () => {
    const create = vi.fn<MessagesApi["create"]>(
      async () =>
        ({
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                answers: [
                  {
                    ref: "x--q18",
                    kind: "answer",
                    bank_key: "",
                    answer: ["Yes"],
                    confidence: 0.9,
                    why: "Adult",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 1_000, output_tokens: 100 },
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
    const call = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer good",
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    const page: WorkdayPage = {
      step: "Application Questions",
      fields: [
        field("q18", "Are you 18 or older?", "dropdown", {
          required: true,
          options: ["Yes", "No"],
        }),
        field("q19", "Do you hold any FINRA licenses?", "dropdown", {
          options: ["Yes", "No"],
        }),
      ],
    };
    const planned = await call("/plans/job-1/page", page);
    expect(planned.status).toBe(200);
    expect(planned.body.data.entries[0]).toMatchObject({
      ref: "x--q18",
      status: "fill",
      value: "Yes",
    });
    // Optional questions aren't sent to Claude.
    const prompt = String(create.mock.calls[0]?.[0].messages[0]?.content);
    expect(prompt).toContain("18 or older");
    expect(prompt).not.toContain("FINRA");

    expect((await call("/plans/job-1/page", { step: "x" })).status).toBe(400);
    expect((await call("/plans/nope/page", page)).status).toBe(404);

    const trail = await (
      await fetch(`${base}/trace/jobs/job-1`, {
        headers: { authorization: "Bearer good" },
      })
    ).json();
    const planEvent = (trail as any).data.events.find(
      (e: { kind: string }) => e.kind === "plan",
    );
    expect(planEvent.message).toContain('Workday page "Application Questions"');
  });
});
