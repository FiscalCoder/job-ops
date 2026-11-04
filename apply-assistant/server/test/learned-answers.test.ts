import { describe, expect, it } from "vitest";
import { openStore } from "../src/store/db.js";
import { createLearnedAnswersRepo } from "../src/store/learned-answers-repo.js";
import { runAsUser } from "../src/store/owner.js";

const answer = (how: "edited" | "typed" | "accepted", value: string) => ({
  questionNorm: "open to relocation",
  label: "Are you open to relocation?",
  fieldType: "select",
  value,
  how,
  jobId: "job-1",
});

describe("remembered answers", () => {
  it("one of Claude's you kept never replaces an answer you gave yourself", () => {
    const repo = createLearnedAnswersRepo(openStore(":memory:"));
    runAsUser("u1", () => {
      repo.save(answer("edited", "No"));
      expect(repo.save(answer("accepted", "Yes"))).toMatchObject({ how: "edited", value: "No" });
    });
  });

  it("your own answer replaces a kept one, and a newer kept one replaces an older", () => {
    const repo = createLearnedAnswersRepo(openStore(":memory:"));
    runAsUser("u1", () => {
      repo.save(answer("accepted", "Yes"));
      expect(repo.save(answer("accepted", "Maybe"))).toMatchObject({ value: "Maybe" });
      expect(repo.save(answer("typed", "No"))).toMatchObject({ how: "typed", value: "No" });
    });
  });
});
