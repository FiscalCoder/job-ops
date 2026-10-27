import { describe, expect, it } from "vitest";
import { resolveStartupJobEmployer } from "../src/employer";

describe("resolveStartupJobEmployer", () => {
  it("keeps a real company name", () => {
    expect(
      resolveStartupJobEmployer({
        employer: " Example Startup ",
        jobUrl: "https://startup.jobs/engineer-example-startup-1",
        title: "Engineer",
      }),
    ).toBe("Example Startup");
  });

  it("reads the company from the listing address when the page gave the link's text", () => {
    expect(
      resolveStartupJobEmployer({
        employer: "View company profile",
        employerUrl: "https://lyric.tech/",
        jobUrl: "https://startup.jobs/platform-engineer-backend-lyric-10356394",
        title: "Platform Engineer - Backend",
      }),
    ).toBe("Lyric");
    expect(
      resolveStartupJobEmployer({
        employer: "View company profile",
        jobUrl:
          "https://startup.jobs/full-stack-developer-ii-java-react-guidewire-software-solutions-10324594",
        title: "Full Stack Developer II (Java / React)",
      }),
    ).toBe("Guidewire Software Solutions");
  });

  it("drops a repeat-posting counter after the company", () => {
    expect(
      resolveStartupJobEmployer({
        employer: "View company profile",
        jobUrl: "https://startup.jobs/backend-engineer-motive-2-10573923",
        title: "Backend Engineer",
      }),
    ).toBe("Motive");
  });

  it("prefers the startup.jobs company link", () => {
    expect(
      resolveStartupJobEmployer({
        employer: "View company profile",
        employerUrl: "https://startup.jobs/company/omnissa-llc",
        jobUrl: "https://startup.jobs/something-else-10142244",
        title: "Senior Member of Technical Staff",
      }),
    ).toBe("Omnissa Llc");
  });

  it("falls back to Unknown Employer when nothing names the company", () => {
    expect(
      resolveStartupJobEmployer({
        employer: "",
        jobUrl: "https://startup.jobs/abc-123",
        title: "Engineer",
      }),
    ).toBe("Unknown Employer");
  });
});
