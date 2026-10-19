# Apply Copilot (browser extension)

Runs on your PC, in Chrome or Edge. It does every third-party lookup from your browser (your IP); the
apply-assistant server never contacts Greenhouse or company sites.

**M3a (now):** sign in, Greenhouse lookups every 30 minutes while the browser is open (or "Run now"),
the queue, and each job's fill plan.
**M3b (next):** supervised filling of the Greenhouse form, one visible step at a time.

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
npm run build && node e2e/sidepanel.e2e.mjs <screenshot-dir>   # real Chromium + real server; needs username/password env
```
