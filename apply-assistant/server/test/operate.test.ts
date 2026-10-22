import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagesApi } from "../src/claude/answerer.js";
import { createOperator, MAX_TURNS } from "../src/claude/operate.js";
import { createApp } from "../src/http/app.js";
import { type JobOpsApi, JobOpsError, type JobOpsJob } from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

/**
 * "Let Claude do it": Claude works one field through the computer toolset and the element
 * tool; the server relays its calls, echoes the toolset on results, and enforces the limits.
 */

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
    if (t === "other") return { id: "u2", username: "them" };
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

const shot = { data: "aGVsbG8=", mediaType: "image/jpeg" as const };
const start = {
  label: "Preferred contact",
  wanted: "Email",
  failure: "No choice matching",
  outline: 'e1 button "Preferred contact" value="" box=[10,20,200,30]',
  screenshot: shot,
};

/** Claude's scripted replies, in order. */
const reply = (content: unknown[], stop = "tool_use", tokens = 2_000) =>
  ({
    model: "claude-sonnet-5-5",
    stop_reason: stop,
    content,
    usage: { input_tokens: tokens, output_tokens: 100 },
  }) as unknown as Anthropic.Message;
const click = (id: string) => ({
  type: "tool_use",
  id,
  name: "left_click",
  toolset_name: "computer",
  input: { coordinate: [100, 35] },
});
const element = (id: string) => ({
  type: "tool_use",
  id,
  name: "element",
  input: { action: "pick", text: "Email" },
});

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serve(replies: Anthropic.Message[]) {
  const create = vi.fn<MessagesApi["create"]>(async () => {
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    return next;
  });
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
  const call = async (path: string, body: unknown, token = "good") => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { call, create };
}

describe("Claude operating one field", () => {
  it("relays Claude's actions, returns results with the toolset echoed, and stops when Claude does", async () => {
    const { call, create } = await serve([
      reply([{ type: "text", text: "Opening the list" }, click("t1"), element("t2")]),
      reply([{ type: "text", text: "It shows Email now." }], "end_turn"),
    ]);
    const first = await call("/plans/job-1/operate", start);
    expect(first.status).toBe(200);
    const turn = first.json.data;
    expect(turn.done).toBe(false);
    expect(turn.calls).toEqual([
      { id: "t1", name: "left_click", toolset: "computer", input: { coordinate: [100, 35] } },
      { id: "t2", name: "element", toolset: null, input: { action: "pick", text: "Email" } },
    ]);
    const request = create.mock.calls[0]?.[0];
    expect(request?.model).toBe("claude-sonnet-5-5");
    expect(request?.tools?.[0]).toMatchObject({ type: "computer_toolset_20260801" });
    expect(JSON.stringify(request?.messages[0])).toContain("Set it to: Email");

    // Every call needs its result.
    const partial = await call("/plans/job-1/operate", {
      session: turn.session,
      results: [{ id: "t1", ok: true }],
    });
    expect(partial.status).toBe(409);

    const second = await call("/plans/job-1/operate", {
      session: turn.session,
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: true, screenshot: shot, text: "OK" },
      ],
    });
    expect(second.json.data).toMatchObject({ done: true, why: "It shows Email now.", calls: [] });
    const results = create.mock.calls[1]?.[0].messages[2]?.content as any[];
    expect(results[0]).toMatchObject({ tool_use_id: "t1", toolset_name: "computer", content: "OK" });
    expect(results[1].toolset_name).toBeUndefined();
    expect(results[1].content[0].type).toBe("image");

    // Ended: no more turns on it.
    const after = await call("/plans/job-1/operate", {
      session: turn.session,
      results: [{ id: "t1", ok: true }],
    });
    expect(after.status).toBe(409);
  });

  it("a refused action goes back as an error for Claude to work around", async () => {
    const { call, create } = await serve([
      reply([click("t1")]),
      reply([{ type: "text", text: "Can't." }], "end_turn"),
    ]);
    const { session } = (await call("/plans/job-1/operate", start)).json.data;
    await call("/plans/job-1/operate", {
      session,
      results: [{ id: "t1", ok: false, text: "Refused: that's the Submit button" }],
    });
    const result = (create.mock.calls[1]?.[0].messages[2]?.content as any[])[0];
    expect(result).toMatchObject({ is_error: true, content: "Refused: that's the Submit button" });
  });

  it("someone else can't continue your session, or work your job", async () => {
    const { call } = await serve([reply([click("t1")])]);
    const { session } = (await call("/plans/job-1/operate", start)).json.data;
    const theirs = await call(
      "/plans/job-1/operate",
      { session, results: [{ id: "t1", ok: true }] },
      "other",
    );
    expect(theirs.status).not.toBe(200);
  });

  it("stops unfinished work at the field's cost limit", async () => {
    const operator = createOperator({
      messages: { create: async () => reply([click("t")], "tool_use", 100_000) },
      model: "claude-sonnet-5-5",
    });
    const turn = await operator.start("u1", "job-1", start);
    expect(turn).toMatchObject({ done: true, calls: [] });
    expect(turn.why).toMatch(/field's cost limit/);
  });

  it("stops at the turn limit", async () => {
    const operator = createOperator({
      messages: { create: async () => reply([click("t")]) },
      model: "claude-sonnet-5-5",
    });
    let turn = await operator.start("u1", "job-1", start);
    for (let i = 1; i < MAX_TURNS && !turn.done; i++)
      turn = await operator.next("u1", "job-1", {
        session: turn.session,
        results: [{ id: "t", ok: true, text: "" }],
      });
    expect(turn).toMatchObject({ done: true, why: `Stopped after ${MAX_TURNS} turns` });
  });

  it("stops at the application's budget, and won't start again on that job", async () => {
    // About $0.21 a turn at these token counts.
    const operator = createOperator({
      messages: { create: async () => reply([{ type: "text", text: "done" }], "end_turn", 100_000) },
      model: "claude-sonnet-5-5",
    });
    expect((await operator.start("u1", "job-1", start)).done).toBe(true);
    expect((await operator.start("u1", "job-1", start)).done).toBe(true);
    await expect(operator.start("u1", "job-1", start)).rejects.toThrow(/budget/);
    // Another job has its own.
    expect((await operator.start("u1", "job-2", start)).done).toBe(true);
  });

  it("without Claude for you, says so", async () => {
    const { call } = await serve([]);
    const off = await call("/plans/job-1/operate", start, "other");
    expect(off.status).not.toBe(200);
  });
});
