# M0 spike: Greenhouse dry runs

Throwaway scripts that proved the form-filling approach. They are **dry runs**:
- every non-GET request is blocked, so nothing is posted and the resume is never uploaded
- Submit is never clicked
- personal values are masked in the printed report

There is no UI yet. The extension side panel arrives in M3, and the apply-assistant web page in M1/M2. To *see* what happens, use `--headed`, which opens a real browser window.

## Run with fake data (no setup)

```powershell
cd D:\development\job-ops
node apply-assistant/spike/inspect-form.mjs https://job-boards.greenhouse.io/newrelic/jobs/5453390008   # list a form's fields
node apply-assistant/spike/fill-trusted.mjs                                                            # fill 2 live forms with "Test Candidate"
```

## Run with your real Job Ops data and watch it

1. Export your Greenhouse-linked jobs and profile (read-only, runs inside the container; no third-party requests from the server):
   ```powershell
   type apply-assistant\spike\export-dbdata.cjs | ssh remote "docker exec -i job-ops sh -c 'cat > /tmp/x.cjs && echo {} | node /tmp/x.cjs; rm -f /tmp/x.cjs'" > $env:TEMP\dbdata.json
   ```
   (`{}` = no resolver hints, so only jobs whose link is already Greenhouse are included.)
2. Copy any tailored PDF from Job Ops (or download one from the Job Ops UI) to `$env:TEMP\resume.pdf`.
3. Run it with a visible browser. It pauses after each job until you press Enter:
   ```powershell
   npx tsx apply-assistant/spike/db-dry-run.ts --data $env:TEMP\dbdata.json --pdf $env:TEMP\resume.pdf --headed --only 3
   ```

What you'll see:
- the Greenhouse form opening (the Application tab is clicked first for embedded forms)
- country, name, email, phone, location and LinkedIn typed in
- dropdowns opened and picked
- the resume attach attempted (blocked)

In the terminal, each field shows ✓/✗ with its source (profile / resume / default), and every required question without an answer is listed under "needs you". That list is what the answer bank (M2) will cover.

## Findings

See §12A of `PHASE1_GREENHOUSE_PLAN.md`.
