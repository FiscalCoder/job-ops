# Credit Efficiency & Remote-Job Strategy Notes

Working notes from a review of this repo against an older personal job-hunting
automation stack (n8n + jobspy + Postgres, not part of this repo), done to
figure out how to cut AI credit spend and bias the pipeline toward remote
roles with minimal day-to-day friction. Captures what was found, what was
suggested, and what was actually built on branch `feature/credit-savings-remote-focus`.

---

## 1. How job-ops works (baseline understanding)

- Self-hosted job hunting dashboard: scrapes 13+ job boards, AI-scores each
  job 0-100 against your profile, auto-tailors a CV + generates a PDF for the
  top-scoring jobs, and tracks applications via Gmail/IMAP reply detection.
- **Does not auto-apply** — you always submit applications yourself on the
  company's site; JobOps only prepares the tailored CV and tracks status.
- Monorepo: `orchestrator/` (Express backend + React frontend), `extractors/*`
  (one module per job board), `career-boards/*` (Workday/Greenhouse/BambooHR
  watchlist monitoring), `shared/` (types, settings registry).
- Pipeline flow: `discover → import → score → select (topN + minScore) →
  auto-tailor + generate PDF → status "ready"`. No approval gate before
  tailoring runs — it happens automatically for the selected top N jobs.
- No built-in scheduler. Triggered via UI button, `npm run pipeline:run` CLI,
  or `POST /api/webhook/trigger` (Bearer `WEBHOOK_SECRET`) — the webhook route
  is explicitly built for n8n/cron to call on a schedule.
- LLM layer is a pluggable strategy pattern: `openrouter` (default), `openai`,
  `anthropic`, `glm`, `gemini`, `gemini_cli` (free, local CLI, ~1,500 req/day
  on Flash), `codex` (local CLI), `openai_compatible` (any OpenAI-shaped
  endpoint — covers DeepSeek, Ollama-as-OpenAI, etc.), `ollama`, `lmstudio`.
  No native `deepseek` provider, but DeepSeek works fine via
  `openai_compatible` pointed at `api.deepseek.com/v1/chat/completions`.
- Sources by mechanism: `jobspy` (Python lib, scrapes LinkedIn/Indeed/Glassdoor),
  official APIs (Adzuna, Seek via Apify, UK Visa Jobs via login), direct HTTP
  to public endpoints (Hiring Cafe, startup.jobs/Algolia, Working Nomads,
  Golang Jobs/Supabase, Jobindex, Naukri), and country-restricted scrapers
  (Gradcracker/UK, WUZZUF/Egypt, Khamsat/Egypt).

## 2. The old n8n job-automation stack — what it did differently

Located outside this repo (WSL: `~/development/job-automation`). Architecture:
Postgres + Redis + n8n + a custom FastAPI `jobspy-api` wrapper + NocoDB, all
in docker-compose. n8n workflows did all orchestration.

**Cost-control strategies it used, that job-ops does not:**

1. **Title prefilter** — dropped junior/QA/mobile/devops-style roles by
   substring match against a `title_skip` list, before any LLM call.
2. **Phrase pre-reject** — scanned job descriptions for explicit rejection
   phrases ("no visa sponsorship", "right to work required", etc.) and
   rejected for free, no LLM call.
3. **DB dedup** — never re-scored a URL already seen (job-ops already does
   this too, via cached `suitabilityScore`).
4. **Two-tier model routing** — cheap DeepSeek (~$0.14/M tokens) for bulk
   scoring, Claude Haiku only for the more nuanced two-axis (role fit + visa
   eligibility) abroad scoring, Sonnet reserved for resume/cover-letter
   writing (Phase 2, never fully built).
5. **Anthropic prompt caching** — the long scoring rubric was sent as an
   `ephemeral` cached system block, so only the per-job description was
   fresh, uncached tokens on each call.
6. **Batching + leased queue** — a Postgres `pending_scoring` table with
   `FOR UPDATE SKIP LOCKED` + a 15-minute lease, processed in batches of 3
   every 10 minutes with a 3s inter-batch delay (rate-limit friendly,
   crash-safe, no duplicate work).
7. **Telegram one-tap review** — `/next` served one top job at a time with
   inline "✅ Applied / ⏭️ Skip" buttons; also `/run`, `/queue`, `/stats`,
   `/export` CSV-to-chat, and an error-handler workflow that pushed any n8n
   failure straight to Telegram. Reported total AI budget: **$4–11/month**.
8. **Remote-native board aggregation** (abroad workflow only) — pulled from
   Arbeitnow (visa-sponsorship filtered), RemoteOK, Himalayas, Remotive,
   Jobicy, and VisaSponsor.jobs — all boards job-ops does not currently touch.
9. Cron cadence: domestic scrape every 8h, abroad scrape twice daily
   (6am/6pm IST), scoring queue every 10 min, Telegram poller every 5s.

**What the old repo did worse / never finished:**
- Single generic `ai_score` for domestic jobs (no explicit two-axis reasoning
  outside the abroad path).
- No CV tailoring or PDF generation ever shipped (Phase 2, config existed,
  no workflow built).
- No verified visa-sponsor list — visa likelihood was entirely LLM-inferred
  from job-description language, not cross-checked against a real sponsor
  registry (job-ops has an actual CSV-based licensed-sponsor match,
  `sponsorMatchScore`, which is more trustworthy).
- No application tracking beyond a manual status field.
- Personal script, not actively maintained; job-ops is an actively developed
  open-source project (frequent merged PRs).

## 3. Verdict: which one finds the "right" jobs better?

Neither wins outright — they're strong in different halves of the problem:

- **Old repo's edge**: scoring tuned to a specific person via an explicit
  high/low example rubric, plus remote-native board sources job-ops lacks.
  Better *signal* for remote/visa-focused search specifically.
- **job-ops's edge**: broader general board coverage, verified sponsor-CSV
  matching (not LLM-guessed), active maintenance, and it actually finishes
  the job (CV tailoring, PDF export, Gmail-based application tracking) —
  things the old repo's roadmap never got past `enabled: false` on.

**Conclusion**: job-ops is the better foundation to build on; the old repo's
scoring rubric design and cost discipline are worth porting into it rather
than resurrecting the old stack.

## 4. Key inefficiencies identified in job-ops (before this branch)

- **2 LLM calls per discovered job, zero prefiltering.** Every scraped job
  gets both a suitability score (`scorer.ts`) and a "job brief"
  (`job-brief.ts`) — no keyword/phrase gate exists before either call. A
  200-job discovery run ≈ 400 scoring-stage LLM calls.
- **`enableAutoTailoring` was dead code.** `PipelineConfig` defined it
  (default `true`) but `runPipeline()` never actually checked it — every
  automatic run always tailored + PDF'd the top N jobs regardless, whether
  or not you intended to apply.
- **No Anthropic prompt caching.** The Anthropic provider adapter sent a
  plain `system` string with no `cache_control`, and the scoring prompt
  didn't even separate static (profile+rubric) from per-job content — so
  there was nothing cacheable to begin with, even if caching had been wired.
- Per-purpose model overrides (`modelScorer`, `modelTailoring`,
  `llmPurposeOverrides`) already existed — this part just needed configuring,
  not building.
- Remote-only search support already existed
  (`workplaceTypes=["remote"]` + `locationSearchScope=
  remote_worldwide_prioritize_selected`) — also just needed configuring.

## 5. Full list of suggestions made (ranked)

1. **Pre-scoring keyword/phrase filter** — port `title_skip` + rejection
   phrases as a gate before the LLM calls. Biggest single credit saver.
   → **Built** (see §6).
2. **Wire up `enableAutoTailoring`** — make it a real toggle so tailoring
   only runs when explicitly wanted (auto for top N, or fully manual via the
   existing `move_to_ready` action). → **Built** (see §6).
3. **Add free remote-native board extractors** — Remotive, Himalayas,
   RemoteOK, Jobicy, Arbeitnow (visa-filtered). Same shape as the existing
   `workingnomads` extractor (~1 file each). → **Not built yet** (see §7,
   good next step).
4. **Make the "job brief" lazy** — generate it on-demand when a job's detail
   page is opened, instead of during the pipeline for every discovered job.
   Halves scoring-stage LLM calls. → **Not built yet.**
5. **Telegram approve/skip bridge via n8n** — external workflow, not a
   job-ops code change: n8n fetches `ready` jobs from `/api/jobs`, sends
   Telegram cards with buttons, button callbacks call
   `/api/jobs/actions` (`skip` / `move_to_ready`). → **Not built** (explicitly
   out of scope for this branch, per user request — build later as an n8n
   workflow, not inside this repo).
6. **Anthropic prompt caching** — cache the static profile/rubric portion of
   the scoring prompt. → **Built** (see §6).

Config-only levers (no code needed, just settings):
- Remote-only search: `workplaceTypes=["remote"]` +
  `locationSearchScope=remote_worldwide_prioritize_selected`.
- Zero/near-zero cost provider: `LLM_PROVIDER=gemini_cli` (free, ~1,500
  req/day on Flash) or DeepSeek via `openai_compatible`.
- Cheap scoring / good tailoring split: set `modelScorer` cheap, keep
  `modelTailoring` stronger.
- Tighter selection: lower `topN` (10 → 3–5), raise `minSuitabilityScore`
  (50 → 65–70), set `autoSkipScoreThreshold` (~40) to auto-bury junk after
  scoring.
- Port the old rubric's high/low examples into the `scoringInstructions`
  setting.
- Point an n8n Schedule Trigger at `POST /api/webhook/trigger` for
  automated runs (no built-in scheduler exists in job-ops itself).

## 6. What was actually implemented (branch `feature/credit-savings-remote-focus`)

Fork: `https://github.com/FiscalCoder/job-ops` (remote `fork`); upstream
`origin` kept pointing at `DaKheera47/job-ops` for pulling future updates.

**A. Pre-LLM title/phrase reject filter**
- New settings `blockedTitleKeywords` and `rejectionPhrases` (both
  `string[]`, default `[]`), mirroring the existing `blockedCompanyKeywords`
  pattern exactly in `shared/src/settings-registry.ts` and
  `shared/src/types/settings.ts`.
- New helper `orchestrator/src/server/pipeline/steps/keyword-filters.ts`
  (case-insensitive substring matching, same normalization as the existing
  company-keyword filter).
- `score-jobs.ts` now checks `job.title` / `job.jobDescription` against these
  lists **before** calling `scoreJobSuitability`/`generateJobBrief`. On a
  match: skips both LLM calls and the visa-sponsor lookup, sets
  `suitabilityScore: 0`, a descriptive reason, and `status: "skipped"`
  directly.
- Settings UI added next to the existing "Blocked Company Keywords" field.
- Pipeline run snapshot gets `blockedTitleKeywordsCount` /
  `rejectionPhrasesCount` for observability.

**B. Real `enableAutoTailoring` toggle**
- New persisted setting `autoTailorOnPipelineRun` (default `true`, preserves
  existing behavior), mirroring the existing `autoTailorOnManualImport`
  pattern.
- `orchestrator.ts`: new `resolveEnableAutoTailoring()` resolver (explicit
  per-run config wins, else falls back to the setting) feeding into
  `mergedConfig.enableAutoTailoring`, which now actually gates the
  `processJobsStep` call. When off: scoring/selection still run, but
  selected jobs are left at `discovered` status (untouched) instead of being
  auto-tailored — you approve individual jobs via the existing
  `move_to_ready` action instead.
- `POST /api/pipeline/run` accepts an optional `enableAutoTailoring` override
  in the request body.
- Settings UI toggle added next to "Auto-tailor manually imported jobs".

**C. Anthropic prompt caching**
- `providers/anthropic.ts`: when a system message exceeds ~4000 characters,
  it's now sent as `[{type:"text", text, cache_control:{type:"ephemeral"}}]`
  instead of a plain string. Confirmed via current Anthropic docs that
  prompt caching is GA on the standard Messages API (no beta header needed)
  and that minimum cacheable length varies ~512–4096 tokens by model tier —
  4000 characters was chosen as a conservative proxy safely above the lowest
  tier's floor.
- `scorer.ts`: `scoreJobSuitability` now sends **two** messages instead of
  one — a `system` message with the profile JSON + scoring instructions
  (static across every job scored in a run, now cacheable), and a `user`
  message with just the job-specific fields (title/employer/location/salary/
  description). Backward-compatible: if a custom `scoringPromptTemplate`
  still references `{{profileJson}}`/`{{scoringInstructionsText}}`, those
  still resolve correctly (both tokens are still passed to both renders).
- `job-brief.ts` needed no changes — it already sent a static system prompt
  separately from per-job content, so it benefits from the caching change
  immediately for free.
- Default `scoringPromptTemplate` text updated to drop the now-redundant
  profile/instructions blocks (new/default installs get full savings
  immediately; existing customized templates keep working as before until
  manually updated to drop the duplication).

All three changes verified independently (type-checks, targeted biome, and
targeted tests green) plus a final full CI-parity pass across the combined
branch (`biome ci .`, shared + orchestrator + extractor type-checks,
client build, full test suite) before commit.

## 7. Good next steps (not yet built)

- Add Remotive / Himalayas / RemoteOK / Jobicy / Arbeitnow as extractors —
  same shape as `extractors/workingnomads/`, all free JSON APIs, all
  remote-first, directly serves the "more remote jobs" goal.
- Make `generateJobBrief` lazy (on job-detail-view open) instead of running
  for every discovered job during the pipeline.
- Build the Telegram one-tap approve/skip flow as an **external n8n
  workflow** hitting job-ops's existing `/api/jobs` and
  `/api/jobs/actions` REST endpoints — no job-ops code changes needed.
