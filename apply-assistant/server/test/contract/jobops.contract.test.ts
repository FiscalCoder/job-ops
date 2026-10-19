/**
 * Contract tests against a REAL Job Ops instance. They pin every endpoint and field that
 * apply-assistant relies on, so an upstream change fails here instead of in production.
 * Run after every `git merge origin/main`:
 *
 *   JOBOPS_CONTRACT_URL=https://job-ops.example.com npm run test:contract
 *   (+ JOBOPS_CONTRACT_USER / JOBOPS_CONTRACT_PASSWORD for the signed-in checks)
 *
 * Read-only: nothing is created or changed in Job Ops.
 */
import { describe, expect, it } from "vitest";
import { JobOpsClient, JobOpsError } from "../../src/jobops/client.js";

const url = process.env.JOBOPS_CONTRACT_URL;
const user = process.env.JOBOPS_CONTRACT_USER;
const password = process.env.JOBOPS_CONTRACT_PASSWORD;

describe.skipIf(!url)("Job Ops API contract (unauthenticated)", () => {
  const client = new JobOpsClient(url ?? "");

  it("serves a health endpoint", async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
  });

  it("rejects a missing token on /api/auth/me with the standard error envelope", async () => {
    const error = await client.me("").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobOpsError);
    expect((error as JobOpsError).status).toBe(401);
    expect((error as JobOpsError).code).toMatch(/UNAUTHORIZED/);
  });

  it("rejects wrong credentials on /api/auth/login with 401", async () => {
    const error = await client
      .login("contract-test-no-such-user", "wrong-password")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobOpsError);
    expect((error as JobOpsError).status).toBe(401);
  });
});

describe.skipIf(!url || !user || !password)(
  "Job Ops API contract (signed in, read-only)",
  () => {
    const client = new JobOpsClient(url ?? "");

    it("logs in, resolves the user, and lists Ready jobs in the expected shape", async () => {
      const { token } = await client.login(user ?? "", password ?? "");
      const me = await client.me(token);
      expect(me.username).toBe(user);

      const ready = await client.listJobs(token, ["ready", "discovered"]);
      expect(typeof ready.revision).toBe("string");
      for (const job of ready.jobs.slice(0, 5)) {
        expect(job).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            title: expect.any(String),
            employer: expect.any(String),
            status: expect.any(String),
            jobUrl: expect.any(String),
          }),
        );
      }
    });
  },
);
