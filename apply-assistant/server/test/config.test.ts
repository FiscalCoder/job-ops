import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when only the required values are set", () => {
    const config = loadConfig({
      JOBOPS_BASE_URL: "http://job-ops:3001",
      APPLY_DATA_DIR: "/data",
    });
    expect(config).toEqual({
      port: 3006,
      jobOpsBaseUrl: "http://job-ops:3001",
      dataDir: "/data",
      authCacheSeconds: 60,
    });
  });

  it("strips a trailing slash from the Job Ops URL", () => {
    const config = loadConfig({
      JOBOPS_BASE_URL: "http://job-ops:3001/",
      APPLY_DATA_DIR: "/data",
    });
    expect(config.jobOpsBaseUrl).toBe("http://job-ops:3001");
  });

  it("fails fast with a readable message when required values are missing", () => {
    expect(() => loadConfig({})).toThrow(/JOBOPS_BASE_URL/);
  });

  it("rejects a non-numeric port", () => {
    expect(() =>
      loadConfig({
        JOBOPS_BASE_URL: "http://x:1",
        APPLY_DATA_DIR: "/d",
        APPLY_PORT: "abc",
      }),
    ).toThrow(/APPLY_PORT/);
  });
});
