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
  entriesToAdd,
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

  it("My Experience: each job and degree entry from your resume, in order, plus skills", () => {
    const at = (
      entry: string,
      key: string,
      label: string,
      kind: Field["kind"],
      more: Partial<Field> = {},
    ) => ({
      ...field(key, label, kind, more),
      ref: `${entry}--${key}`,
    });
    const job = (n: number) => [
      at(`workExperience-${n}`, "jobTitle", "Job Title", "text", {
        required: true,
      }),
      at(`workExperience-${n}`, "companyName", "Company", "text", {
        required: true,
      }),
      at(`workExperience-${n}`, "location", "Location", "text"),
      at(
        `workExperience-${n}`,
        "currentlyWorkHere",
        "I currently work here",
        "checkbox",
        {
          options: ["I currently work here"],
        },
      ),
      at(`workExperience-${n}`, "startDate", "From", "date", {
        required: true,
      }),
      at(`workExperience-${n}`, "endDate", "To", "date", { required: true }),
      at(
        `workExperience-${n}`,
        "roleDescription",
        "Role Description",
        "textarea",
      ),
    ];
    const plan = planOf({
      step: "My Experience",
      fields: [
        ...job(129),
        ...job(130),
        // A third entry: your resume has two (visible) jobs, so it's yours.
        ...job(131).slice(0, 1),
        at("education-153", "school", "School or University", "search", {
          required: true,
        }),
        at("education-153", "degree", "Degree", "dropdown", {
          required: true,
          options: ["Diploma", "Bachelor's Degree", "Master's Degree"],
        }),
        at("education-153", "fieldOfStudy", "Field of Study", "search"),
        at(
          "education-153",
          "lastYearAttended",
          "To (Actual or Expected)",
          "date",
        ),
        at("education-153", "gradeAverage", "Overall Result (GPA)", "text"),
        at("skills", "skills", "Type to Add Skills", "search"),
        at("socialNetworkAccounts", "linkedInAccount", "LinkedIn", "text"),
        at(
          "resumeAttachments",
          "attachments",
          "Upload a file (5MB max)",
          "file",
        ),
      ],
    });
    const of = (ref: string) => plan.entries.find((e) => e.ref === ref);
    // Most recent job first: Acme (current), then Beta.
    expect(of("workExperience-129--jobTitle")).toMatchObject({
      status: "fill",
      value: "Senior Engineer",
    });
    expect(of("workExperience-129--companyName")?.value).toBe("Acme");
    expect(of("workExperience-129--currentlyWorkHere")).toMatchObject({
      status: "fill",
      value: "I currently work here",
    });
    expect(of("workExperience-129--startDate")?.value).toBe("09/2023");
    expect(of("workExperience-129--endDate")?.status).toBe("skip");
    expect(of("workExperience-130--companyName")?.value).toBe("Beta");
    expect(of("workExperience-130--currentlyWorkHere")?.status).toBe("skip");
    expect(of("workExperience-130--startDate")?.value).toBe("01/2020");
    expect(of("workExperience-130--endDate")?.value).toBe("08/2023");
    expect(of("workExperience-131--jobTitle")?.status).toBe("skip");
    // Highest degree first.
    expect(of("education-153--school")?.value).toBe(
      "Some Institute of Technology",
    );
    expect(of("education-153--degree")).toMatchObject({
      status: "fill",
      value: "Bachelor's Degree",
    });
    expect(of("education-153--fieldOfStudy")?.value).toBe("Computer Science");
    expect(of("education-153--lastYearAttended")?.value).toBe("2019");
    expect(of("education-153--gradeAverage")?.status).toBe("skip");
    // Visible skills only, searched one by one.
    expect(of("skills--skills")).toMatchObject({
      status: "fill",
      value: ["React", "TypeScript"],
    });
    expect(of("socialNetworkAccounts--linkedInAccount")?.source).toBe(
      "resume:linkedin",
    );
    expect(of("resumeAttachments--attachments")?.source).toBe(
      "jobops:tailored-pdf",
    );
  });

  it("Walmart's education entry: school typed, degree in Workday's own words", () => {
    const plan = planOf({
      step: "My Experience",
      fields: [
        {
          ...field("schoolName", "School or University", "text", {
            required: true,
          }),
          ref: "education-74--schoolName",
        },
        {
          ...field("degree", "Degree", "dropdown", {
            required: true,
            options: [
              "Certificate",
              "High School",
              "Associates",
              "Bachelors",
              "Masters",
            ],
          }),
          ref: "education-74--degree",
        },
      ],
    });
    expect(plan.entries.map((e) => [e.status, e.value])).toEqual([
      ["fill", "Some Institute of Technology"],
      ["fill", "Bachelors"],
    ]);
  });

  it("My Experience without entries: Add one per job and degree on your resume", () => {
    const page: WorkdayPage = {
      step: "My Experience",
      fields: [],
      sections: [
        { id: "Work-Experience-section", label: "Work Experience", entries: 0 },
        { id: "Education-section", label: "Education", entries: 1 },
        { id: "Certifications-section", label: "Certifications", entries: 0 },
      ],
    };
    expect(entriesToAdd(page, resumeFacts(fakeDesignResume))).toEqual([
      { section: "Work-Experience-section", count: 2 },
      { section: "Education-section", count: 1 },
    ]);
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
    if (t === "good") return { id: "u1", username: "me", isSystemAdmin: true };
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
        field("q18", "Are you comfortable working with Kafka?", "dropdown", {
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
    expect(prompt).toContain("working with Kafka");
    expect(prompt).not.toContain("FINRA");

    const bad = await call("/plans/job-1/page", { step: "x" });
    expect(bad.status).toBe(400);
    // The trail says which part was off.
    expect(bad.body.error.message).toContain("(fields)");
    // Workday's Country dropdown lists ~250 countries (Guidehouse, 2026-10-21).
    const countries = Array.from({ length: 250 }, (_, i) => `Country ${i}`);
    const myInformation: WorkdayPage = {
      step: "My Information",
      fields: [
        {
          ref: "country--country",
          key: "country",
          label: "Country",
          kind: "dropdown",
          required: true,
          options: countries,
        },
      ],
    };
    expect((await call("/plans/job-1/page", myInformation)).status).toBe(200);
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

describe("POST /plans/:jobId/choose", () => {
  it("Claude picks the closest of the choices found; one the form lacks is refused", async () => {
    let reply = { answer: ["Information Systems"], why: "Same field" };
    const create = vi.fn<MessagesApi["create"]>(
      async () =>
        ({
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(reply) }],
          usage: { input_tokens: 500, output_tokens: 20 },
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
    const choose = async (body: unknown) => {
      const res = await fetch(`${base}/plans/job-1/choose`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer good",
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const ask = {
      label: "Field of Study",
      wanted: "Information System Management",
      options: ["Information Systems", "Management", "Computer Science"],
    };
    const picked = await choose(ask);
    expect(picked.status).toBe(200);
    expect(picked.body.data.value).toBe("Information Systems");
    const prompt = String(create.mock.calls[0]?.[0].messages[0]?.content);
    expect(prompt).toContain("Information System Management");
    expect(prompt).toContain("Computer Science");

    // A fact (Field of Study) is matched or broadened, never swapped for what "fits" (J&J:
    // "Accounting and Finance" for an AI/ML degree); no match comes back refused.
    expect(prompt).toContain(
      "never one based on a different part of my resume",
    );
    expect(prompt).not.toContain("fits me best");
    reply = { answer: ["NO MATCH"], why: "Nothing like AI/ML" };
    expect((await choose(ask)).status).toBe(422);

    reply = { answer: ["Information Technology"], why: "Close" };
    expect((await choose(ask)).status).toBe(422);
    expect((await choose({ ...ask, options: [] })).status).toBe(400);

    // Its words found nothing that is it: broader words to search the list for.
    reply = {
      answer: [
        '"Computer Science", Information Technology, Engineering, Data Science, Statistics',
      ],
      why: "Broader fields",
    };
    const terms = await fetch(`${base}/plans/job-1/search-terms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      body: JSON.stringify({
        label: "Field of Study",
        wanted: "Artificial Intelligence and Machine Learning",
      }),
    });
    expect(terms.status).toBe(200);
    expect(((await terms.json()) as any).data.terms).toEqual([
      "Computer Science",
      "Information Technology",
      "Engineering",
      "Data Science",
    ]);

    // A Degree dropdown wording none of its choices like your degree: Claude picks one while
    // the page is planned, and you confirm it.
    reply = { answer: ["Engineering Degree (4 years)"], why: "B.Tech" };
    const res = await fetch(`${base}/plans/job-1/page`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      body: JSON.stringify({
        step: "My Experience",
        fields: [
          {
            ref: "education-1--degree",
            key: "degree",
            label: "Degree",
            kind: "dropdown",
            required: true,
            options: ["Certificate", "Engineering Degree (4 years)", "Diploma"],
          },
        ],
      }),
    });
    const degree = ((await res.json()) as any).data.entries[0];
    expect(degree).toMatchObject({
      status: "fill",
      value: "Engineering Degree (4 years)",
      actionClass: "confirm",
    });
  });
});
