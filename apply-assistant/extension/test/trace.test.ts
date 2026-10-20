// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDom } from "../src/trace/dom";
import {
  type TraceApi,
  type TraceEvent,
  TraceRecorder,
  type TraceSnapshot,
} from "../src/trace/recorder";

function fakeApi(options: { failEvents?: number } = {}) {
  const sent: TraceEvent[][] = [];
  const snapshots: TraceSnapshot[] = [];
  let failures = options.failEvents ?? 0;
  const api: TraceApi = {
    traceEvents: async (events) => {
      if (failures > 0) {
        failures--;
        throw new Error("offline");
      }
      sent.push([...events]);
    },
    traceSnapshot: async (s) => {
      snapshots.push(s);
    },
  };
  return { api, sent, snapshots };
}

afterEach(() => vi.useRealTimers());

describe("TraceRecorder", () => {
  it("batches events, tags them with the run, and sends on a timer", async () => {
    vi.useFakeTimers();
    const { api, sent } = fakeApi();
    const recorder = new TraceRecorder(api, "job-1", { batch: 3 });
    recorder.event("run-started", "Started");
    recorder.setRun("run-1");
    recorder.event("step-start", "Filling Email", {
      stepSeq: 2,
      data: { value: "a@b.c" },
    });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      expect.objectContaining({ runId: null, kind: "run-started" }),
      expect.objectContaining({
        jobId: "job-1",
        runId: "run-1",
        stepSeq: 2,
        source: "extension",
        data: { value: "a@b.c" },
      }),
    ]);
    recorder.event("a", "1");
    recorder.event("b", "2");
    recorder.event("c", "3");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
  });

  it("keeps events when the server is down, drops the oldest past the cap, and says so", async () => {
    const { api, sent } = fakeApi({ failEvents: 1 });
    const recorder = new TraceRecorder(api, "job-1", {
      maxBuffered: 3,
      batch: 100,
    });
    recorder.event("a", "1");
    await recorder.flush();
    expect(sent).toHaveLength(0);
    recorder.event("b", "2");
    recorder.event("c", "3");
    recorder.event("d", "4");
    await recorder.close();
    const kinds = sent.flat().map((e) => e.kind);
    expect(kinds).toEqual(["trace-problem", "b", "c", "d"]);
    expect(sent[0]?.[0]?.message).toMatch(/^1 trace event/);
    recorder.event("late", "ignored after close");
    await recorder.flush();
    expect(sent.flat().map((e) => e.kind)).not.toContain("late");
  });

  it("never sends an empty message, and doesn't retry a batch the server refused", async () => {
    const sent: TraceEvent[][] = [];
    let calls = 0;
    const api: TraceApi = {
      traceEvents: async (events) => {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error("Invalid"), { status: 400 });
        sent.push([...events]);
      },
      traceSnapshot: async () => {},
    };
    const recorder = new TraceRecorder(api, "job-1", { batch: 100 });
    recorder.event("console-error", "   ", { source: "page" });
    await recorder.flush();
    recorder.event("run-ended", "Stopped");
    await recorder.close();
    expect(calls).toBe(2);
    expect(sent.flat().map((e) => [e.kind, e.message])).toEqual([
      [
        "trace-problem",
        "1 trace event(s) were dropped (server unreachable or the batch was refused)",
      ],
      ["run-ended", "Stopped"],
    ]);
    const empty = new TraceRecorder(
      {
        traceEvents: async (e) => void sent.push([...e]),
        traceSnapshot: async () => {},
      },
      "job-2",
    );
    empty.event("console-error", "");
    await empty.close();
    expect(sent.at(-1)?.[0]?.message).toBe("(no message)");
  });

  it("uploads snapshots in order, and turns a failed capture into an event", async () => {
    const { api, sent, snapshots } = fakeApi();
    const recorder = new TraceRecorder(api, "job-1");
    recorder.setRun("run-1");
    void recorder.snapshot("start", async () => ({
      html: "<form></form>",
      screenshot: "/9j/AA==",
      url: "https://x.test/apply",
    }));
    void recorder.snapshot("broken", async () => {
      throw new Error("tab closed");
    });
    await recorder.close();
    expect(snapshots.map((s) => [s.kind, s.reason, s.runId])).toEqual([
      ["dom", "start", "run-1"],
      ["screenshot", "start", "run-1"],
    ]);
    expect(sent.flat()).toEqual([
      expect.objectContaining({
        kind: "trace-problem",
        message: 'Snapshot "broken" failed: tab closed',
      }),
    ]);
  });
});

describe("captureDom", () => {
  it("writes live values into the markup, blanks secrets, and strips scripts and handlers", () => {
    document.body.innerHTML = `
      <script>alert(1)</script><style>p{}</style>
      <form id="f">
        <input name="first" onclick="x()" style="color:red">
        <input name="pw" type="password">
        <input name="otp" autocomplete="one-time-code">
        <input name="ok" type="checkbox">
        <textarea name="why"></textarea>
        <select name="country"><option>India</option><option>Peru</option></select>
        <a href="javascript:void(0)">x</a>
        <img src="https://tracker.example/p.gif">
      </form>`;
    const form = document.getElementById("f") as HTMLFormElement;
    (form.elements.namedItem("first") as HTMLInputElement).value = "Ada";
    (form.elements.namedItem("pw") as HTMLInputElement).value = "hunter2";
    (form.elements.namedItem("otp") as HTMLInputElement).value = "123456";
    (form.elements.namedItem("ok") as HTMLInputElement).checked = true;
    (form.elements.namedItem("why") as HTMLTextAreaElement).value = "Because";
    (form.elements.namedItem("country") as HTMLSelectElement).value = "Peru";

    const { html, trimmed } = captureDom(1_000_000);
    expect(trimmed).toBe(false);
    expect(html).toContain('name="first"');
    expect(html).toContain('value="Ada"');
    expect(html).not.toContain("hunter2");
    expect(html).not.toContain("123456");
    expect(html).toMatch(/name="ok" type="checkbox"[^>]*checked/);
    expect(html).toContain(">Because</textarea>");
    expect(html).toMatch(/<option selected="">Peru<\/option>/);
    expect(html).not.toMatch(/<script|<style|onclick|style=|javascript:/);
    expect(html).toContain('data-src="https://tracker.example/p.gif"');
    expect(html).not.toContain(' src="https://tracker');
    // The live page is untouched.
    expect(document.querySelector("script")).not.toBeNull();
  });

  it("keeps only the forms when the page is too big", () => {
    document.body.innerHTML = `<div>${"x".repeat(5_000)}</div><form><input name="a"></form>`;
    const { html, trimmed } = captureDom(2_000);
    expect(trimmed).toBe(true);
    expect(html.startsWith("<form>")).toBe(true);
  });
});
