import { describe, expect, it } from "vitest";
import { factSources, unverifiedFacts } from "../src/claude/fact-guard.js";

const sources = factSources([
  "Backend Engineer at Acme Corp (2021-03 to present): built Kafka pipelines handling 4,000 events a second.",
  "Total professional experience: 4 years 8 months",
  "Job: Platform Engineer at Globex. We use Kubernetes and AWS.",
]);

describe("fact guard", () => {
  it("passes claims the sources back, however they're written", () => {
    expect(
      unverifiedFacts(
        "At Acme I built Kafka pipelines for 4000 events a second over four years, and I'd enjoy Kubernetes on AWS at Globex.",
        sources,
      ),
    ).toEqual([]);
  });

  it("flags names, numbers and credentials the sources don't have", () => {
    expect(
      unverifiedFacts(
        "I led a team of 12 at Initech, cut costs by 30%, and I'm AWS certified with a PMP.",
        sources,
      ),
    ).toEqual(["Initech", "PMP", "12", "30%", "certified"]);
  });

  it("ignores sentence-start capitals, months and small number words", () => {
    expect(
      unverifiedFacts(
        "Since March I have been one of the people on call.",
        sources,
      ),
    ).toEqual([]);
  });
});
