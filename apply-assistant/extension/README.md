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
```
