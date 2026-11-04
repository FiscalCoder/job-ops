import { describe, expect, it, vi } from "vitest";
import { checkWithAtsApi, probeFor, type ReadApi } from "./ats-api";

const answering = (status: number, body = ""): ReadApi =>
  vi.fn(async () => ({ status, body }));

describe("asking the posting's ATS first", () => {
  it("builds each ATS's API request from the posting link", () => {
    expect(probeFor("https://boards.greenhouse.io/acme/jobs/4000001")?.api).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4000001",
    );
    expect(
      probeFor("https://jobs.lever.co/acme/3f2504e0-4f89-11d3-9a0c-0305e82c3301")?.api,
    ).toBe("https://api.lever.co/v0/postings/acme/3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(
      probeFor("https://jobs.smartrecruiters.com/Acme/744000159536960-engineer")?.api,
    ).toBe("https://api.smartrecruiters.com/v1/companies/Acme/postings/744000159536960");
    expect(
      probeFor("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Pune/Engineer_R-123")?.api,
    ).toBe("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/job/Pune/Engineer_R-123");
    expect(probeFor("https://acme.com/careers/42")).toBeNull();
    expect(probeFor("https://www.linkedin.com/jobs/view/3999999999")).toBeNull();
  });

  it("only a plain answer counts: listed is live, gone is closed, anything else unsure", async () => {
    const link = ["https://boards.greenhouse.io/acme/jobs/4000001"];
    expect(await checkWithAtsApi(link, 1000, answering(200))).toMatchObject({ state: "live" });
    expect(await checkWithAtsApi(link, 1000, answering(404))).toMatchObject({ state: "closed" });
    expect(await checkWithAtsApi(link, 1000, answering(429))).toBeNull();
    expect(await checkWithAtsApi(link, 1000, answering(500))).toBeNull();
    const failing: ReadApi = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await checkWithAtsApi(link, 1000, failing)).toBeNull();
  });

  it("a LinkedIn job is answered for by its ATS link", async () => {
    const read = answering(404);
    expect(
      await checkWithAtsApi(
        ["https://www.linkedin.com/jobs/view/3999999999", "https://jobs.lever.co/acme/3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
        1000,
        read,
      ),
    ).toMatchObject({ state: "closed", reason: "Lever no longer lists the posting" });
    expect(read).toHaveBeenCalledOnce();
  });

  it("Workday: a withdrawn code is closed; a 403 without it is unsure", async () => {
    const link = ["https://acme.wd5.myworkdayjobs.com/careers/job/Pune/Engineer_R-1"];
    expect(
      await checkWithAtsApi(link, 1000, answering(403, '{"errorCode":"S22"}')),
    ).toMatchObject({ state: "closed" });
    expect(await checkWithAtsApi(link, 1000, answering(403, "blocked"))).toBeNull();
    expect(
      await checkWithAtsApi(link, 1000, answering(200, '{"jobPostingInfo":{}}')),
    ).toMatchObject({ state: "live" });
  });

  it("Ashby: on the board's feed or not; a feed it can't read is unsure", async () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const link = [`https://jobs.ashbyhq.com/acme/${id}`];
    expect(
      await checkWithAtsApi(link, 1000, answering(200, JSON.stringify({ jobs: [{ id }] }))),
    ).toMatchObject({ state: "live" });
    expect(
      await checkWithAtsApi(link, 1000, answering(200, JSON.stringify({ jobs: [] }))),
    ).toMatchObject({ state: "closed" });
    expect(await checkWithAtsApi(link, 1000, answering(200, "<html>"))).toBeNull();
  });
});
