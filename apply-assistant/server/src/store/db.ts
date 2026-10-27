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
  // Companies that take only so many applications from you in a while (Amazon: one per six
  // months), so you pick your one best role there. Seeded; you add, change or remove them.
  `create table company_limits (
     id integer primary key autoincrement,
     company_key text not null unique,
     name text not null,
     max_applications integer not null,
     window_days integer not null,
     note text not null default '',
     created_at text not null default (datetime('now')),
     updated_at text not null default (datetime('now'))
   );
   insert into company_limits (company_key, name, max_applications, window_days, note) values
     ('amazon', 'Amazon', 1, 183, 'Yours: one application every 6 months'),
     ('elevenlabs', 'ElevenLabs', 1, 183, 'Yours: one application every 6 months'),
     ('google', 'Google', 3, 30, 'Widely reported, not confirmed by Google: 3 applications in 30 days');`,
  // Steps that set a field on a company's own form, kept per site and question ("{value}" for
  // your answer), with how often they worked: replayed before Claude is asked again.
  `create table site_recipes (
     host text not null,
     label_key text not null,
     label text not null,
     steps_json text not null,
     worked integer not null default 0,
     failed integer not null default 0,
     created_at text not null default (datetime('now')),
     updated_at text not null default (datetime('now')),
     primary key (host, label_key)
   );`,
  // Users: each Job Ops user has their own answers, limits, runs and traces (user_id). Rows from
  // before ('') are claimed by Job Ops' admin on their first request (see owner.ts).
  `create table answer_bank_v2 (
     user_id text not null default '',
     key text not null,
     value text not null,
     is_protected integer not null default 0,
     notes text,
     updated_by text not null,
     updated_at text not null default (datetime('now')),
     primary key (user_id, key)
   );
   insert into answer_bank_v2 (key, value, is_protected, notes, updated_by, updated_at)
     select key, value, is_protected, notes, updated_by, updated_at from answer_bank;
   drop table answer_bank;
   alter table answer_bank_v2 rename to answer_bank;

   create table learned_answers_v2 (
     id integer primary key autoincrement,
     user_id text not null default '',
     question_norm text not null,
     label text not null,
     field_type text not null,
     answer_json text not null,
     how text not null,
     last_job_id text,
     created_at text not null default (datetime('now')),
     updated_at text not null default (datetime('now')),
     unique (user_id, question_norm)
   );
   insert into learned_answers_v2 (id, question_norm, label, field_type, answer_json, how, last_job_id, created_at, updated_at)
     select id, question_norm, label, field_type, answer_json, how, last_job_id, created_at, updated_at from learned_answers;
   drop table learned_answers;
   alter table learned_answers_v2 rename to learned_answers;

   create table company_limits_v2 (
     id integer primary key autoincrement,
     user_id text not null default '',
     company_key text not null,
     name text not null,
     max_applications integer not null,
     window_days integer not null,
     note text not null default '',
     created_at text not null default (datetime('now')),
     updated_at text not null default (datetime('now')),
     unique (user_id, company_key)
   );
   insert into company_limits_v2 (id, company_key, name, max_applications, window_days, note, created_at, updated_at)
     select id, company_key, name, max_applications, window_days, note, created_at, updated_at from company_limits;
   drop table company_limits;
   alter table company_limits_v2 rename to company_limits;

   alter table runs add column user_id text not null default '';
   alter table trace_events add column user_id text not null default '';
   alter table trace_snapshots add column user_id text not null default '';
   alter table captured_links add column user_id text not null default '';
   create index runs_user_job on runs (user_id, job_id);
   create index trace_events_user_job on trace_events (user_id, job_id, id);
   create index trace_snapshots_user_job on trace_snapshots (user_id, job_id);`,
  // Everything else a user's extension or plans write is theirs too: postings' boards and forms
  // they looked up, Claude's cached answers, site steps. And each user's own Claude key.
  `create table ats_boards_v2 (
     user_id text not null default '',
     employer_norm text not null,
     token text,
     method text not null,
     checked_at text not null default (datetime('now')),
     jobs_cache_json text,
     jobs_cached_at text,
     ats text,
     searched text,
     primary key (user_id, employer_norm)
   );
   insert into ats_boards_v2 (employer_norm, token, method, checked_at, jobs_cache_json, jobs_cached_at, ats, searched)
     select employer_norm, token, method, checked_at, jobs_cache_json, jobs_cached_at, ats, searched from ats_boards;
   drop table ats_boards;
   alter table ats_boards_v2 rename to ats_boards;

   create table form_schemas_v3 (
     user_id text not null default '',
     ats text not null,
     board text not null,
     posting_id text not null,
     payload_json text not null,
     schema_hash text not null,
     fetched_at text not null default (datetime('now')),
     primary key (user_id, ats, board, posting_id)
   );
   insert into form_schemas_v3 (ats, board, posting_id, payload_json, schema_hash, fetched_at)
     select ats, board, posting_id, payload_json, schema_hash, fetched_at from form_schemas;
   drop table form_schemas;
   alter table form_schemas_v3 rename to form_schemas;

   create table claude_answers_v2 (
     user_id text not null default '',
     cache_key text not null,
     answer_json text not null,
     model text not null,
     created_at text not null default (datetime('now')),
     primary key (user_id, cache_key)
   );
   insert into claude_answers_v2 (cache_key, answer_json, model, created_at)
     select cache_key, answer_json, model, created_at from claude_answers;
   drop table claude_answers;
   alter table claude_answers_v2 rename to claude_answers;

   create table site_recipes_v2 (
     user_id text not null default '',
     host text not null,
     label_key text not null,
     label text not null,
     steps_json text not null,
     worked integer not null default 0,
     failed integer not null default 0,
     created_at text not null default (datetime('now')),
     updated_at text not null default (datetime('now')),
     primary key (user_id, host, label_key)
   );
   insert into site_recipes_v2 (host, label_key, label, steps_json, worked, failed, created_at, updated_at)
     select host, label_key, label, steps_json, worked, failed, created_at, updated_at from site_recipes;
   drop table site_recipes;
   alter table site_recipes_v2 rename to site_recipes;

   create table user_settings (
     user_id text primary key,
     anthropic_key text,
     updated_at text not null default (datetime('now'))
   );`,
  // Jobs skipped because you blocked their company, with the status to put back on unblock.
  `create table blocked_skips (
     user_id text not null default '',
     keyword text not null,
     job_id text not null,
     previous_status text not null,
     created_at text not null default (datetime('now')),
     primary key (user_id, keyword, job_id)
   );`,
  // A block that ends on a date (e.g. 90 days after your last application there).
  `create table blocked_until (
     user_id text not null default '',
     keyword text not null,
     until text not null,
     primary key (user_id, keyword)
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
