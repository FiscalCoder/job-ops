# Alternatives evaluation: switch, hybrid, or keep and borrow?

Started 2026-11-04. This file holds the context for one decision: should Job Ops plus Apply Assistant move to another open-source project, merge with one, or stay as it is and borrow specific pieces? It also asks what can be simplified for **cost**, **accuracy** and **features**.

Status: in progress. The sections fill in as each comparison finishes. The decision is at the end.

---

## 1. What we have today (baseline)

### Job Ops (fork of DaKheera47/job-ops; our branch `feature/credit-savings-remote-focus`)

- **Our fork's position:** 117 of our commits since we last synced with upstream on 2026-10-06. Upstream has 20 commits we don't have. Merging them gives 4 conflicts: `scorer.ts`, `orchestrator.ts`, `startupjobs/run.ts`, `challenges.test.ts`.
- **Discovery:**
  - about 20 extractors (`extractors/`): JobSpy (LinkedIn, Indeed, Glassdoor, Naukri), Adzuna, HiringCafe, Naukri (full description from `/jobapi/v4/job/<id>`, at most 40 a run), Remotive, Himalayas, Jobicy, Arbeitnow, WorkingNomads, StartupJobs, Seek and others. RemoteOK was removed from the saved search: its apply button is behind a paywall and it reposts other companies' jobs.
  - Company watchlist in `career-boards/`: Greenhouse, Workday, BambooHR. Upstream PR #800 adds Ashby.
  - Saved search "Remote+onsite v1" runs on a schedule (`services/daily-search`), at 00:00 UTC (off-peak).
- **Scoring:**
  - One rubric in the "Job scoring prompt": Skills 50 / Experience 30 / Location 20, with caps.
  - Code adds up the parts and applies the caps (`scorer.ts settleScore`).
  - Model: **deepseek-flash, about $3 a month**. On 36 jobs × 3 runs it beat Haiku, Sonnet and v4-pro on both accuracy and stability. Rubric v5 is from 2026-11-02.
- **Closed postings:** `services/job-liveness` (classify, safe-fetch, posting-age, sweep at 03:00 UTC and after each search, manual expire). We already have this.
- **Extractor health:** `services/extractor-health.ts`.
- **Resume:**
  - The design resume is tailored per job: headline, summary, skills, projects. Experience and education are not tailored.
  - PDF via RxResume or the LaTeX (Jake's) renderer.
  - Ghostwriter.
- **Tracking:** Gmail post-application inbox matching, applied-duplicate matching.
- **Multi-user:** hosted on the VPS at job-ops.hueint.com.

### Apply Assistant (`apply-assistant/`: about 13.1k lines of server TS, 12.5k extension src and 3.9k entrypoints)

- **Where things run:**
  - The **extension** (WXT MV3) drives the user's real Chrome tab with puppeteer-core over chrome.debugger, so input is trusted. Every third-party lookup runs from the user's own IP.
  - The **server** (Express/SQLite, apply.hueint.com) holds all data and makes the Claude calls. It never contacts third-party sites.
- **Site drivers:** Greenhouse, Ashby, Lever, Workday (page by page), SmartRecruiters (shadow DOM), Zoho Recruit, Keka/Phenom/iCIMS through the generic engine.
- **Try order per field:** site driver → generic driver → saved steps (recipes) → Claude:
  1. closer read (Sonnet, HTML);
  2. operate (screenshot + computer use; capped at $0.15 a field, $0.60 a job).
- **Planning:**
  - The form snapshot goes to the planner. Answers come from the bank, learned answers and the resume first, and those are auto-approved.
  - Claude's Haiku maps unknown questions; Sonnet drafts answers.
  - Page map (Haiku) on every page, merged only into gaps.
  - On generic pages only, Sonnet reads the page in parallel.
  - History blocks match experience and education entries to resume jobs.
- **Memory:**
  - per-user answer bank, learned answers, company limits;
  - shared: posting matches, form schemas, `site_recipes`, `question_map`.
- **Generic engine:**
  - one element finder (`locate.ts`): shadow DOM, iframes, deep find;
  - revealers and cards, an entry's own Save, tags (Enter, then picking from the list);
  - search lists (`bestFound`, then one Claude pick), countries and dial codes, read-back.
- **Autopilot:**
  - highest score first;
  - finds the form (plain code, then Claude navigate at $0.20 a job);
  - fills, escalates to operate, re-checks at review;
  - you submit.
- **Observability:** run traces (steps, DOM + screenshot snapshots) in SQLite; Claude cost per job; Progress tab.
- **Side panel:**
  - queue grouped by company, with limits, blocks, hiding, sorts and filters;
  - kit for copy-paste, including the experience groups added 2026-11-04;
  - Tell Claude, Fix a field, Fill from…;
  - Add a job, which reads the page in the browser.
- **Never clicks the final Submit.** Confirmation-page detection; "I applied" now needs two clicks.
- **Tests:**
  - server: 398 unit;
  - extension: 163 unit;
  - 16 e2e suites against fake ATS pages;
  - Workday fixtures from a real recorded run.

### Known pain points: what a better system would need to fix

1. **Cost per application.** Claude runs at several points: map, draft, page map, parallel read, closer read, operate, navigate. These can add up on messy company sites.
2. **Reliability on unfamiliar company sites:** Phenom, iCIMS, custom React. The first runs found bugs each time (Mastercard, Virtusa, Atlassian, Guidehouse).
3. **Complexity.** About 30k lines in apply-assistant, with many fallbacks layered on. That's hard to reason about.
4. **Gaps in discovery.**
   - Indian ATS boards: Keka, Darwinbox, Zoho Recruit company boards.
   - Ashby company boards.
   - Naukri descriptions were excerpts until a902a07.
5. **False "applied":** Mastercard c57e2a46.

### What can't be lost in any switch

- Workday page-by-page filling, the generic engine, self-correcting recipes, run traces.
- The rule that the server never contacts third parties.
- Multi-user data.
- Never submitting for the user.
- The scoring rubric, and deepseek-flash's cost.

---

## 2. Candidates

From the first scan, 2026-11-04. Star counts are from `gh api`, and some look inflated.

| Repo | Licence | Covers | Note |
|---|---|---|---|
| career-ops-hq/career-ops | MIT | discovery (about 120 providers, incl. Keka, Darwinbox, Zoho), A–H scoring, CV and cover letter, autofill for 4 ATSes (never submits) | Claude Code CLI skills plus Playwright |
| vesaias/JobNavigator | MIT | ATS career pages (13 handlers), JobSpy, scoring, extension autofill with a Q&A bank, Telegram, multi-account | Closest in shape to ours |
| summitsingh/ai-job-pilot | MIT | fills 4 ATSes deterministically first, at most one LLM call, read-back, confirmation evidence | tiny |
| neonwatty/job-apply-plugin | MIT | Claude in Chrome skills; answer memory with provenance states; form-snapshot fixtures | |
| Pickle-Pixel/ApplyPilot | **AGPL** | end to end on any site through one Claude Code + Playwright session per job; submits | stale since 2026-03; ideas only |
| AhmadHassan-BTed/FormFilla | MIT | deterministic extension, Hungarian-algorithm field matching, repeated sections | no AI |

Dropped: AIHawk (repo repurposed), LinkedIn Easy Apply bots (break LinkedIn's terms), Skyvern and browser-use (general agents).

---

## 3. Deep dives

_(filled in from each comparison's notes; full notes are in the session scratchpad)_

### 3.1 JobNavigator (vesaias/JobNavigator, HEAD 461ce05e, 2026-11-03)

**Stack:** Python 3.12, FastAPI, SQLAlchemy, APScheduler, Playwright, Postgres, React.
- About 43.5k lines of backend code and about 53k lines of tests (about 3,350 tests). CI runs ruff, pytest, vitest and pip-audit.
- 1,039 commits since 2026-04, 961 of them by one author. 0 open issues.
- Multi-account: up to 5 household accounts.

**Discovery: broader than ours for US company boards, nothing for India.**
- API handlers: Greenhouse, Lever, Ashby, SmartRecruiters, Oracle HCM, Rippling, Phenom, TalentBrew, Amazon, Uber. Workday through the CXS API, split by facets when a board hits its 2,000-result cap.
- Playwright for Meta, Google and any other page. Also JobSpy, paid Apify actors, Jobright, Levels.fyi, Himalayas.
- No Keka, Darwinbox or Zoho. Location, H-1B and salary logic is US/Canada-centric.
- **Dedup is its strongest part, and better than ours:**
  - `_shared/postings.py` reads a posting ID from the URL for 30+ systems and follows short links.
  - `_shared/same_role.py` merges per-city copies and reposts only when the texts match after IDs, pay and places are masked.
  - Ours is a fuzzy title+employer match (`deduplicateJobsByTitleAndEmployer` in `pipeline/steps/import-jobs.ts`).
- **Closed postings:**
  - `_shared/still_open.py`: ATS APIs, then closed phrases, then redirects.
  - `_shared/missing_postings.py`: closed if missing from 2 full-board scrapes, which costs no extra requests.
  - We have `job-liveness`; their "missing from 2 scrapes" signal is the one we lack.

**Scoring** (`analyzer/cv_scorer.py`):
- One call per job scores *all* base résumés and picks the best. Rubric: 5 criteria × 20. The job description is cut to 8k characters.
- Anthropic prompt caching on the prefix.
- Subscription CLIs (`claude -p` with an OAuth token, Codex and others) are logged as $0. That's a possible terms-of-service risk.
- No batching or off-peak runs. About $0.004 a job on Haiku (unverified). **Ours (deepseek-flash off-peak, about $3 a month) is cheaper, and we've measured its accuracy.**

**Tailoring:**
- 8 Jinja templates rendered to PDF by Playwright, plus DOCX.
- Bullets are rewritten without invented facts, and suggested "gap-filler" bullets are accepted or rejected in a diff view.
- Persona pool picks 3–5 bullets per role.
- Cover letters with voice and length presets; an interview-prep prompt.

**Extension autofill: far shallower than ours.**
- About 2.5k lines of plain JS.
- Purely deterministic: the longest label synonym matched against about 31 fixed keys. Unknown fields are left alone.
- Custom dropdowns in `lib/ats_combobox.js` (from freehire, MIT): react-select, Workday `promptOption`, Oracle JET. It uses synthetic events, not trusted input.
- The LLM is used only to draft free-text answers, in an overlay with "Save to bank". The whole Q&A bank is pasted into every prompt, with no matching.
- **None of:**
  - file upload or shadow DOM;
  - multi-page or Workday sign-in;
  - repeated work-history cards;
  - confirmation detection, traces, or learning from failures.
- The extension has no tests.

**Tracking:** stages with funnel and Sankey charts; Gmail classification (phrases, then an LLM); Telegram alerts, digest and scrape-health messages.

**Verdict:** don't switch or merge. It's a different language and data model, and its form filling would lose Workday, the generic engine, recipes, traces, trusted input and Keka/Zoho.

**Port piece by piece, each as a fallback** (clone and notes are in the scratchpad):

| Their file | What we'd take | Effort |
|---|---|---|
| `_shared/postings.py` (+ tracking-param list, `tests/test_postings.py`) | Posting-ID match before our fuzzy dedup | 1.5–2 d |
| `_shared/same_role.py` | Text proof required before a fuzzy merge | 1 d |
| `ats/lever.py`, `ashby.py`, `smartrecruiters.py`, `oracle_hcm.py`, `rippling.py` | Watchlist adapters (`career-boards/`) | ~0.5 d each |
| Facet split in `ats/workday.py` | Workday boards past 2,000 jobs | 0.5–1 d |
| `_shared/missing_postings.py` | "Missing from 2 scrapes" signal for job-liveness | 0.5 d |
| Phrases and redirect rule in `still_open.py` | More signals in `job-liveness/classify.ts` | 0.5 d |
| `lib/ats_combobox.js` | Oracle JET, Workday `promptOption` and React `onClick` as a generic-engine fallback | 0.5 d |
| Overlay "draft, then Save to bank" | UX idea for the kit and Fix a field | — |
| Multi-résumé scoring, DOCX, gap-filler bullets with review | Optional | 0.5–2 d each |

### 3.2 career-ops (career-ops-hq/career-ops, HEAD 7d8feb6, v1.38.0, MIT)

**Operating model:** a local, file-based command-line toolkit for **one user**.
- The AI modes run through Claude Code / Codex (`claude -p` workers; API key or subscription token). The web UI listens on localhost only.
- Putting a consumer subscription behind our multi-user server would very likely break Anthropic's terms (unverified). Our API-key model is right for multi-user.

**Discovery: its real strength.**
- `providers/` holds 132 sources. Each is a small plain-JS module (`{id, detect, fetch}`) with almost no dependencies, and `providers/_http.mjs` handles retries with backoff and Retry-After.
- **Per-company ATS boards:** Greenhouse, Ashby, Lever, Workday, SmartRecruiters, Workable, Recruitee, iCIMS, SuccessFactors, Taleo, **Keka, Darwinbox, Zoho Recruit** and about 40 more. All public JSON, no login.
  - Keka: two requests. An ID from `{tenant}.keka.com/careers`, then `/careers/api/embedjobs/default/active/{uuid}`.
  - Darwinbox: a paginated POST to `/ms/candidateapi/job/alljobs?companyId=`. The list includes the full description and salary.
  - Zoho Recruit: the whole board is a JSON array inside `/jobs/Careers`.
  - Ashby: `api.ashbyhq.com/posting-api/job-board/{slug}`. Slow (about 10s) and throttles.
  - Workday: POST `/wday/cxs/{tenant}/{site}/jobs`. Bursts of 429s.
  - SmartRecruiters answers "0 jobs" for any slug, even a nonexistent one.
  - Measured safe concurrency: 6 for Greenhouse, Lever and Ashby; 2 for Paylocity.
- **Remote boards:** Remotive, RemoteOK, Himalayas, Jobicy, WorkingNomads, **WeWorkRemotely, NoDesk, Jobspresso, 4dayweek**. Also HN "Who is hiring" (Algolia) and Getro/Consider/a16z.
- `discover-ats.mjs` turns a company name into a slug and tries about 11 ATSes. Workday needs a hint.
- `scan-ats-full.mjs` sweeps public company lists for each ATS. That would mean thousands of boards: never from the VPS.
- **Missing:** Naukri, Instahyre, Cutshort, LinkedIn search. Only about 2 Indian product companies are in its examples.

**Scoring:** one overall 1–5 score across 5 dimensions with no formula.
- About 20k input tokens per job: roughly $0.003 on DeepSeek, or more through the Claude CLI.
- **Ours is cheaper, computed in code, and tested against your own jobs.**
- Worth borrowing: `calibrate.mjs` (score band vs real outcomes), and the triage mode that reads only a short brief.

**Closed postings** (`liveness-api.mjs`, then `liveness-core.mjs`):
1. The ATS's own JSON API first:
   - Greenhouse, Lever, Workable and SmartRecruiters by job ID;
   - Ashby by checking the job is still on the board;
   - a Workday 403 with `S22` means withdrawn;
   - LinkedIn guest page: closed only if the banner shows and there's no apply button.
2. Then Playwright and about 40 multilingual closed phrases. An apply button means open; a redirect that loses the job ID is "uncertain".

Ours (`job-liveness/classify.ts`) does a plain fetch with about 27 phrase and title checks, a Greenhouse error-redirect rule, an expected-title guard and age-based expiry. **No ATS API step.**

**Autofill:** an agent follows `modes/apply.md` in a fresh Playwright browser. No per-ATS code; never submits; "tested on about 12 applications". It's behind ours, but its instructions hold useful rules:
- knock-out pre-scan (years, degree, visa, salary floor);
- on Ashby's duplicate email, suggest a `+alias`;
- on Lever, leave checkboxes and radios to the user (scripted clicks trigger hCaptcha);
- Ashby may reject automated sessions;
- repeat the required-field check until no new fields appear.

**Verdict:** don't switch or run it as a whole. Its 259 KB `scan.mjs` brings file-based state with it. **Copy single provider files with the MIT notice.**

### 3.3 Form fillers (ai-job-pilot, job-apply-plugin, ApplyPilot, FormFilla)

| | Mapping | LLM calls per application | Checks its fills | Coverage | Verdict |
|---|---|---|---|---|---|
| **ai-job-pilot** (Py, MIT) | about 90 regex rules (`templates.py:833+`), then 1 strict-JSON call on a local Qwen for leftovers (`map.py:544`) | ≤ 2 local, $0 | read-back + trusted retype; **fail-closed audit before submit** (`form_audit.py`) | GH/Ashby/Lever/Workable; no repeated sections, no Workday or iCIMS | Best-engineered; borrow the audit and the rules |
| **job-apply-plugin** | the host agent does everything (Claude in Chrome) | dozens of turns, uncapped | the agent eyeballs it | "unverified" per its own README | Borrow **answer states** and **recorder-to-fixture** |
| **ApplyPilot** (AGPL) | one Sonnet Claude Code session per job | many | a prompt instruction | any site; solves captchas, auto-submits | Against our policy; no tests. Ideas only |
| **FormFilla** (TS MV3) | fuzzy rules + global one-to-one assignment, no LLM | 0 | none | generic; synthetic events (fail on React forms) | Clean code, unsuitable approach |

**Ours, measured from code:**
- Known ATSes: 0–1 Haiku call for the questions, plus 1 Sonnet call per open-text question.
- Workday and generic pages: **1 page-map call on every page, even fully understood ones.** `plans-service.ts`: "Every page: Claude's map first". That's on top of a Haiku call for the questions, plus 1 Haiku call per dropdown that doesn't match.
- Rescue, operate and navigate are extra, under caps.
- Target: ≤ $0.03 per application (`progress.ts:235`). The actual average isn't measured yet; read Progress or traces when the VPS is back.

**Head-to-head:**
- **Cost:** we're cheap on known ATS forms, and pay about 2 Haiku calls per Workday or generic page. The agent-loop tools cost 10–100× more (estimate).
- **Accuracy:** on par with ai-job-pilot (read-back, trusted input) and ahead on recipes and multi-page forms. Its audit, which blocks on anything unresolved, is the one thing it does better.
- **Coverage:** ours is the widest of any filler that checks its fills.
- **Maintainability:** `controller.ts` (1,962 lines) and `generic-driver.ts` (1,801) break our 800-line rule.

**Verified in our code (2026-11-04):**
- `recheck()` runs only in autopilot (`controller.ts`: `if (!this.autopilot …) return false`).
- The page-map cache is an in-memory `Map` (`claude/page-map.ts:239`), lost on every deploy or restart.
- The Claude answer cache key (`claude/questions.ts cacheKey`) changes with the job context, so accepted answers don't carry over between jobs.

---

## 4. Options

| Option | Gain | Loss | Verdict |
|---|---|---|---|
| A. Switch to **JobNavigator** | better dedup, more US board handlers, Telegram, DOCX | Python rewrite. Lose Workday/generic/recipes/traces/trusted input/Keka/Zoho, the scoring rubric, the server-never-contacts-sites rule | **No** |
| B. Switch to **career-ops** | 132 sources incl. Keka/Darwinbox/Zoho, ATS-API liveness | Single-user CLI on a subscription; no Naukri or LinkedIn search; scoring about 10× costlier and not computed in code; weaker autofill; not multi-user | **No** |
| C. Hybrid: run career-ops' scanner as a Job Ops extractor | many sources at once | brings its file state and a 259 KB scanner; sweeps can mean heavy VPS traffic | **No**: copy single providers instead |
| D. Replace our fill layer with ai-job-pilot, FormFilla or an agent loop | simpler code | lose Workday, generic engine, recipes, traces, coverage; agent loops cost 10–100× more | **No** |
| **E. Keep ours, borrow pieces, cut Claude calls** | the best of each, at lower cost | about 2–3 weeks of work in total, spread out | **Yes** |

Everything in E is added as a fallback or extra step. Nothing that works today is rewritten (see the "fallbacks, not rewrites" rule).

## 5. Decision and next steps

**Recommendation: E, keep and borrow.** No open-source project does the whole thing better. Our form filling is ahead of anything open; our discovery and dedup are behind career-ops and JobNavigator, and we can close that by porting small MIT files.

### Phase 1: Apply Assistant cost and accuracy (no VPS traffic; about 3–4 days)
1. **Review audit in every mode** (ai-job-pilot `form_audit.py`). At review, re-read the form and flag:
   - required fields still empty;
   - required fields that appeared after planning;
   - `aria-invalid`;
   - values that no longer read back.

   Today `recheck()` runs only in autopilot. Supervised runs show the problems; they're never auto-filled. This also stops false "done" or "applied". Effort S.
2. **Skip the page map when the page is already understood.** Call Claude only for unknown fields, repeated sections or Add buttons. Measure from traces first how often pages are fully settled. Effort S–M; saves about 1 Haiku call per page.
3. **Store the page-map cache in SQLite** instead of memory, keyed per layout and shared across users like `site_recipes`. Effort S.
4. **Reuse Claude answers you accepted** (job-apply-plugin's answer states). Add a learned answer with `how: "accepted"` for choices you approved unchanged; never textareas or protected keys. Shown as a confirm step on later forms. Effort S–M.
5. **Pre-fill warnings** (career-ops `modes/apply.md`): knock-out questions (years, degree, visa, salary floor), Ashby duplicate email (suggest `+alias`), Lever checkboxes and radios left to you. Effort a few hours each.

### Phase 2: Job Ops discovery (needs your OK for VPS traffic; about 5–7 days)
0. **Merge upstream** (20 commits, 4 conflicts; protect our rubric in `scorer.ts`). Then take PR #800 (Ashby watchlist) and #793 (keyword filters).
1. **Watchlist adapters** in `orchestrator/src/server/watchlist/adapters/` and `career-boards/`: Keka, Darwinbox and Zoho Recruit from career-ops `providers/`; Lever, SmartRecruiters and Workable from career-ops or JobNavigator. About 0.5 d each. These are one public request per followed company, the same as today's Greenhouse watchlist.
2. **Posting-ID dedup before the fuzzy match** (JobNavigator `_shared/postings.py`, plus its tests as cases), with text proof before any fuzzy merge (`same_role.py`). 2–3 d.
3. **Closed-posting check through the ATS's API first** (career-ops `liveness-api.mjs`), before our existing `classify.ts`. Add their extra phrases and false-match guards, and JobNavigator's free "missing from 2 board scrapes" signal. About 1.5 d.
4. Optional remote boards: WeWorkRemotely, 4dayweek, HN Who's Hiring. 0.5 d each.

### Phase 3: robustness and simplicity (later)
1. **Run traces become regression fixtures** (job-apply-plugin's recorder idea). Strip values from a trace's DOM snapshot, save it under `extension/test/fixtures/<system>/`, and add a golden file of expected fields and plan. This is the biggest robustness gain. Effort M.
2. **Measure rules vs Claude** per question from traces, then add `classify.ts` rules for the most common ones (relocate, onsite, travel, lives in country, SMS consent).
3. Only after measuring: merge page map and question mapping into one Haiku call per page.
4. Split `controller.ts` and `generic-driver.ts` by moving code only, with no behaviour change, under the full e2e suite.
5. Optional, Job Ops: a score-vs-outcome report (`calibrate.mjs`), and DOCX export.

### Not taking
- CAPTCHA solving (CapSolver), auto-submit, and auto sign-up/login (ApplyPilot, upstream PR #798).
- Subscription-CLI scoring; FormFilla's synthetic events.
- career-ops' full ATS sweep from the VPS.
- LinkedIn bots.

### Open questions for the user
- Phase 2 sends a little more traffic from the VPS: one request per followed company per run, plus API checks for closed postings. Is that OK, or should some of it run from your PC?
- Measure real Claude cost per application from Progress and traces once the VPS is back, before Phase 1 items 2 and 4.

## 6. Second look: where a simpler design may be more *accurate* (added 2026-11-04 at the user's prompt)

Sections 3–5 compared mostly coverage and features. **Nobody's accuracy is measured head-to-head, including ours.** Seen as precision (never put a wrong value in), the simpler tools have real advantages:

1. **Fewer layers means fewer chances to be wrong.** Ours can pass a field through:
   - site driver, generic driver, saved recipe;
   - page map, parallel read, closer read;
   - operate.

   Our own runs show errors that came from the layers:
   - Virtusa: Haiku mapped to the wrong bank key at 40% confidence.
   - SmartRecruiters: the planner added 3 blank jobs.
   - Mastercard: a bad recipe was saved as "worked", and a false "submitted".

   ai-job-pilot stops after rules plus one model call and flags the rest. JobNavigator leaves fields it doesn't recognise alone. For them, an empty field is the failure mode; for us, it's sometimes a wrong value.
2. **Guards on sensitive questions.** ai-job-pilot's `GUARD_RE` always sends sponsorship, visa, background check, arbitration and consent questions to a human. Our autopilot auto-approves drafted answers and consents, by the user's 2026-10-31 choice. A wrong answer there is worse than a stop.
3. **Learning can spread a mistake.** We save recipes and learned answers when they "worked". Mastercard's bad Skills recipe was saved as worked 1 / failed 0 and would repeat until it visibly failed. job-apply-plugin reuses only *confirmed* answers.
4. **No confidence floor.** A 40%-confidence mapping was used. FormFilla has HIGH/LOW thresholds and highlights amber fields for the user.
5. **One-to-one assignment** (FormFilla `content/matching/assignment.ts`, Kuhn–Munkres). Each profile key goes to at most one field. It was dismissed earlier together with FormFilla's synthetic events, but the algorithm can be used on its own. Its value to us is unknown: check traces for one answer landing in two fields.
6. **Cautious closed-posting rule.** career-ops calls an ambiguous redirect "uncertain"; ours expires a job that redirects to its listing page. That may expire live jobs. Check how many of our expired jobs are actually still open.

**Where ours still wins on accuracy (verified):**
- Trusted input. Synthetic events are ignored by React forms (our M0 finding).
- Read-back after every fill.
- Covering Workday multi-page, shadow DOM, Keka, Zoho and iCIMS, where the simple tools fill 0%.

**Change to the plan:** measure before adding.
- **Phase 0 (once the VPS is back), from the traces of the runs so far, per field:**
  - right;
  - wrong (you changed it, or it was flagged at review);
  - left empty;
  - which layer set it.

  That shows which layers earn their cost and which add errors.
- **Then an A/B test on fixtures:** a "lean mode" (site driver or rules, then one Claude call, then flag the rest) against the full ladder. If lean is as accurate, remove layers instead of adding them.
- **Precision fixes to add to Phase 1 regardless:**
  - autopilot always stops on legal and eligibility questions (sponsorship, visa, background, arbitration, consent);
  - a confidence floor for mappings, below which a field is flagged, not filled;
  - a recipe or learned answer counts as "worked" only after read-back *and* a clean review audit.

### Sources
- Clones are in the session scratchpad `repos/` folder, and full notes are in `notes-jobnavigator.md`, `notes-career-ops.md` and `notes-fillers.md` there (temporary; this file holds the conclusions).
- Earlier upstream review: issues and PRs on DaKheera47/job-ops, 2026-11-04.

## 7. Progress (2026-11-04, after the user's go-ahead)

The user's decisions:
- Fill as much as possible automatically: no stops on legal or eligibility questions; low-confidence answers are filled and flagged.
- More VPS traffic for job discovery is OK.
- The refactor is approved.
- Test locally while the VPS is down.

Nothing is committed or deployed.

**Apply Assistant (main working tree, uncommitted):**
- Claude's unsure answers (below 50%) are now **filled** and listed under "Worth a look before you submit" (`check` on plan entries). Before, they waited for you, and in autopilot cost an extra Claude operate call.
- The review re-check (empty-again or invalid fields filled once more) runs in **every** run, not only autopilot.
- `problems()` also lists required fields still empty, including ones that appeared late (comboboxes excluded).
- A saved recipe whose field didn't hold at review gets a failure recorded (`unlearn`), so a bad recipe stops being reused.
- The page-map cache is kept in SQLite (`page_maps` table), so a restart or deploy no longer pays again for each layout.
- Claude's choice answers still showing when you submit are remembered as `accepted` learned answers. They never override an answer you gave yourself (`kept-answers.ts`).
- **Dropped:** skipping the page map on understood pages (the user wants it on every page; it catches widget kinds), and the Lever "leave checkboxes to you" rule (conflicts with full automation).
- **Refactor (moves only):**
  - `generic-driver.ts` 1,801 → 1,099 lines (page reader to `generic-page.ts`);
  - `controller.ts` 1,984 → 1,652 lines (`run-tab.ts`, `run-page.ts`).
  - The RunController class itself is still about 1,500 lines. Splitting it means moving methods into collaborator objects, a larger change that's best done on its own with the full e2e suite.
- **Tests:**
  - server: 402 passed;
  - extension: 170 passed;
  - e2e: all suites pass except one `generic` check, which opens the live apply.hueint.com (down).

**Job Ops (worktree `D:\development\job-ops-merge`, branch `merge/upstream-0.14`, merge in progress, not committed):**
- **Upstream main merged** (20 commits, v0.14.0). The 4 conflicts were resolved by keeping ours first:
  - scorer prompt: our rubric lines plus upstream's shorter highlights;
  - startupjobs employer: ours, then upstream's as a fallback;
  - challenges: upstream's extra pause for another solve, then our skip-and-keep-the-rest fallback.
- **PR #800** (Ashby watchlist) and **#793** (include/exclude keyword filters) applied.
- **New watchlist sources:** Lever, SmartRecruiters, Keka, Darwinbox, Zoho Recruit (`watchlist/board-adapter.ts`, `watchlist/boards/`). Checked live from the PC: Keka (hr.keka.com, 41 jobs), Lever (Palantir, 305), SmartRecruiters (ServiceNow, 727, descriptions too). Darwinbox and Zoho Recruit are unit-tested only, because no real tenant was found to try.
- **Posting-ID dedup** (`shared/src/posting-key.ts`) runs before the fuzzy match, including against stored jobs.
- **Closed-posting check asks the ATS's API first** (`job-liveness/ats-api.ts`: Greenhouse, Lever, SmartRecruiters, Workday, Ashby). Only clear answers count; it works on a LinkedIn job's ATS link too.
- **Tests:** 2,622 passed. The 2 failures already fail on the current branch (WatchlistPage, salary format).
- **Local run:** the API saved and fetched Keka, Lever and SmartRecruiters sources and built an import draft.

**Waiting on the VPS:**
- Phase 0 (measure each field from the run traces).
- Traces turned into regression fixtures.
- Rules vs Claude per question.

## 8. Move off the VPS to Cloudflare Workers? (asked 2026-11-04)

**Answer: not all of it, and not for free.** Workers Free limits (developers.cloudflare.com, checked 2026-11-04):
- 10 ms CPU per request and per cron run;
- 50 outbound fetches per run;
- 5 cron triggers;
- 128 MB memory;
- D1 database up to 500 MB, 50 queries per run;
- browser rendering 10 min/day.

Containers, which would run our Docker image as it is, need Workers Paid ($5/month).

| Part | Fits Workers Free? | Why |
|---|---|---|
| Job Ops web UI (React build) | Yes | Static assets are free. |
| Job Ops API (Express, better-sqlite3, drizzle) | Only with a rewrite | Moving to D1 makes every query async. That forks us from upstream, so merges like v0.14 become hard. |
| Pipeline (discover, score, tailor) | No | One run makes hundreds of fetches and LLM calls (limit 50). Parsing a 727-job SmartRecruiters feed alone is over 10 ms of CPU. |
| JobSpy (LinkedIn/Indeed) | No | It's Python plus a Playwright browser. |
| Browser extractors (Naukri, Gradcracker, UK Visa Jobs, StartupJobs) | No | Camoufox/Playwright; 10 min/day of browser time isn't enough. Job sites also often block or challenge Worker traffic. |
| Resume PDFs | No | They spawn Tectonic or Typst; Workers can't run programs. |
| Codex / Claude CLI providers | No | Also spawned programs. |
| Apply Assistant server | Possible, with a port | Mostly waiting on Claude, which doesn't count as CPU. It needs Express swapped for Hono or the Node HTTP adapter, and node:sqlite swapped for D1. Big page-map and plan JSON may go over 10 ms of CPU. It's also useless while Job Ops is down, because it reads the job queue from Job Ops. |
| Uptime watcher | Yes, trivially | A cron Worker that checks both /health endpoints and alerts. It would have caught this outage. |

**Free option that needs no code changes:** Oracle Cloud Always Free, an ARM VM with 2 OCPUs and 12 GB of RAM (Oracle docs, 2026-11-04), 200 GB of disk and 10 TB a month of outbound data. It runs the same docker compose; the Dockerfile already builds for the target platform.
- Oracle reclaims a free VM when CPU, network and memory all stay under 20% for 7 days; a Pay-As-You-Go account (card on file, still free within the limits) is not reclaimed. Free ARM capacity in a region is sometimes unavailable ("out of host capacity").
- It has a static IP, so [no-server-ip-lookups] still applies.

**Recommendation:**
- Keep one Docker host, either the current VPS once it's back or Oracle Free.
- Add a free Cloudflare cron Worker as an uptime watcher.
- Don't port to Workers: it's a large rewrite, it can't host the browser, Python or PDF parts at all, and it would cut us off from upstream merges.
