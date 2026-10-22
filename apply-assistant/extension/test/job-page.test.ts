// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readJobText } from "../src/kit/job-page";

/** A job's page as text for Job Ops' import, read as Job Ops' own "fetch from link" reads it. */

describe("readJobText", () => {
  it("title and Open Graph first, then the main content; the page itself is untouched", () => {
    document.head.innerHTML = `
      <title>Senior Engineer - Acme Careers</title>
      <meta property="og:title" content="Senior Engineer">
      <meta property="og:site_name" content="Acme">
      <meta name="description" content="Join Acme's payments team">`;
    document.body.innerHTML = `
      <nav>Home Jobs Login</nav>
      <main><h1>Senior Engineer</h1><p>Build payment rails in Go.</p><script>track()</script></main>
      <footer>© Acme</footer>`;
    const text = readJobText();
    expect(text).toContain("Page Title: Senior Engineer - Acme Careers");
    expect(text).toContain("Job Title: Senior Engineer");
    expect(text).toContain("Company/Site: Acme");
    expect(text).toContain("Description: Join Acme's payments team");
    expect(text).toContain("Senior Engineer\nBuild payment rails in Go.");
    expect(text).not.toMatch(/Home Jobs Login|© Acme|track\(\)/);
    // Read from a copy: nothing removed from the page you see.
    expect(document.querySelector("nav")).not.toBeNull();
    expect(document.querySelector("main script")).not.toBeNull();
  });
});
