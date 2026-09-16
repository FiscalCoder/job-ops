import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyWithSmartRouter } from "./email-router";

const { callJsonMock } = vi.hoisted(() => ({ callJsonMock: vi.fn() }));

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn(async () => "test-model"),
  createConfiguredLlmService: vi.fn(async () => ({
    callJson: callJsonMock,
  })),
}));

const ACTIVE_JOBS = [
  { id: "job-1", company: "ServiceNow", title: "Sr Software Engineer" },
];

function mockRouterResponse(data: Record<string, unknown>) {
  callJsonMock.mockResolvedValueOnce({ success: true, data });
}

describe("classifyWithSmartRouter", () => {
  beforeEach(() => {
    callJsonMock.mockReset();
  });

  it("clamps confidence to 0 when the model returns no job match", async () => {
    mockRouterResponse({
      bestMatchIndex: null,
      confidence: 95,
      stageTarget: "no_change",
      isRelevant: true,
      stageEventPayload: null,
      reason: "Course platform invitation, no application match.",
    });

    const result = await classifyWithSmartRouter({
      emailText: "upGrad live session invitation",
      activeJobs: ACTIVE_JOBS,
    });

    expect(result.bestMatchId).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("keeps the model's confidence when a listed job is matched", async () => {
    mockRouterResponse({
      bestMatchIndex: 1,
      confidence: 88,
      stageTarget: "interview_scheduled",
      isRelevant: true,
      stageEventPayload: null,
      reason: "Interview invite from ServiceNow recruiting.",
    });

    const result = await classifyWithSmartRouter({
      emailText: "Interview scheduling for Sr Software Engineer at ServiceNow",
      activeJobs: ACTIVE_JOBS,
    });

    expect(result.bestMatchId).toBe("job-1");
    expect(result.confidence).toBe(88);
  });

  it("sends strict relevance rules and match-confidence semantics in the prompt", async () => {
    mockRouterResponse({
      bestMatchIndex: null,
      confidence: 0,
      stageTarget: "no_change",
      isRelevant: false,
      stageEventPayload: null,
      reason: "Marketing email.",
    });

    await classifyWithSmartRouter({
      emailText: "Gear up for new referral rewards",
      activeJobs: ACTIVE_JOBS,
    });

    const prompt: string =
      callJsonMock.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "";
    expect(prompt).toContain("job board alerts");
    expect(prompt).toContain("course/learning platforms");
    expect(prompt).toContain("MUST be 0 when bestMatchIndex is null");
    expect(prompt).toContain("When unsure, use isRelevant=false");
    expect(prompt).toContain("ServiceNow: Sr Software Engineer");
  });
});
