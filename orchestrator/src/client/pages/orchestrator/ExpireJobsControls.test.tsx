import { createJob } from "@shared/testing/factories";
import type { JobListItem } from "@shared/types.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canExpire, ExpireSelectedButton } from "./ExpireJobsControls";

const expireJobs = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@client/api/job-liveness", () => ({
  expireJobs: (...args: unknown[]) => expireJobs(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("@/client/lib/error-toast", () => ({
  showErrorToast: (...args: unknown[]) => toastError(...args),
}));

function listItem(id: string, status: JobListItem["status"]): JobListItem {
  return createJob({ id, status }) as unknown as JobListItem;
}

describe("canExpire", () => {
  it("allows only discovered and ready jobs", () => {
    expect(canExpire([])).toBe(false);
    expect(canExpire([{ status: "discovered" }, { status: "ready" }])).toBe(
      true,
    );
    expect(canExpire([{ status: "discovered" }, { status: "applied" }])).toBe(
      false,
    );
    expect(canExpire([{ status: "expired" }])).toBe(false);
  });
});

describe("ExpireSelectedButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is hidden when the selection includes a job that cannot be expired", () => {
    render(
      <ExpireSelectedButton
        selectedJobs={[listItem("a", "discovered"), listItem("b", "applied")]}
        onExpired={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("expires every selected job and reports success", async () => {
    const onExpired = vi.fn();
    expireJobs.mockResolvedValue({
      requested: 2,
      succeeded: 2,
      failed: 0,
      results: [
        { jobId: "a", ok: true },
        { jobId: "b", ok: true },
      ],
    });

    render(
      <ExpireSelectedButton
        selectedJobs={[listItem("a", "discovered"), listItem("b", "ready")]}
        onExpired={onExpired}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expire selected" }));

    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    expect(expireJobs).toHaveBeenCalledWith(["a", "b"]);
    expect(onExpired.mock.calls[0]?.[0]).toEqual(new Set());
    expect(toastSuccess).toHaveBeenCalledWith("2 jobs marked expired");
  });

  it("hands back the jobs that failed", async () => {
    const onExpired = vi.fn();
    expireJobs.mockResolvedValue({
      requested: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { jobId: "a", ok: true },
        { jobId: "b", ok: false, message: "Job not found" },
      ],
    });

    render(
      <ExpireSelectedButton
        selectedJobs={[listItem("a", "discovered"), listItem("b", "ready")]}
        onExpired={onExpired}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expire selected" }));

    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    expect(onExpired.mock.calls[0]?.[0]).toEqual(new Set(["b"]));
    expect(toastError).toHaveBeenCalledWith("1 marked expired, 1 failed.");
  });

  it("surfaces a request failure without calling back", async () => {
    const onExpired = vi.fn();
    expireJobs.mockRejectedValue(new Error("network down"));

    render(
      <ExpireSelectedButton
        selectedJobs={[listItem("a", "discovered")]}
        onExpired={onExpired}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expire selected" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onExpired).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Expire selected" }),
    ).toBeEnabled();
  });
});
