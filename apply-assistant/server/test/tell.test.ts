import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagesApi } from "../src/claude/answerer.js";
import type { Question } from "../src/claude/questions.js";
import {
  checkTellReply,
  TELL_SYSTEM,
  TellRejectedError,
} from "../src/claude/tell.js";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";
import newrelic from "./fixtures/gh-newrelic.json" with { type: "json" };

/** "Tell agent": one field answered from your instruction, checked against the form. */

const yesNo: Question = {
  ref: "q",
  label: "Willing to work on-site?",
  type: "select",
  options: ["Yes", "No"],
};
const reply = (answer: string[], why = "As you said") =>
  JSON.stringify({ answer, why });

describe("checkTellReply", () => {
  it("returns the form's own choice labels, and refuses choices the form doesn't have", () => {
    expect(checkTellReply(yesNo, reply(["yes"]), "m")).toEqual({
      value: "Yes",
      why: "As you said",
      model: "m",
    });
    expect(() => checkTellReply(yesNo, reply(["Maybe"]), "m")).toThrow(
      TellRejectedError,
    );
    expect(() => checkTellReply(yesNo, reply([]), "m")).toThrow(/no answer/);
    expect(
      checkTellReply(
        { ...yesNo, type: "multiselect", options: ["AWS", "GCP", "Azure"] },
        reply(["aws", "Azure"]),
        "m",
      ).value,
    ).toEqual(["AWS", "Azure"]);
  });

  it("keeps text short for one-line fields", () => {
    const text = { ...yesNo, type: "text" as const, options: [] };
    expect(
      String(checkTellReply(text, reply(["x".repeat(500)]), "m").value),
    ).toHaveLength(300);
  });
});

const job: JobOpsJob = {
  id: "job-1",
  title: "Senior Backend Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://job-boards.greenhouse.io/acme/jobs/11",
  applicationLink: null,
  suitabilityScore: 84,
};

const jobOps: JobOpsApi = {
  login: async () => ({ token: "good", expiresIn: 3600 }),
  me: async (t) => {
    if (t === "good") return { id: "u1", username: "me" };
    throw new JobOpsError(401, "UNAUTHORIZED", "nope");
  },
  listJobs: async () => ({ jobs: [job], total: 1, revision: "r" }),
  getJob: async () => ({
    ...job,
    location: "Bengaluru, India",
    jobDescription: "x",
  }),
  updateJob: async () => {},
  addNote: async () => {},
  markApplied: async () => {},
  skipJob: async () => {},
  getPdf: async () => new Uint8Array(),
  getDesignResume: async () => fakeDesignResume,
};

const message = (text: string) =>
  ({
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 1_000, output_tokens: 100 },
  }) as unknown as Anthropic.Message;

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("POST /plans/:jobId/tell", () => {
  it("proposes a value for one field, records its cost, and says when it can't", async () => {
    let tellAnswer = ["yes"];
    const create = vi.fn<MessagesApi["create"]>(async (params) =>
      params.system === TELL_SYSTEM
        ? message(reply(tellAnswer, "You said you know Python"))
        : message(JSON.stringify({ answers: [] })),
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

    expect(
      (
        await call("/plans/job-1/tell", {
          ref: "question_18992931008",
          instruction: "say yes",
        })
      ).status,
    ).toBe(409);

    await call("/lookups/results", {
      type: "job",
      ats: "greenhouse",
      jobId: "job-1",
      token: "acme",
      postingId: "11",
      url: "https://job-boards.greenhouse.io/acme/jobs/11",
      live: true,
    });
    await call("/lookups/results", {
      type: "schema",
      ats: "greenhouse",
      jobId: "job-1",
      token: "acme",
      postingId: "11",
      payload: { ...structuredClone(newrelic), id: 11 },
    });

    const told = await call("/plans/job-1/tell", {
      ref: "question_18992931008",
      instruction: "say yes, I script in Python daily",
    });
    expect(told.status).toBe(200);
    expect(told.body.data).toMatchObject({
      value: "Yes",
      why: "You said you know Python",
    });
    const sent = create.mock.calls.find((c) => c[0].system === TELL_SYSTEM);
    expect(String(sent?.[0].messages[0]?.content)).toContain(
      "say yes, I script in Python daily",
    );

    tellAnswer = ["Absolutely"];
    const refused = await call("/plans/job-1/tell", {
      ref: "question_18992931008",
      instruction: "say absolutely",
    });
    expect(refused.status).toBe(422);
    expect(
      (await call("/plans/job-1/tell", { ref: "nope", instruction: "x y" }))
        .status,
    ).toBe(409);
    expect(
      (await call("/plans/job-1/tell", { ref: "question_1", instruction: "" }))
        .status,
    ).toBe(400);

    const trail = await (
      await fetch(`${base}/trace/jobs/job-1`, {
        headers: { authorization: "Bearer good" },
      })
    ).json();
    const kinds = (trail as any).data.events.map(
      (e: { kind: string }) => e.kind,
    );
    expect(kinds).toContain("tell-agent");
    expect(kinds).toContain("claude-usage");
  });
});
