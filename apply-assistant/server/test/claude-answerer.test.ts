import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeAnswerer,
  type MessagesApi,
} from "../src/claude/answerer.js";
import type { Question, QuestionContext } from "../src/claude/questions.js";
import { resumeFacts } from "../src/plan/resume-facts.js";
import { createClaudeAnswersRepo } from "../src/store/claude-answers-repo.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "./fixtures/fake-resume.js";

const context: QuestionContext = {
  job: { title: "Engineer", employer: "Acme", description: null },
  resume: resumeFacts(fakeDesignResume),
  bank: new Map(),
};
const yesNo: Question = {
  ref: "q1",
  label: "Python?",
  type: "select",
  options: ["Yes", "No"],
};
const why: Question = {
  ref: "q2",
  label: "Why Acme?",
  type: "textarea",
  options: [],
};

const reply = (
  text: string,
  stop: Anthropic.Message["stop_reason"] = "end_turn",
): Anthropic.Message =>
  ({
    model: "fake",
    stop_reason: stop,
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as unknown as Anthropic.Message;

const mapReply = (answers: object[]) => reply(JSON.stringify({ answers }));
const answer = (patch: object) => ({
  ref: "q1",
  kind: "answer",
  bank_key: "",
  answer: ["Yes"],
  confidence: 0.9,
  why: "Resume shows Python",
  ...patch,
});

function setup(...replies: Anthropic.Message[]) {
  const create = vi.fn<MessagesApi["create"]>();
  for (const r of replies) create.mockResolvedValueOnce(r);
  const answerer = createClaudeAnswerer({
    messages: { create },
    cache: createClaudeAnswersRepo(openStore(":memory:")),
    mapModel: "claude-haiku-5-5",
    draftModel: "claude-sonnet-5-5",
  });
  return { create, answerer };
}

describe("Claude answerer", () => {
  it("maps all questions in one call, drafts written ones, and caches both", async () => {
    const { create, answerer } = setup(
      mapReply([answer({}), answer({ ref: "q2", kind: "write", answer: [] })]),
      reply("I like building APIs."),
    );
    const first = await answerer.answer([yesNo, why], context);
    expect(first.get("q1")).toMatchObject({ kind: "answer", value: "Yes" });
    expect(first.get("q2")).toEqual({
      kind: "draft",
      value: "I like building APIs.",
      model: "claude-sonnet-5-5",
    });
    expect(create).toHaveBeenCalledTimes(2);
    const mapCall = create.mock.calls[0]?.[0];
    expect(mapCall).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      model: "claude-sonnet-5-5",
    });

    const again = await answerer.answer([yesNo, why], context);
    expect(again).toEqual(first);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("only asks about questions that aren't cached", async () => {
    const { create, answerer } = setup(
      mapReply([answer({})]),
      mapReply([answer({ ref: "q3", answer: ["No"] })]),
    );
    await answerer.answer([yesNo], context);
    const q3 = { ...yesNo, ref: "q3", label: "Go?" };
    const both = await answerer.answer([yesNo, q3], context);
    expect(both.get("q3")).toMatchObject({ value: "No" });
    expect(create.mock.calls[1]?.[0].messages[0]?.content).not.toContain(
      'ref="q1"',
    );
  });

  it("turns a refusal into 'unknown' without caching it", async () => {
    const { create, answerer } = setup(
      reply("", "refusal"),
      mapReply([answer({})]),
    );
    expect((await answerer.answer([yesNo], context)).get("q1")).toMatchObject({
      kind: "unknown",
      why: "Claude declined to answer",
    });
    expect((await answerer.answer([yesNo], context)).get("q1")).toMatchObject({
      kind: "answer",
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails loudly on a cut-off or malformed reply (the plan then asks you)", async () => {
    await expect(
      setup(reply("{", "max_tokens")).answerer.answer([yesNo], context),
    ).rejects.toThrow("cut off");
    await expect(
      setup(reply("nope")).answerer.answer([yesNo], context),
    ).rejects.toThrow();
  });

  it("makes no call when there are no questions", async () => {
    const { create, answerer } = setup();
    expect((await answerer.answer([], context)).size).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});
