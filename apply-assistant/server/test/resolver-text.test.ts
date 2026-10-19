import { describe, expect, it } from "vitest";
import {
  descriptionSimilarity,
  employerKey,
  htmlToText,
  titleScore,
} from "../src/resolver/text.js";

describe("titleScore", () => {
  it("is 1 for the same title with different punctuation and case", () => {
    expect(
      titleScore(
        "Senior Software Engineer - Backend",
        "senior software engineer, backend",
      ),
    ).toBe(1);
  });

  it("treats Sr./Sr as Senior", () => {
    expect(
      titleScore(
        "Sr. Software Engineer (Integrations)",
        "Senior Software Engineer, Integrations",
      ),
    ).toBe(1);
  });

  it("scores partial overlap below 1 and unrelated titles near 0", () => {
    const partial = titleScore(
      "Senior Full Stack Developer",
      "Senior Backend Developer",
    );
    expect(partial).toBeGreaterThan(0.3);
    expect(partial).toBeLessThan(0.8);
    expect(titleScore("Data Scientist", "Account Executive")).toBe(0);
  });

  it("keeps level markers like II / III meaningful", () => {
    expect(
      titleScore("Software Engineer II", "Software Engineer III"),
    ).toBeLessThan(1);
  });
});

describe("employerKey", () => {
  it("normalises legal suffixes and punctuation", () => {
    expect(employerKey("Veeam Software, Inc.")).toBe(
      employerKey("veeam software"),
    );
    expect(employerKey("Broadridge India Pvt. Ltd.")).toBe("broadridge");
    expect(employerKey("Schrödinger")).toBe("schrodinger");
  });
});

describe("htmlToText", () => {
  it("decodes escaped HTML (as the Greenhouse API returns it) and strips tags", () => {
    expect(
      htmlToText(
        "&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;",
      ),
    ).toBe("Build & ship Go");
  });
});

describe("descriptionSimilarity", () => {
  const base =
    "We are looking for a senior backend engineer to design and build scalable services in Go and Kubernetes. " +
    "You will own APIs, mentor engineers, and work closely with product to ship reliable features for our customers.";

  it("is high for the same posting with boilerplate differences", () => {
    const variant = `About us: we love data. ${base} Benefits: health insurance and remote work.`;
    expect(descriptionSimilarity(base, variant)).toBeGreaterThan(0.55);
  });

  it("is low for a different role at the same company", () => {
    const other =
      "We are hiring an account executive to grow enterprise revenue, manage a pipeline of prospects, " +
      "negotiate contracts and partner with marketing on campaigns across the region.";
    expect(descriptionSimilarity(base, other)).toBeLessThan(0.15);
  });

  it("is 0 when either side is empty", () => {
    expect(descriptionSimilarity("", base)).toBe(0);
  });
});
