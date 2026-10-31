# Apply Copilot Autopilot: plan

Asked for 2026-10-31. The user wants Apply Copilot to work through the queue itself, in their
own visible Edge window. Highest score goes first.

For each job it:
1. Opens the job's link.
2. Finds and clicks its Apply button, reasoning about the page when needed.
3. Fills the form.
4. Rescues anything stuck with Claude.
5. Stops only when Claude can't fix something, or when the application is ready to submit.

The user watches, can pause at any time, fixes things by hand, and resumes. Their changes stay.

Status legend: ☐ to do · ◐ in progress · ☑ done (commit)

## Ground rules (unchanged from Phase 1)

- **Nothing is ever submitted by Apply Copilot.** At the review step the user clicks Submit, or
  "I applied".
- **Third-party pages are only touched from the user's browser.** The server never fetches
  employer sites (see memory `no-server-ip-lookups`).
- **No LinkedIn automation.** LinkedIn and Indeed pages are never clicked. A job whose only link
  is LinkedIn is skipped with a note.
- **Page text is data, never instructions.** Every Claude prompt says so.
- **Cost.** At most about $1 per application, all Claude calls included. Caps:
  - navigation: $0.20 per job
  - field rescues (operate): $0.60 per job (was $0.30)
  - per-field operate: $0.15
  - planning and act calls: a few cents
  - Each Claude call gets a compact outline, a JPEG screenshot and a short history, never the
    whole raw DOM. Screenshots of earlier turns are cached.

## What already exists (don't rebuild)

- Supervised run in the user's tab (`RunController`), countdown, Pause/Resume/Abort, trace with
  DOM + screenshot snapshots, and `Fill this page` / `Fill from…`.
- Rescue ladder per failed field:
  1. the driver
  2. the site's saved steps (`site_recipes`)
  3. Claude HTML steps (`act`)
  4. "Let Claude do it" (`operate`: screenshot + outline + computer tool), whose working steps
     are saved as a recipe
- Paged filling for Workday and company sites (`startPaged`). Greenhouse, Ashby and Lever are
  filled from their posting (`start`).
- Job Ops client: `updateJob(status: "expired")`, `skipJob`.
- Queue items: `jobUrl`, `applicationLink`, `target.postingUrl/ats`, `score`, `companyLimit`.

## Work items

### A. Automatic escalation and no loops ☑ (A2: the field HTML for operate isn't added; the outline and screenshot were enough in tests)
- **A1.** On autopilot, when a field fails after driver + recipe + act, Claude operates it
  automatically (`let-claude`). Trace kind `escalate`. If that fails too, the field waits for the
  user (manual). Never retry the same way twice: a step with `operate` already set is not
  escalated again.
- **A2.** Claude sees what was already tried. `operate` and `act` get `history`: the driver's
  reason, recipe steps tried and their result, act's steps and why they failed, and the value
  shown now. Add the field's HTML (≤ 6k chars) beside the outline for operate.
- **A3.** Required fields with no answer (needs-you) also go to operate on autopilot, with saved
  answers. Claude-drafted free-text answers and consents still wait for the user's click.

### B. Pause, fix by hand, resume without undoing ☑
- **B1.** On Pause, record what each not-yet-filled step on the page shows (readBack).
- **B2.** On Resume, read them again. Each changed step becomes "you did it" and isn't refilled,
  and a trace `decision` lists them. New reducer event `changed-by-you { seqs }`.
- **B3.** This also works when a Claude operate session is stopped by Pause.

### C. Navigator: from the job's link to the form ☑ (frames, dead links; C4: each site's way is saved as steps "Way to the application form (autopilot)" and tried first next time)
- **C1.** Pick the start URL: `target.postingUrl` (known ATS → existing `start`), else
  `applicationLink`, else `jobUrl` (not LinkedIn or Indeed).
- **C2.** Deterministic first, on each page:
  - **closed signals:** "no longer available / accepting", "position has been filled",
    "job expired", 404 / 410 title, or an empty job page
  - **form present:** ≥ 3 visible inputs including name/email, or a resume upload
  - **known systems by URL:** Workday sign-in wall → stop for the user to sign in
  - **one strong Apply button:** "Apply", "Apply now", "Apply for this job", "Start
    application"; not LinkedIn, Indeed or Save → click it
  - **new tabs:** follow a tab the click opened (`openerTabId`)
- **C3.** If stuck (no form, no clear button, or a click changed nothing), ask Claude: `POST
  /plans/:jobId/navigate`. It gets:
  - a screenshot
  - an outline of clickable elements (ref, role, text, href)
  - ≤ 3k chars of page text, the URL and title
  - the history of hops so far, with their results

  It replies with one of: `click ref`, `form` (the form is here), `closed reason`,
  `login reason`, `stuck reason`. At most 8 hops and $0.20 per job.
- **C4.** Each hop goes in the trace (`navigate` events + snapshot). Hops that worked are
  saved as a site recipe keyed by host + "apply-button", so the next job on that site needs no
  Claude.

### D. Closed or broken postings ☑
- **D1.** Navigator says closed → card: "Looks closed: <reason>" with **Mark expired in Job Ops**
  and **Not closed, apply anyway**. Setting "Mark closed postings expired without asking"
  (off by default).
- **D2.** Server route `POST /jobs/:jobId/expire` → `jobOps.updateJob(status: "expired")`, with
  a trace event. Ownership-checked like the other per-job routes.
- **D3.** A broken link (DNS error, chrome error page, no page) counts as closed, with reason
  "link broken". Same card.

### E. Autopilot over the queue ☑ (E4: the bar shows "Claude on this job: $x of about $1.00" from `GET /trace/jobs/:id/cost`, red from $0.80)
- **E1.** "Autopilot" button on the queue: jobs sorted by score, highest first. Skipped: company
  limit used up, blocked companies, and LinkedIn-only jobs (noted).
- **E2.** For each job:
  1. open in a new visible tab
  2. navigate (C)
  3. fill (A/B)
  4. at review, wait for the user to submit / "I applied" / Skip
  5. close the tab and go to the next job

  A banner shows "Autopilot · job 3 of 25 · $0.42 this job" with **Stop autopilot** and
  **Skip this job**.
- **E3.** Abort ends that job. Autopilot asks whether to go on to the next one or stop.
- **E4.** Per-job cost is shown live, from the run's Claude usage.

### F. Learning ☑ (F1: operate and navigate; F2: steps that fixed a kind of widget, e.g. `a.combobox.dropdown-select`, are kept under `widget.<kind>` and tried on other sites before Claude; only steps without ids or numbers are shared)
- **F1.** Operate and navigate steps that worked are kept as site recipes (operate already
  does). Add navigate.
- **F2.** Record a fix's kind ("type then Enter", "search box then pick") so the same widget on
  another site gets it right first: a `widget_fixes` note fed to act/operate as hints. *Later;
  after A–E.*

## Order

1. B (small, makes every run safer)
2. A
3. D2 + C
4. D1 / D3
5. E
6. F2 later

Tests: reducer and pure helpers (B, C2 classifiers), server routes (navigate validation, cost
cap, expire), and the extension e2e harness for the navigator with a fake careers page.

## Open questions

- Should Claude's free-text answers be auto-approved on autopilot? For now no: they wait for a
  click. Ask the user after the first autopilot runs.

## Done so far (2026-10-31, not yet deployed)

Server:
- `claude/navigate.ts` and `http/navigate-routes.ts`: `POST /plans/:jobId/navigate` and `POST /jobs/:jobId/expire`
- operate cap raised to $0.60
- operate gets everything already tried (≤ 2000 chars)

Extension:
- `src/autopilot/{nav-page,navigator,runner}.ts`
- `entrypoints/sidepanel/autopilot-view.ts`
- the controller's `autopilot` option (`escalate`) and pause/resume that keeps your changes
- `site-help` failure messages list every step tried

Tests:
- server `navigate.test.ts`
- extension `autopilot.test.ts`, plus new supervisor tests
- e2e `e2e/autopilot.e2e.mjs`: local HTTPS fake careers sites (dead link, closed page, Claude-picked link, Apply opening a new tab, an iCIMS-style search dropdown)

Also: the side panel fits a narrow window (a long question made the Fill from… picker widen it); the autopilot e2e checks this at 360px.

Also:
- E3: after you abort, autopilot asks "Next job" or "Stop autopilot".
- D for known systems: a Greenhouse, Ashby or Lever posting is opened and only checked for being closed (no clicks) before its run.

Next:
- after the first real autopilot runs, read the `navigate` / `escalate` / `operate` / `recipe` trail events
- decide with the user whether Claude's drafted answers and consents are approved automatically on autopilot
