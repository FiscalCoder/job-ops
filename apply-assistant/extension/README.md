# Apply Copilot (browser extension)

Runs on your PC, in Chrome or Edge. It does every third-party lookup from your browser (your IP); the
apply-assistant server never contacts Greenhouse or company sites.

- Sign in, Greenhouse lookups every 30 minutes while the browser is open (or "Run now"), the queue,
  and each job's fill plan.
- **Supervised fill** (open a plan → Start supervised fill): opens the posting and fills it one
  visible step at a time with trusted input. Auto steps count down (3 s, 1 s, or 0 = approve every
  step); protected answers and consents always wait for your click; anything missing waits for you
  (type it, "I'll do it" on the page, or skip). The resume is attached last. It stops at review:
  **you** click Submit; it then notices Greenhouse's confirmation and marks the job applied in Job
  Ops (or press "I submitted it"). Every step is logged on the server. Closing the side panel stops
  the run. Chrome shows "Apply Copilot started debugging this browser" while a run is active: that is
  the trusted input.
- **On the application page already** (say LinkedIn's Apply took you to the Ashby form): the side
  panel shows "You're on the application for …" with **Fill this page** (a supervised fill in that
  same tab) and **Apply kit**. It recognises the job's matched posting and pages under it.
- **Run trace**: every run sends its steps, your decisions, the page's navigations, console errors
  and failed requests, plus snapshots (form DOM + screenshot) at start, on a failed step, on a stall,
  at review and at the end. See them under **Timeline** on apply.hueint.com, or export one job's
  whole trail as JSON.
- **Apply kit** (the "Apply kit" button on any queued job): every answer for the job (you, links,
  work, education, this job's plan answers, sensitive answers folded away), one click each. A click
  types the answer into the field you selected on the page (allowed sites only, never LinkedIn),
  otherwise copies it. "Save resume, copy path" saves the tailored PDF to
  `Downloads/JobOps/<Employer> - <Title>/` and copies its full path: in the upload dialog press
  Ctrl+V, Enter. "Attach resume to page" puts it straight into the page's resume field. "Ask Claude"
  answers a question you paste. **I applied ✓** and **Skip job** (click twice to confirm) update Job
  Ops with its own Apply/Skip actions, so the applied date and stage are recorded. Every fill, copy
  and outcome is recorded in the job's trace.

## Install (unpacked)

```bash
cd apply-assistant/extension
npm ci
npm run build          # → .output/chrome-mv3
```

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → pick `apply-assistant/extension/.output/chrome-mv3`.
3. Click the Apply Copilot toolbar icon to open the side panel, then sign in with your Job Ops login
   (server `https://apply.hueint.com`).
4. Optional: **Allow reading company career sites** lets it find Greenhouse boards embedded on
   company careers pages.

After pulling changes: `npm run build`, then the reload icon on the extension's card.

## Tests

```bash
npm test                                   # lookup logic (fake network)
npm run build && node e2e/sidepanel.e2e.mjs <screenshot-dir>     # real Chromium + real server; needs username/password env
npm run build && node e2e/fill-dry-run.e2e.mjs <screenshot-dir>  # supervised fill on a REAL Greenhouse form; every
                                                                 # non-GET outside apply-assistant is blocked, aborted at review
npm run build && (cd .. && node --import tsx extension/e2e/kit.e2e.mjs [screenshot-dir])
                    # apply kit in real Chromium against a local apply-assistant (fake Job Ops);
                    # every hostname resolves to a local HTTPS stub (needs openssl)
```
