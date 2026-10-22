import { describe, expect, it } from "vitest";
import type { FillPlan } from "../src/plan/planner.js";
import { openStore } from "../src/store/db.js";
import { runAsUser } from "../src/store/owner.js";
import { createFillPlansRepo } from "../src/store/fill-plans-repo.js";
import { createFormSchemasRepo } from "../src/store/form-schemas-repo.js";

const plan = (needsYou: number): FillPlan => ({
  schemaHash: "h1",
  jobCountry: "India",
  entries: [],
  summary: {
    fill: 3,
    auto: 2,
    confirm: 1,
    protected: 0,
    needsYou,
    skipped: 0,
    estMinutes: 2.5,
  },
});

describe("form schemas repo", () => {
  it("stores the raw Greenhouse payload per posting and reads it back while fresh", () =>
    runAsUser("u1", () => {
    const db = openStore(":memory:");
    const schemas = createFormSchemasRepo(db);
    expect(schemas.getFresh("greenhouse", "acme", "11")).toBeNull();
    schemas.save(
      "greenhouse",
      "acme",
      "11",
      { id: 11, title: "Engineer" },
      "hash-a",
    );
    expect(schemas.getFresh("greenhouse", "acme", "11")).toMatchObject({
      payload: { id: 11, title: "Engineer" },
      hash: "hash-a",
    });
    schemas.save(
      "greenhouse",
      "acme",
      "11",
      { id: 11, title: "Engineer II" },
      "hash-b",
    );
    expect(schemas.getFresh("greenhouse", "acme", "11")?.hash).toBe("hash-b");
    }));

  it("keeps each system's forms apart", () =>
    runAsUser("u1", () => {
    const schemas = createFormSchemasRepo(openStore(":memory:"));
    schemas.save("greenhouse", "acme", "11", { gh: true }, "g");
    schemas.save("ashby", "acme", "11", { ashby: true }, "a");
    expect(schemas.getAny("greenhouse", "acme", "11")?.hash).toBe("g");
    expect(schemas.getAny("ashby", "acme", "11")?.hash).toBe("a");
    }));

  it("treats a schema older than the freshness window as missing", () =>
    runAsUser("u1", () => {
    const db = openStore(":memory:");
    const schemas = createFormSchemasRepo(db);
    schemas.save("greenhouse", "acme", "11", {}, "h");
    db.prepare(
      "update form_schemas set fetched_at = datetime('now', '-10 days')",
    ).run();
    expect(schemas.getFresh("greenhouse", "acme", "11")).toBeNull();
    expect(schemas.getAny("greenhouse", "acme", "11")?.hash).toBe("h");
    }));
});

describe("fill plans repo", () => {
  it("saves one plan per job, replaces it on rebuild, and lists summaries", () => {
    const db = openStore(":memory:");
    const plans = createFillPlansRepo(db);
    expect(plans.get("j1")).toBeNull();
    plans.save("j1", plan(4));
    plans.save("j1", plan(2));
    plans.save("j2", plan(0));
    expect(plans.get("j1")?.plan.summary.needsYou).toBe(2);
    expect(plans.get("j1")?.builtAt).toEqual(expect.any(String));
    expect(plans.jobIds().sort()).toEqual(["j1", "j2"]);
    expect(plans.summaries().get("j2")?.summary.needsYou).toBe(0);
  });
});
