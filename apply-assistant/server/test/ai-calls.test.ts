import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";
import { afterAll, describe, expect, it } from "vitest";
import {
  aiJobContext,
  currentAiContext,
  withAiJob,
  withAiPurpose,
} from "../src/claude/ai-context.js";
import type { MessagesApi } from "../src/claude/answerer.js";
import { loggedMessages } from "../src/claude/logged-messages.js";
import { createAiCallStore } from "../src/store/ai-call-store.js";
import { createAppliedCleanup } from "../src/store/applied-cleanup.js";
import { openStore } from "../src/store/db.js";
import { runAsUser } from "../src/store/owner.js";
import { createTraceStore } from "../src/store/trace-store.js";

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString("base64");
const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-calls-test-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const request = (text: string, withImage = false): Anthropic.MessageCreateParamsNonStreaming => ({
  model: "claude-haiku-5-5",
  max_tokens: 100,
  messages: [
    {
      role: "user",
      content: withImage
        ? [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_B64 } },
            { type: "text", text },
          ]
        : text,
    },
  ],
});

const reply = (text: string): Anthropic.Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) as unknown as Anthropic.Message;

function setup(start = new Date("2026-11-11T10:00:00Z")) {
  const db = openStore(":memory:");
  const dir = tempDir();
  let clock = start;
  const now = () => clock;
  const calls = createAiCallStore({ db, dir, now });
  const trace = createTraceStore({ db, dir: tempDir(), now });
  return {
    db,
    dir,
    calls,
    trace,
    advance: (days: number) => {
      clock = new Date(clock.getTime() + days * 86_400_000);
    },
  };
}

describe("ai context", () => {
  it("carries the job from the request and the purpose from the caller", () => {
    withAiJob({ jobId: "j1", runId: "r1" }, () =>
      withAiJob({ label: "Phone" }, () =>
        withAiPurpose("draft-answer", () => {
          expect(currentAiContext()).toEqual({
            jobId: "j1",
            runId: "r1",
            label: "Phone",
            purpose: "draft-answer",
          });
        }),
      ),
    );
    expect(currentAiContext()).toEqual({ purpose: "unknown" });
  });

  it("reads the job, run, step and field from a per-job request", () => {
    const req = {
      params: { jobId: "j9" },
      query: {},
      body: { runId: "r9", stepSeq: 4, turn: { label: "  Notice period " } },
    } as unknown as Request;
    let seen: unknown = null;
    aiJobContext(req, {} as Response, () => {
      seen = currentAiContext();
    });
    expect(seen).toEqual({ jobId: "j9", runId: "r9", stepSeq: 4, label: "Notice period", purpose: "unknown" });
  });
});

describe("logged Claude calls", () => {
  it("logs a call end to end, images saved once and left out of the payload", async () => {
    const { calls, dir } = setup();
    const inner: MessagesApi = { create: async () => reply("Yes") };
    const messages = loggedMessages(inner, calls, (() => {
      let t = 0;
      return () => (t += 250);
    })());

    await runAsUser("u1", () =>
      withAiJob({ jobId: "j1", runId: "r1", label: "Work permit" }, () =>
        withAiPurpose("deep-read", async () => {
          await messages.create(request("first", true));
          await messages.create(request("second", true));
        }),
      ),
    );

    runAsUser("u1", () => {
      const logged = calls.callsOfJob("j1");
      expect(logged).toHaveLength(2);
      expect(logged[0]).toMatchObject({
        runId: "r1",
        label: "Work permit",
        purpose: "deep-read",
        model: "claude-haiku-5-5",
        inputTokens: 1000,
        outputTokens: 10,
        durationMs: 250,
        stopReason: "end_turn",
        error: null,
        hasPayload: true,
      });
      const payload = calls.readPayload(logged[0]?.id ?? "") as {
        request: { messages: { content: { type: string; source?: { file?: string; data?: string } }[] }[] };
        response: { content: { text: string }[] };
      };
      const image = payload.request.messages[0]?.content[0]?.source;
      expect(image?.data).toBeUndefined();
      expect(image?.file).toMatch(/^img-[0-9a-f]{32}\.jpg$/);
      expect(payload.response.content[0]?.text).toBe("Yes");
    });
    // Two calls with the same screenshot: one image file, two payloads.
    expect(readdirSync(dir).filter((f) => f.startsWith("img-"))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json.gz"))).toHaveLength(2);
  });

  it("logs a failed call and still throws its error", async () => {
    const { calls } = setup();
    const messages = loggedMessages(
      { create: () => Promise.reject(new Error("overloaded")) },
      calls,
    );
    await expect(
      runAsUser("u1", () =>
        withAiJob({ jobId: "j1" }, () => withAiPurpose("operate", () => messages.create(request("x")))),
      ),
    ).rejects.toThrow("overloaded");
    runAsUser("u1", () => {
      const [call] = calls.callsOfJob("j1");
      expect(call).toMatchObject({ purpose: "operate", error: "Error: overloaded", inputTokens: null });
      expect(calls.readPayload(call?.id ?? "")).toMatchObject({ error: "Error: overloaded", response: null });
    });
  });

  it("drops send-and-replies after 90 days and rows after a year", () => {
    const { calls, dir, advance } = setup();
    runAsUser("u1", () => {
      calls.record({
        context: { jobId: "j1", purpose: "tell" },
        model: "m",
        request: request("x", true),
        durationMs: 5,
      });
    });
    advance(91);
    expect(calls.prune()).toEqual({ payloads: 1, rows: 0 });
    expect(readdirSync(dir)).toEqual([]);
    runAsUser("u1", () => expect(calls.callsOfJob("j1")[0]?.hasPayload).toBe(false));
    advance(275);
    expect(calls.prune()).toEqual({ payloads: 0, rows: 1 });
  });
});

describe("applied clean-up", () => {
  const seed = (s: ReturnType<typeof setup>) =>
    runAsUser("u1", () => {
      s.trace.saveSnapshot({ jobId: "j1", kind: "screenshot", reason: "start", content: Buffer.from(JPEG_B64, "base64") });
      s.trace.record({ jobId: "j1", kind: "step-failed", message: "Notice period: Claude couldn't set it" });
      const log = (purpose: "draft-answer" | "operate" | "page-map", label?: string, error?: string) =>
        s.calls.record({
          context: { jobId: "j1", purpose, ...(label ? { label } : {}) },
          model: "m",
          request: request(purpose),
          ...(error ? { error } : {}),
          durationMs: 1,
        });
      return {
        fine: log("draft-answer", "Phone number"),
        wrongField: log("draft-answer", "Notice period"),
        rescue: log("operate", "Some field"),
        pageLevel: log("page-map"),
        failed: log("page-map", undefined, "Error: timeout"),
      };
    });

  it("deletes snapshots and the payloads of calls that went fine, keeps the rest", () => {
    const s = setup();
    const ids = seed(s);
    const cleanup = createAppliedCleanup({ db: s.db, trace: s.trace, aiCalls: s.calls });
    expect(cleanup.onApplied("u1", "j1")).toEqual({ snapshots: 1, payloads: 2 });
    runAsUser("u1", () => {
      expect(s.trace.snapshots("j1")).toEqual([]);
      const kept = Object.fromEntries(s.calls.callsOfJob("j1").map((c) => [c.id, c.hasPayload]));
      expect(kept).toEqual({
        [ids.fine ?? ""]: false,
        [ids.wrongField ?? ""]: true,
        [ids.rescue ?? ""]: true,
        [ids.pageLevel ?? ""]: false,
        [ids.failed ?? ""]: true,
      });
      // The text trace stays.
      expect(s.trace.events("j1").length).toBeGreaterThan(0);
    });
  });

  it("backfills jobs this server already knows are applied", () => {
    const s = setup();
    seed(s);
    s.db
      .prepare(
        "insert into runs (id, job_id, started_at, ended_at, outcome, interventions, model_cost, user_id) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("r1", "j1", "2026-11-11T09:00:00Z", "2026-11-11T09:10:00Z", "submitted", 0, 0, "u1");
    const cleanup = createAppliedCleanup({ db: s.db, trace: s.trace, aiCalls: s.calls });
    expect(cleanup.backfill()).toBe(1);
    expect(cleanup.backfill()).toBe(0);
  });

  it("sweeps jobs Job Ops has as applied, at most every few hours per user", async () => {
    const s = setup();
    seed(s);
    let asked = 0;
    let clock = 0;
    const cleanup = createAppliedCleanup({
      db: s.db,
      trace: s.trace,
      aiCalls: s.calls,
      now: () => clock,
      sweepEveryMs: 1000,
      jobOps: {
        listJobs: async (_token, statuses) => {
          asked++;
          expect(statuses).toEqual(["applied", "in_progress"]);
          return { jobs: [{ id: "j1" }, { id: "other" }] as never, total: 2, revision: "x" };
        },
      },
    });
    expect(await cleanup.sweep("u1", "token")).toBe(1);
    expect(await cleanup.sweep("u1", "token")).toBe(0);
    clock = 2000;
    // Nothing left to clean: Job Ops isn't asked.
    expect(await cleanup.sweep("u1", "token")).toBe(0);
    expect(asked).toBe(1);
    expect(existsSync(s.dir)).toBe(true);
  });
});
