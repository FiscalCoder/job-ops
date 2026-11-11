import { describe, expect, it } from "vitest";
import { fitToLength } from "../src/fill/fit-length";

const ANSWER =
  "I have nearly 7 years as a full-stack engineer working with React, Node.js and Express. " +
  "At Athenahealth I led the migration of 12+ microservices to Kubernetes on AWS EKS. " +
  "I also built the backend services behind a GenAI coding feature.";

describe("fitting an answer to a field's character limit", () => {
  it("leaves a text that fits alone", () => {
    expect(fitToLength("Yes", 10)).toBe("Yes");
    expect(fitToLength(ANSWER, ANSWER.length)).toBe(ANSWER);
    expect(fitToLength(ANSWER, -1)).toBe(ANSWER);
  });

  it("keeps the full sentences that fit (sagaux.com cut it at 280 mid-word)", () => {
    const fitted = fitToLength(ANSWER, 180);
    expect(fitted).toBe(
      "I have nearly 7 years as a full-stack engineer working with React, Node.js and Express. " +
        "At Athenahealth I led the migration of 12+ microservices to Kubernetes on AWS EKS.",
    );
    expect(fitted.length).toBeLessThanOrEqual(180);
  });

  it("cuts at a whole word when no sentence end leaves enough", () => {
    const fitted = fitToLength(ANSWER, 60);
    expect(fitted).toBe("I have nearly 7 years as a full-stack engineer working with");
    expect(fitted.length).toBeLessThanOrEqual(60);
  });

  it("drops a dangling comma and keeps a sentence that ends right at the limit", () => {
    expect(fitToLength("Partly: I built LLM features, with tool calls", 30)).toBe(
      "Partly: I built LLM features",
    );
    expect(fitToLength("Done here. Next part", 10)).toBe("Done here.");
  });

  it("cuts a single long word at the limit", () => {
    expect(fitToLength("Supercalifragilistic", 5)).toBe("Super");
  });
});
