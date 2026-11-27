import type { PostApplicationInboxItem } from "@shared/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailViewerList } from "./EmailViewerList";

const item = {
  message: {
    id: "msg-1",
    fromAddress: "no-reply@ashbyhq.com",
    senderName: "Hexa",
    subject: "Your application to Hexa",
    receivedAt: Date.now(),
    snippet: "we don&#39;t think this is the right match ͏ ͏ ͏",
    classificationPayload: { reason: "Polite rejection after review." },
    matchedJobId: "job-1",
    matchConfidence: 90,
    stageTarget: "rejected",
    processingStatus: "pending_user",
  },
  matchedJob: { id: "job-1", title: "Engineer", employer: "Hexa" },
} as unknown as PostApplicationInboxItem;

describe("EmailViewerList", () => {
  it("shows the email preview and what Job Ops proposes", () => {
    render(
      <EmailViewerList
        items={[item]}
        appliedJobs={[]}
        appliedJobByMessageId={{}}
        onAppliedJobChange={() => {}}
        onDecision={() => {}}
        isActionLoading={false}
        isAppliedJobsLoading={false}
      />,
    );
    expect(
      screen.getByText("we don't think this is the right match"),
    ).toBeTruthy();
    expect(screen.getByText("Proposed: rejected")).toBeTruthy();
    expect(screen.getByText(/Polite rejection after review\./)).toBeTruthy();
  });
});
