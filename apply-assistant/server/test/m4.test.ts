import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagesApi } from "../src/claude/answerer.js";
import { usageOf } from "../src/claude/pricing.js";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { parseGreenhouseSchema } from "../src/plan/gh-schema.js";
import { normalizeQuestion } from "../src/plan/question-norm.js";
import { computeProgress } from "../src/progress/progress.js";
import { openStore } from "../src/store/db.js";
import type { Run, RunAction } from "../src/store/runs-repo.js";
import type { TraceEvent } from "../src/store/trace-store.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";
import newrelic from "./fixtures/gh-newrelic.json" with { type: "json" };

/** M4 support: Claude cost, remembered answers and the progress targets. */

describe("usageOf", () => {
  it("prices Haiku and Sonnet 5.5 calls, and leaves unknown models unpriced", () => {
    expect(usageOf("claude-haiku-5-5", 1_000, 2_000).cost).toBeCloseTo(0.0011);
    expect(
      usageOf("claude-sonnet-5-5-20261001", 1_000, 1_000).cost,
    ).toBeCloseTo(0.012);
    expect(usageOf("other", 1, 1).cost).toBeNull();
  });
});

describe("normalizeQuestion", () => {
  it("treats the same question at different companies as one", () => {
    expect(normalizeQuestion("How did you hear about GitLab?*", "GitLab")).toBe(
      normalizeQuestion(
        "How did you hear about ElevenLabs? (required)",
        "ElevenLabs",
      ),
    );
    expect(normalizeQuestion("Why  GitLab’s team?", "GitLab")).toBe(
      "why {company} 's team",
    );
  });
});

/** The New Relic form's Yes/No question that goes to Claude (full label from the fixture). */
const QUESTION =
  parseGreenhouseSchema(newrelic).fields.find(
    (f) => f.ref === "question_18992931008",
  )?.label ?? "";

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
  getJob: async (_t, id) => {
    if (id !== job.id) throw new JobOpsError(404, "NOT_FOUND", "Job not found");
    return { ...job, location: "Bengaluru, India", jobDescription: "x" };
  },
  updateJob: async () => {},
  addNote: async () => {},
  markApplied: async () => {},
  skipJob: async () => {},
  getPdf: async () => new Uint8Array(),
  getDesignResume: async () => fakeDesignResume,
};

const mapReply = (answer: string[]) =>
  ({
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          answers: [
            {
              ref: "question_18992931008",
              kind: "answer",
              bank_key: "",
              answer,
              confidence: 0.9,
              why: "Resume",
            },
          ],
        }),
      },
    ],
    usage: { input_tokens: 2_000, output_tokens: 400 },
  }) as unknown as Anthropic.Message;

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
  const create = vi.fn<MessagesApi["create"]>(async () => mapReply(["No"]));
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
  const call = async (path: string, body?: unknown, method?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer good",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  // What the extension would report: the posting, then its form (no plan built yet).
  await call("/lookups/results", {
    type: "job",
    ats: "greenhouse",
    jobId: "job-1",
    token: "acme",
    postingId: "11",
    url: "https://job-boards.greenhouse.io/acme/jobs/11",
    live: true,
  });
  const entryOf = async () =>
    (await call("/plans/job-1")).body.data.entries.find(
      (e: { ref: string }) => e.ref === "question_18992931008",
    );
  const fetchForm = () =>
    call("/lookups/results", {
      type: "schema",
      ats: "greenhouse",
      jobId: "job-1",
      token: "acme",
      postingId: "11",
      payload: { ...structuredClone(newrelic), id: 11 },
    });
  return { call, create, entryOf, fetchForm };
}

const learnYes = {
  jobId: "job-1",
  label: QUESTION,
  type: "select",
  value: "Yes",
  how: "edited",
};

describe("remembered answers", () => {
  it("replace Claude's answer on the next plan, and Forget brings Claude back", async () => {
    const { call, create, entryOf, fetchForm } = await start();
    await fetchForm();
    expect(await entryOf()).toMatchObject({ value: "No" });
    expect(create).toHaveBeenCalledTimes(1);
    const trail = (await call("/trace/jobs/job-1")).body.data.events;
    expect(
      trail.find((e: { kind: string }) => e.kind === "claude-usage"),
    ).toMatchObject({ data: { model: "claude-haiku-5-5", cost: 0.0004 } });

    const saved = await call("/learned", learnYes);
    expect(saved.status).toBe(200);
    expect((await entryOf()).value).toBe("Yes");
    expect((await entryOf()).source).toMatch(
      /^learned: you gave this answer on /,
    );
    expect((await call("/learned")).body.data).toHaveLength(1);

    expect(
      (await call(`/learned/${saved.body.data.id}`, undefined, "DELETE"))
        .status,
    ).toBe(200);
    expect((await entryOf()).value).toBe("No");
    expect((await call("/learned/999", undefined, "DELETE")).status).toBe(404);
  });

  it("aren't sent to Claude, and are ignored when they don't fit the form's choices", async () => {
    const { call, create, entryOf, fetchForm } = await start();
    // What Claude was asked about, across all its calls.
    const asked = () =>
      create.mock.calls
        .map((c) => String(c[0].messages[0]?.content))
        .join("\n");
    await call("/learned", learnYes);
    await fetchForm();
    expect((await entryOf()).value).toBe("Yes");
    // The form's other open question still goes to Claude; the remembered one doesn't.
    expect(asked()).toContain("question_18992930008");
    expect(asked()).not.toContain("question_18992931008");

    await call("/learned", { ...learnYes, value: "Sometimes" });
    expect((await entryOf()).value).toBe("No");
    expect(asked()).toContain("question_18992931008");
  });

  it("validates what it's given", async () => {
    const { call } = await start();
    expect((await call("/learned", { ...learnYes, value: "" })).status).toBe(
      400,
    );
    expect(
      (await call("/learned", { ...learnYes, jobId: "nope" })).status,
    ).toBe(404);
  });
});

describe("computeProgress", () => {
  const run = (patch: Partial<Run>): Run => ({
    id: "r1",
    jobId: "j1",
    startedAt: "2026-10-21 10:00:00",
    endedAt: "2026-10-21 10:02:30",
    outcome: "submitted",
    interventions: 0,
    ...patch,
  });
  const action = (seq: number, patch: Partial<RunAction>): RunAction => ({
    seq,
    actionClass: "auto",
    fieldRef: `f${seq}`,
    valueMasked: null,
    source: "bank:x",
    decision: "approved",
    decidedBy: "countdown",
    result: "filled",
    ...patch,
  });
  let id = 0;
  const event = (patch: Partial<TraceEvent>): TraceEvent => ({
    id: ++id,
    jobId: "j1",
    runId: "r1",
    ts: "2026-10-21T10:00:00Z",
    source: "extension",
    kind: "decision",
    stepSeq: null,
    message: "",
    data: null,
    snapshotId: null,
    ...patch,
  });

  it("measures the plan's targets from submitted runs", () => {
    const progress = computeProgress({
      runs: [run({}), run({ id: "r2", outcome: "aborted" })],
      actionsOf: (runId) =>
        runId === "r1"
          ? [
              action(1, {}),
              action(2, { decision: "edited", decidedBy: "you" }),
              action(3, {
                decision: "edited",
                decidedBy: "you",
                actionClass: "protected",
              }),
              action(4, { decision: "skipped", decidedBy: "you" }),
            ]
          : [],
      eventsOf: () => [
        event({
          stepSeq: 2,
          data: { type: "edit", value: "Yes", planned: "yes " },
        }),
        event({
          stepSeq: 3,
          data: { type: "edit", value: "No", planned: "Yes" },
        }),
        event({ stepSeq: 5, kind: "step-filled" }),
        event({ kind: "claude-usage", runId: null, data: { cost: 0.0012 } }),
        event({ kind: "claude-usage", runId: null, data: { cost: 0.0008 } }),
      ],
      manualApplications: 3,
    });
    expect(progress.applications).toEqual([
      expect.objectContaining({
        runId: "r1",
        steps: 4,
        filledAsPlanned: 2,
        byYou: 2,
        protectedChanged: 1,
        minutes: 2.5,
        missingFromLog: 1,
        cost: 0.002,
      }),
    ]);
    const target = (id: string) => progress.targets.find((t) => t.id === id);
    expect(target("as-planned")).toMatchObject({ value: "50%", met: false });
    expect(target("protected")).toMatchObject({ value: "1", met: false });
    expect(target("time")).toMatchObject({ value: "2.5 min", met: true });
    expect(target("log")).toMatchObject({ value: "1", met: false });
    expect(target("cost")).toMatchObject({ value: "$0.0020", met: true });
    expect(target("applications")).toMatchObject({ value: "1", met: false });
    expect(progress.manualApplications).toBe(3);
  });

  it("counts edits from before planned values were recorded against the fill rate, but not as wrong protected answers", () => {
    const progress = computeProgress({
      runs: [
        run({}),
        // The same job "submitted" again (its confirmation page reopened): one application.
        run({
          id: "r9",
          startedAt: "2026-10-21 11:00:00",
          endedAt: "2026-10-21 11:01:00",
        }),
      ],
      actionsOf: (runId) =>
        runId === "r1"
          ? [
              action(1, { decision: "edited", decidedBy: "you" }),
              action(2, {
                decision: "edited",
                decidedBy: "you",
                actionClass: "protected",
              }),
            ]
          : [],
      eventsOf: () => [
        event({ stepSeq: 1, data: { type: "edit", value: "x" } }),
        event({ stepSeq: 2, data: { type: "edit", value: "No" } }),
      ],
      manualApplications: 0,
    });
    expect(progress.applications).toHaveLength(1);
    expect(progress.applications[0]).toMatchObject({
      runId: "r1",
      byYou: 2,
      protectedChanged: 0,
    });
    const empty = computeProgress({
      runs: [],
      actionsOf: () => [],
      eventsOf: () => [],
      manualApplications: 0,
    });
    expect(empty.targets.find((t) => t.id === "protected")?.met).toBeNull();
  });

  it("is served at /progress", async () => {
    const { call } = await start();
    const { body } = await call("/progress");
    expect(body.data).toMatchObject({
      applications: [],
      manualApplications: 0,
    });
    expect(body.data.targets).toHaveLength(6);
  });
});
