import { describe, expect, it, vi } from "vitest";
import {
  mapRemoteOkJob,
  matchesRemoteOkLocation,
  matchesRemoteOkSearchTerm,
  runRemoteOk,
} from "../src/run";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("RemoteOK extractor", () => {
  it("skips the legal-notice element", () => {
    expect(
      mapRemoteOkJob({ legal: "API terms", last_updated: 123 }),
    ).toBeNull();
  });

  it("maps RemoteOK fields into a normalized job", () => {
    expect(
      mapRemoteOkJob({
        id: "1137092",
        slug: "senior-go-engineer-acme",
        position: "Senior Go Engineer",
        company: "Acme",
        tags: ["go", "postgresql"],
        description: "<p>Build things</p>",
        location: "Worldwide, ",
        url: "https://remoteok.com/remote-jobs/senior-go-engineer-acme",
        date: "2026-06-18T00:00:00+00:00",
        salary_min: 90000,
        salary_max: 130000,
        company_logo: "https://remoteok.com/logo.png",
      }),
    ).toEqual(
      expect.objectContaining({
        source: "remoteok",
        sourceJobId: "1137092",
        title: "Senior Go Engineer",
        employer: "Acme",
        jobUrl: "https://remoteok.com/remote-jobs/senior-go-engineer-acme",
        applicationLink:
          "https://remoteok.com/remote-jobs/senior-go-engineer-acme",
        location: "Worldwide",
        jobDescription: "<p>Build things</p>",
        datePosted: "2026-06-18T00:00:00+00:00",
        salaryMinAmount: 90000,
        salaryMaxAmount: 130000,
        skills: "go, postgresql",
        companyLogo: "https://remoteok.com/logo.png",
        isRemote: true,
      }),
    );
  });

  it("treats a zero salary as unset", () => {
    const job = mapRemoteOkJob({
      id: "1",
      position: "Electrical Tradesperson",
      company: "Acme",
      url: "https://remoteok.com/remote-jobs/1",
      salary_min: 0,
      salary_max: 0,
    });
    expect(job?.salaryMinAmount).toBeUndefined();
    expect(job?.salaryMaxAmount).toBeUndefined();
  });

  it("returns null when required fields are missing", () => {
    expect(mapRemoteOkJob({ position: "No company or URL" })).toBeNull();
  });

  describe("matchesRemoteOkSearchTerm", () => {
    it("matches on title, description, or skills", () => {
      const job = {
        title: "Senior Go Engineer",
        jobDescription: "Build distributed systems",
        skills: "go, postgresql",
      };
      expect(matchesRemoteOkSearchTerm(job, "go engineer")).toBe(true);
      expect(matchesRemoteOkSearchTerm(job, "distributed")).toBe(true);
      expect(matchesRemoteOkSearchTerm(job, "postgresql")).toBe(true);
      expect(matchesRemoteOkSearchTerm(job, "frontend designer")).toBe(false);
    });
  });

  describe("matchesRemoteOkLocation", () => {
    it("matches blank locations and worldwide/unset country", () => {
      expect(matchesRemoteOkLocation(undefined, "germany")).toBe(true);
      expect(matchesRemoteOkLocation("Worldwide", "germany")).toBe(true);
      expect(matchesRemoteOkLocation("USA", undefined)).toBe(true);
    });

    it("rejects a location tied to a different country", () => {
      expect(matchesRemoteOkLocation("Berlin, Germany", "united states")).toBe(
        false,
      );
    });
  });

  it("fetches the feed once and reuses it across search terms", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { legal: "notice" },
        {
          id: "1",
          position: "Backend Engineer",
          company: "Acme",
          url: "https://remoteok.com/remote-jobs/1",
        },
      ]),
    );

    const result = await runRemoteOk({
      searchTerms: ["backend", "engineer"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBeTruthy();
  });

  it("skips the source entirely when hybrid/onsite is requested without remote", async () => {
    const fetchMock = vi.fn();
    const result = await runRemoteOk({
      workplaceTypes: ["hybrid", "onsite"],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a status-only error for failed upstream requests", async () => {
    const result = await runRemoteOk({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 403)),
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "RemoteOK request failed with status 403",
    });
  });
});
