import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createAnswerBankRepo } from "../src/store/answer-bank-repo.js";
import { createApplyTargetsRepo } from "../src/store/apply-targets-repo.js";
import { createAtsBoardsRepo } from "../src/store/ats-boards-repo.js";
import { MIGRATIONS, openStore } from "../src/store/db.js";
import { createFormSchemasRepo } from "../src/store/form-schemas-repo.js";

const memoryStore = () => openStore(":memory:");

describe("openStore", () => {
  it("creates every Phase 1 table", () => {
    const db = memoryStore();
    const tables = db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "answer_bank",
        "apply_targets",
        "captured_links",
        "employer_domains",
        "fill_plans",
        "form_schemas",
        "ats_boards",
        "question_map",
        "run_actions",
        "runs",
        "schema_version",
      ]),
    );
  });

  it("keeps Greenhouse data when adding other application systems (migration 4)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("create table schema_version (version integer not null)");
    MIGRATIONS.slice(0, 3).forEach((sql, i) => {
      db.exec(sql);
      db.prepare("insert into schema_version (version) values (?)").run(i + 1);
    });
    db.exec(`insert into form_schemas (gh_token, gh_job_id, payload_json, schema_hash)
             values ('acme', '11', '{}', 'h');
             insert into gh_boards (employer_norm, token, method) values ('acme', 'acme', 'slug'), ('none co', null, 'slug');
             insert into apply_targets (job_id, gh_token, gh_job_id, match_method, status)
             values ('j1', 'acme', '11', 'direct', 'matched');`);
    openStore(db);
    expect(
      createFormSchemasRepo(db).getAny("greenhouse", "acme", "11")?.hash,
    ).toBe("h");
    expect(createApplyTargetsRepo(db).get("j1")?.ats).toBe("greenhouse");
    const boards = createAtsBoardsRepo(db);
    expect(boards.getFresh("acme")).toMatchObject({
      ats: "greenhouse",
      token: "acme",
    });
    // "No board" was only ever checked on Greenhouse: look again on the other systems.
    expect(boards.getFresh("none co")).toBeNull();
    boards.save("none co", null, "name-slug");
    expect(boards.getFresh("none co")).toMatchObject({
      ats: null,
      token: null,
    });
  });

  it("is idempotent when opened twice on the same database", () => {
    const db = memoryStore();
    expect(() => openStore(db)).not.toThrow();
  });
});

describe("answer bank repo", () => {
  it("stores, reads and lists answers", () => {
    const repo = createAnswerBankRepo(memoryStore());
    repo.upsert({
      key: "notice_period",
      value: "30 days",
      isProtected: true,
      updatedBy: "you",
    });
    repo.upsert({
      key: "referral_source",
      value: "Company website",
      isProtected: false,
      updatedBy: "you",
    });
    expect(repo.get("notice_period")).toMatchObject({
      key: "notice_period",
      value: "30 days",
      isProtected: true,
    });
    expect(repo.list().map((a) => a.key)).toEqual([
      "notice_period",
      "referral_source",
    ]);
  });

  it("updates an existing key instead of duplicating it", () => {
    const repo = createAnswerBankRepo(memoryStore());
    repo.upsert({
      key: "ctc.expected",
      value: "24 LPA",
      isProtected: true,
      updatedBy: "you",
    });
    repo.upsert({
      key: "ctc.expected",
      value: "26 LPA",
      isProtected: true,
      updatedBy: "you",
    });
    expect(repo.list()).toHaveLength(1);
    expect(repo.get("ctc.expected")?.value).toBe("26 LPA");
  });

  it("returns null for an unknown key", () => {
    expect(createAnswerBankRepo(memoryStore()).get("missing")).toBeNull();
  });

  it("rejects an empty key", () => {
    const repo = createAnswerBankRepo(memoryStore());
    expect(() =>
      repo.upsert({
        key: " ",
        value: "x",
        isProtected: false,
        updatedBy: "you",
      }),
    ).toThrow(/key/);
  });
});

describe("apply targets repo", () => {
  it("records a Greenhouse match per job and reads it back", () => {
    const repo = createApplyTargetsRepo(memoryStore());
    repo.upsert({
      jobId: "j1",
      ats: "greenhouse",
      boardToken: "fivetran",
      postingId: "7768594003",
      postingUrl: "https://www.fivetran.com/careers/job?gh_jid=7768594003",
      matchMethod: "board title match",
      titleScore: 1,
      descScore: null,
      status: "matched",
    });
    expect(repo.get("j1")).toMatchObject({
      ats: "greenhouse",
      boardToken: "fivetran",
      status: "matched",
      titleScore: 1,
      descScore: null,
    });
  });

  it("lists targets by status", () => {
    const repo = createApplyTargetsRepo(memoryStore());
    const base = {
      ats: "greenhouse" as const,
      boardToken: null,
      postingId: null,
      postingUrl: null,
      matchMethod: "none",
      titleScore: null,
      descScore: null,
    };
    repo.upsert({ ...base, jobId: "a", status: "none" });
    repo.upsert({
      ...base,
      jobId: "b",
      status: "matched",
      boardToken: "x",
      postingId: "1",
      postingUrl: "https://g/1",
    });
    expect(repo.listByStatus("matched").map((t) => t.jobId)).toEqual(["b"]);
  });
});
