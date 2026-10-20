import { DatabaseSync } from "node:sqlite";

/**
 * apply-assistant's own SQLite store (Node's built-in driver: no native module to build).
 * Lives at <APPLY_DATA_DIR>/apply.db on the server; never shared with Job Ops' jobs.db.
 */

export const MIGRATIONS: readonly string[] = [
  `create table employer_domains (
     employer_norm text primary key,
     domain text,
     method text not null,
     confidence real,
     checked_at text not null default (datetime('now'))
   );
   create table gh_boards (
     employer_norm text primary key,
     token text,
     method text not null,
     checked_at text not null default (datetime('now')),
     jobs_cache_json text,
     jobs_cached_at text
   );
   create table apply_targets (
     job_id text primary key,
     gh_token text,
     gh_job_id text,
     gh_url text,
     match_method text not null,
     title_score real,
     desc_score real,
     status text not null check (status in ('matched','possible','none','closed')),
     updated_at text not null default (datetime('now'))
   );
   create table fill_plans (
     job_id text primary key,
     schema_hash text not null,
     plan_json text not null,
     auto_count integer not null,
     needs_you_count integer not null,
     est_minutes real,
     built_at text not null default (datetime('now'))
   );
   create table answer_bank (
     key text primary key,
     value text not null,
     is_protected integer not null default 0,
     notes text,
     updated_by text not null,
     updated_at text not null default (datetime('now'))
   );
   create table question_map (
     question_norm text primary key,
     answer_key text not null,
     confidence real not null,
     confirmed_by_you integer not null default 0,
     uses integer not null default 0
   );
   create table runs (
     id text primary key,
     job_id text not null,
     started_at text not null default (datetime('now')),
     ended_at text,
     outcome text,
     interventions integer not null default 0,
     model_cost real not null default 0
   );
   create table run_actions (
     run_id text not null references runs(id) on delete cascade,
     seq integer not null,
     action_class text not null,
     field_ref text not null,
     value_masked text,
     source text,
     confidence real,
     decision text,
     decided_by text,
     result text,
     ts text not null default (datetime('now')),
     primary key (run_id, seq)
   );
   create table captured_links (
     job_id text not null,
     source_url text not null,
     captured_url text not null,
     decoded_url text,
     captured_at text not null default (datetime('now'))
   );`,
  // M2: Greenhouse form payloads fetched by the extension, one per posting.
  `create table form_schemas (
     gh_token text not null,
     gh_job_id text not null,
     payload_json text not null,
     schema_hash text not null,
     fetched_at text not null default (datetime('now')),
     primary key (gh_token, gh_job_id)
   );`,
  // M3: Claude's answers to questions the rules don't recognise (cache, see claude-answers-repo).
  `create table claude_answers (
     cache_key text primary key,
     answer_json text not null,
     model text not null,
     created_at text not null default (datetime('now'))
   );`,
  // More application systems than Greenhouse: every target, board and form names its ATS.
  `alter table apply_targets add column ats text not null default 'greenhouse';
   alter table gh_boards rename to ats_boards;
   alter table ats_boards add column ats text;
   update ats_boards set ats = 'greenhouse' where token is not null;
   create table form_schemas_v2 (
     ats text not null,
     board text not null,
     posting_id text not null,
     payload_json text not null,
     schema_hash text not null,
     fetched_at text not null default (datetime('now')),
     primary key (ats, board, posting_id)
   );
   insert into form_schemas_v2 (ats, board, posting_id, payload_json, schema_hash, fetched_at)
     select 'greenhouse', gh_token, gh_job_id, payload_json, schema_hash, fetched_at from form_schemas;
   drop table form_schemas;
   alter table form_schemas_v2 rename to form_schemas;`,
  // Which systems a "no board" answer covered: adding a system makes those answers stale.
  "alter table ats_boards add column searched text;",
  // Run trace: what the server, the extension and the page did, per job (APPLY_TRACE_AND_KIT_PLAN.md).
  `create table trace_events (
     id integer primary key autoincrement,
     job_id text not null,
     run_id text,
     ts text not null,
     source text not null,
     kind text not null,
     step_seq integer,
     message text not null,
     data_json text,
     snapshot_id text
   );
   create index trace_events_job on trace_events (job_id, id);
   create index trace_events_run on trace_events (run_id, id);
   create table trace_snapshots (
     id text primary key,
     job_id text not null,
     run_id text,
     kind text not null check (kind in ('dom','screenshot')),
     reason text not null,
     url text,
     bytes integer not null,
     file text not null,
     created_at text not null
   );
   create index trace_snapshots_job on trace_snapshots (job_id, created_at);`,
  // Answers you gave to form questions (edited or typed), reused when the question comes again.
  `create table learned_answers (
     id integer primary key autoincrement,
     question_norm text not null unique,
     label text not null,
     field_type text not null,
     answer_json text not null,
     how text not null,
     last_job_id text,
     created_at text not null default (datetime('now')),
     updated_at text not null default (datetime('now'))
   );`,
];

export function openStore(target: string | DatabaseSync): DatabaseSync {
  const db = typeof target === "string" ? new DatabaseSync(target) : target;
  if (typeof target === "string" && target !== ":memory:")
    db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  db.exec(
    "create table if not exists schema_version (version integer not null)",
  );
  const row = db
    .prepare("select max(version) as v from schema_version")
    .get() as { v: number | null };
  const current = row.v ?? 0;
  MIGRATIONS.slice(current).forEach((sql, index) => {
    db.exec("begin");
    try {
      db.exec(sql);
      db.prepare("insert into schema_version (version) values (?)").run(
        current + index + 1,
      );
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  });
  return db;
}
