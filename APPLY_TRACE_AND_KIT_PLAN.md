# Run trace and apply kit (plan, 2026-10-20)

Companion to [PHASE1_GREENHOUSE_PLAN.md](PHASE1_GREENHOUSE_PLAN.md). This covers two things:

- **Run trace:** a record of everything that happened on one application, detailed enough to find and fix a failure from the data alone.
- **Apply kit:** help for jobs the filler can't automate yet.

## Goals

1. **Debug from data.** When a run stalls or a field won't fill, the trail on the server is enough to find the cause and fix it. It holds what the server did, what the extension did, what the page showed, and screenshots at the key moments.
2. **Help on any site.** Where there's no filler (company sites, Workday, LinkedIn Easy Apply, SmartRecruiters), the side panel gives every answer one click away, plus the tailored resume in a known place.
3. **Learn from manual applications.** What you fill by hand is recorded per site, so the next filler is chosen from real data and can reuse those mappings.

## Decisions (agreed 2026-10-20)

| Question | Decision |
|---|---|
| LinkedIn Easy Apply | **Copy only.** The kit copies values. The resume is saved to `Downloads\JobOps\…` and its path is copied, so the upload dialog takes Ctrl+V, Enter. The extension never types into or reads LinkedIn pages. |
| Company sites | Click to fill uses the optional `https://*/*` permission, asked for once from the side panel. Without it, the kit copies only. |
| Screenshots | Only at start, on a failed step, on a stall, at review, at submit and at stop. DOM snapshots are taken at the same moments. |
| Is this tab an application? | **Rules, no LLM.** A tab counts if it was opened from the side panel or web page, opened from such a tab, or is on a known application system (§T3). |
| Values in the trace | Real values (the trace is for debugging) behind the same login. Password and one-time-code fields are always blanked. Kept 60 days with a 1 GB snapshot cap. |

## T1. Run trace

### What is recorded

All of it is keyed by Job Ops job id, so one job has a single timeline. Events also carry a run id when they belong to a supervised run.

| Source | Events |
|---|---|
| Server | lookup result recorded, plan built (counts, Claude problems) or not buildable, run started or refused, run finished, Job Ops marked Applied (or failed to), LinkedIn link captured |
| Extension (run) | run started (posting URL, plan size); each step started with its value; step filled (result) or failed (reason, what the page shows); your decisions (approve, edit, skip, did it); paused or resumed; review problems; submitted or stopped |
| Page (run) | navigations, console errors, failed requests and HTTP ≥ 400 responses to the page's own API calls, stalls (a fill busy for more than 20 s) |
| Snapshots | DOM: the form's frame with current values written into the markup, and scripts, styles, event handlers and SVG paths removed. Screenshot: JPEG of the visible tab. |
| Kit (T2) | value copied or filled into a field, with the field's description (label, name, id, type, autocomplete) and site |

### Data model (migration 6)

- `trace_events`
  - Columns: `id`, `job_id`, `run_id`, `ts`, `source` (server, extension or page), `kind`, `step_seq`, `message`, `data_json`, `snapshot_id`.
  - Indexed by (job_id, id) and (run_id, id).
- `trace_snapshots`
  - Columns: `id`, `job_id`, `run_id`, `kind` (dom or screenshot), `reason`, `url`, `bytes`, `file`, `created_at`.
  - Files live at `<APPLY_DATA_DIR>/traces/<id>.html.gz|.jpg`.
- Retention runs at start-up and every 6 h: drop anything older than 60 days, then remove the oldest snapshots while their total is over 1 GB.

### API (same login as everything else)

| Route | Purpose |
|---|---|
| `POST /trace/events` | batch of up to 200 events from the extension |
| `POST /trace/snapshots` | one DOM (text) or screenshot (base64 JPEG), up to 4 MB |
| `GET /trace/jobs` | jobs with recent trace activity, for the Timeline list |
| `GET /trace/jobs/:jobId` | the job's events and snapshot list |
| `GET /trace/snapshots/:id` | a snapshot. DOM is served with `Content-Security-Policy: sandbox`, so nothing in it can run. |
| `GET /trace/jobs/:jobId/export` | one JSON bundle: job, runs, steps, events and DOM snapshots inline. Add `?screenshots=1` to include screenshots as base64. This is what to hand over for a fix. |

### Where to look

- The **Timeline** tab on apply.hueint.com lists jobs by last activity. Each job shows its events grouped by run, with failures marked. Snapshots open in a sandboxed frame or as an image.
- From the terminal, `GET /trace/jobs/<id>/export` returns the whole trail.

### Extension side

- `TraceRecorder` (`extension/src/trace/recorder.ts`):
  - buffers events and sends them every 2 s or every 20 events;
  - holds at most 500 events and drops the oldest when full;
  - never stops a run because tracing failed.
- The run controller calls it at every step change. The page listeners (navigation, console, failed requests) are attached through the same puppeteer connection the filler uses.
- The DOM capture is a self-contained function, run in the form's frame.

## T2. Apply kit

### Server

`GET /kit/:jobId` returns the job, the apply link, the resume file name, and groups of `{key, label, value, sensitive}`:

- **You:** name, preferred name, email, phone.
- **Links:** LinkedIn, GitHub, website.
- **Location and work:** city, country, work authorization, relocation, notice period, salary, current employer and title (from the resume).
- **Education:** the latest degree from the resume.
- **This job:** answers from the job's stored plan (answer bank, rules and Claude) for its questions, and the tailored summary from Job Ops.
- **Sensitive** (collapsed until opened): protected answer-bank keys such as date of birth and EEO answers.

Two more routes:
- `POST /kit/:jobId/answer {question, options?}` gets Claude's answer to a question you paste, with the job, resume and answer bank as context. Answers are cached like plan answers. Without an Anthropic key it returns a clear error.
- `GET /jobs/:jobId/resume.pdf` already exists and is reused.

### Side panel

- Every queue item gets an **Apply kit** button, not only matched jobs.
- **Kit item:** a click fills the focused field on the current tab when that's allowed, otherwise it copies the value.
  - Fill means: find the frame whose focused element is editable, select its contents, then `insertText`. That gives a trusted input event that React forms keep, and no debugger is needed.
  - Never on linkedin.com, and only with the site permission.
  - The panel says which happened ("Filled First name on careers.acme.com" or "Copied").
- **Resume:**
  - The PDF downloads to `Downloads/JobOps/<Employer> - <Title>/<First>_<Last>_Resume.pdf`, overwriting any older copy.
  - The absolute path is copied, so in the file dialog you paste it and press Enter.
  - Needs the `downloads` permission.
- **Ask Claude:** paste a question, get an answer to copy or fill.
- **Open application:** opens the posting link (or Job Ops' link) for the job. The tab is remembered for T3.
- **I applied ✓ / Skip job** (added 2026-10-20, at your request): after applying by hand, or deciding not to.
  - Each needs a second click within 4 s.
  - The server uses Job Ops' own `POST /api/jobs/:id/apply` and `/skip` actions, so the applied date and the Applied stage are recorded.
  - Applying adds an "Applied by hand" note.
  - A job already marked Applied is refused.
  - Supervised runs now use the same apply action; they used to only change the status.
- Every copy or fill writes a `kit` trace event. For a fill it includes the field's description and site, which is the raw data for T4.

## T3. Tracked application tabs (next)

A tab is tracked for a job when one of these holds:
1. It was opened from the side panel or web page for that job.
2. It was opened from a tracked tab, or by LinkedIn's Apply button (existing capture lineage).
3. It's on a known application system: Greenhouse, Lever, Ashby, Workday (`myworkdayjobs.com`), SmartRecruiters, iCIMS, Taleo, SuccessFactors, Workable, Jobvite, BambooHR, Recruitee, Personio, Teamtailor. If no job matches, the panel asks which job it is.

Tracking ends when the tab closes, after 30 minutes idle, or at a confirmation page. A confirmation is a URL or page text like "thank you for applying" or "application received". At that point the panel asks **Mark Applied in Job Ops?** and the job is marked only when you confirm. On a tracked tab the side panel opens straight to that job's kit.

## T4. Learning (next)

- **Field mappings:** fills, and pastes that match a value just copied, turn into per-site field → answer-key mappings in a `field_observations` table. LinkedIn is excluded, because nothing is read there.
- **"Build next" report:** sites and systems ranked by how many manual applications they took. It picks the next filler.
- **Later, a generic filler:** pre-fills sites with known mappings, still supervised and still never clicking Submit.

## Status

| Part | State |
|---|---|
| T1 run trace | **deployed 2026-10-20** |
| T2 apply kit | **deployed 2026-10-20** |
| T3 tracked tabs | **deployed 2026-10-21** (see §T3 status below) |
| T4 learning | planned (kit fills already record the field data it needs) |

**Verified (2026-10-20):**
- **Server:** 286 unit tests. 7 page tests in Chromium, including the Timeline with a sandboxed snapshot (a `onerror` script in it doesn't run), a screenshot, the "only problems" filter, the export and phone width.
- **Extension:** 53 unit tests. `e2e/kit.e2e.mjs` runs in a real Chrome with the built extension against a local apply-assistant, and checks:
  - fill by click (through input events, kept by a controlled field);
  - fill inside an iframe;
  - copy when no field is selected;
  - resume attached to the resume field, not the cover-letter one;
  - resume saved with its path copied;
  - Ask Claude without a key;
  - trace events carrying the field description.
- **Live:**
  - `/kit` works for all 7 Ready jobs.
  - A dry-run supervised fill on the real Platform Science Greenhouse form (submits blocked, stopped at review) filled 9/9 steps.
  - Its full trail reached the server: steps with values, decisions, navigations, page errors, review, run end, and six snapshots (DOM 5–13 KB, screenshots 32–74 KB).

**Fixed after the first live run:**
- One invalid event (an empty console message) made the server refuse its whole batch, and the run's last events were lost.
- The server now checks events one by one and notes rejects in the trail. The extension never sends empty messages and doesn't retry a refused batch.
- The trail is sent before a run is marked finished.
- Page console errors and failed requests are shown in amber but no longer counted as problems: Greenhouse's own sign-in check returns 401 on every form.

**Known limits:**
- If the side panel is closed mid-run, events from its last ~2 s may not be sent.
- Under test automation Chrome renames downloads, so the `Downloads/JobOps/<Employer> - <Title>/` path is covered by unit tests only.

## First real batch (2026-10-21)

**What you did:**
- **Supervised fill:** GitLab on Greenhouse, submitted (17 steps).
- **By hand with the kit, all from LinkedIn:** Bank of America, Uplers and Thompsons HR, each with the resume saved and the job marked Applied.
- **Skipped from the kit:** Deloitte, Ciklum and IQVIA.
- No trace failures. In the GitLab run, 2 steps failed and 8 were edited.

| Finding (from the trail) | Fix |
|---|---|
| "Are you located in India?" (Yes/No) was planned as "India" and failed | Yes/No questions only take Yes/No rules. A new located-in rule answers from your saved country, city or state. |
| "Employment agreements with your current employer?" (Yes/No) was planned as your employer's name | Same Yes/No guard; it now goes to Claude or you |
| Race: "Field not found on the page" | Greenhouse shows Race only after its page-only "Are you Hispanic/Latino?" is answered No. The driver now answers that first, from your saved race answer. Checked on the real GitLab form. |
| "Name you'd prefer us to use" was left empty | New rule: your preferred name, else your first name |
| "Do you have publications (blog posts…)?" got your website URL | The website rule now needs a label that asks for the link |
| One ElevenLabs run was left open after an interrupted session | A new run closes the job's earlier open run |
| "I applied" / "Skip" were traced twice | Now traced once, by the server |
| Several steps were "edited" to the same value | No change: the same as Approve |

## T3 status (2026-10-21)

**What's recorded:** the background script keeps addresses, from navigation events and never page content, only for:
- job listings: LinkedIn `/jobs` pages and Naukri `job-listings`;
- application systems;
- tabs opened for a job (the kit's **Open application**, supervised fills), and tabs opened from those.

**Where:** `chrome.storage.session`, dropped after 30 minutes idle or when the tab closes (`src/track/`).

**Banner:** the side panel resolves the tab you're on, in this order:
1. its matched posting ("Fill this page");
2. its LinkedIn job, including search pages showing it;
3. its listing or saved application page (Naukri, a captured company page);
4. the tab it was opened from (LinkedIn Apply → company page → its system).

It then shows "You're on …" with Apply kit (and Fill this page where it can).

**Confirmation:** on sites the extension may read (never LinkedIn), a confirmation page (URL or text such as "Thank you for applying") asks **Mark Applied?** "Not yet" stops asking on that page.

**Tests:** `e2e/kit.e2e.mjs` (11 checks) covers LinkedIn page, then lineage to the company page, then "Not yet" and "Mark Applied". Fill this page was re-checked on the real ElevenLabs Ashby form.

**Also 2026-10-21:**
- **Tell agent** (`POST /plans/:jobId/tell`): instruct Claude for one field; its proposal goes into the Edit box.
- **Start supervised fill** inside the kit.
- **Kit actions:** steady confirm buttons, and the kit closes itself after I applied / Skip.
- **Saved search:** "Remote+onsite v1" synced with the last run's settings and given the work-eligibility rule.
