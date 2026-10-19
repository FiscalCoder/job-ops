import { describe, expect, it } from "vitest";
import { JobOpsClient, JobOpsError } from "../src/jobops/client.js";

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const BASE = "http://job-ops:3001";

describe("JobOpsClient", () => {
  it("logs in and returns the token", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ ok: true, data: { token: "t1", expiresIn: 3600 } }),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    await expect(client.login("me", "pw")).resolves.toEqual({
      token: "t1",
      expiresIn: 3600,
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/auth/login`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      username: "me",
      password: "pw",
    });
  });

  it("returns the current user for a token and sends it as a bearer header", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        ok: true,
        data: { user: { id: "u1", username: "me", isSystemAdmin: true } },
      }),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    await expect(client.me("tok")).resolves.toEqual({
      id: "u1",
      username: "me",
    });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer tok",
    );
  });

  it("lists jobs by status", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        ok: true,
        data: {
          jobs: [
            {
              id: "j1",
              title: "SE",
              employer: "Acme",
              status: "ready",
              jobUrl: "https://x",
              applicationLink: null,
              suitabilityScore: 81,
            },
          ],
          total: 1,
          revision: "r1",
        },
      }),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    const result = await client.listJobs("tok", ["ready"]);
    expect(calls[0]?.url).toBe(`${BASE}/api/jobs?status=ready&view=list`);
    expect(result.revision).toBe("r1");
    expect(result.jobs[0]).toMatchObject({
      id: "j1",
      employer: "Acme",
      status: "ready",
      suitabilityScore: 81,
    });
  });

  it("patches the application link and status", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ ok: true, data: { id: "j1" } }),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    await client.updateJob("tok", "j1", {
      applicationLink: "https://job-boards.greenhouse.io/a/jobs/1",
      status: "applied",
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/jobs/j1`);
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      applicationLink: "https://job-boards.greenhouse.io/a/jobs/1",
      status: "applied",
    });
  });

  it("adds a note", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ ok: true, data: { id: "n1" } }, 201),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    await client.addNote("tok", "j1", {
      title: "Matched on Greenhouse",
      content: "board acme",
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/jobs/j1/notes`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      title: "Matched on Greenhouse",
      content: "board acme",
    });
  });

  it("downloads the tailored PDF as bytes", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.5 test");
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    const pdf = await client.getPdf("tok", "j1");
    expect(calls[0]?.url).toBe(`${BASE}/api/jobs/j1/pdf`);
    expect(new TextDecoder().decode(pdf)).toBe("%PDF-1.5 test");
  });

  it("turns an error envelope into a JobOpsError with the status and message", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        },
        401,
      ),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    const error = await client.me("bad").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobOpsError);
    expect(error).toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  });

  it("rejects a response that doesn't match the expected shape", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ ok: true, data: { nope: true } }),
    );
    const client = new JobOpsClient(BASE, fetchImpl);
    await expect(client.login("me", "pw")).rejects.toThrow(JobOpsError);
  });
});
