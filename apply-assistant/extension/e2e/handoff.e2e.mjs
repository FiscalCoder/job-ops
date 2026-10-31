// A company's own job page whose Apply leads into Workday's application in the same tab (as
// Danaher's does): the run started on the company's page goes on there with Workday's own
// filler, without pausing for "the tab left the job's site".
// Stub server; nothing real.
//   node e2e/handoff.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
// On the apply server's host: the extension may script it without the all-sites permission.
const COMPANY_URL = `https://${SERVER_HOST}/test/global/en/job/R1/Engineer`;
const WORKDAY_APPLY =
  "https://acme.wd1.myworkdayjobs.com/en-US/AcmeJobs/job/Remote/Engineer_R1/apply/applyManually";

const COMPANY = `<!doctype html><html><head><title>Engineer</title></head><body>
<h1>Engineer</h1>
<form onsubmit="return false"><label for="fn">First name</label><input id="fn">
<label for="em">Email</label><input id="em" type="email"></form>
<a id="apply" href="${WORKDAY_APPLY}">Apply</a>
</body></html>`;

const WORKDAY = `<!doctype html><html><head><title>Workday</title></head><body>
<div data-automation-id="applyFlowPage">
<div data-automation-id="progressBarActiveStep">current step 1 of 4 My Information</div>
<div data-automation-id="formField-legalName--firstName"><label for="given">Given Name(s)</label><input id="given" type="text"></div>
</div></body></html>`;

const VALUES = { "First name": "Testy", Email: "testy@example.com", "Given Name(s)": "Testy" };

const posted = [];
const trail = [];
const ok = (route, data) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
const html = (route, body) =>
  route.fulfill({ status: 200, contentType: "text/html", body });

function stubServer(route, url) {
  const req = route.request();
  if (url.pathname === "/queue")
    return ok(route, [
      {
        jobId: "stub",
        title: "Engineer",
        employer: "Acme",
        score: 80,
        jobUrl: COMPANY_URL,
        applicationLink: null,
        target: { status: "none" },
        plan: null,
      },
    ]);
  if (url.pathname === "/plans/stub/page") {
    const page = req.postDataJSON();
    posted.push(page);
    return ok(route, {
      schemaHash: "x",
      jobCountry: null,
      summary: {},
      add: [],
      entries: page.fields.map((f) => ({
        ref: f.ref,
        label: f.label,
        section: "main",
        type: "text",
        required: true,
        actionClass: "auto",
        status: VALUES[f.label] ? "fill" : "skip",
        value: VALUES[f.label] ?? null,
        optionValues: null,
        source: "bank:stub",
      })),
    });
  }
  if (url.pathname.startsWith("/trace") && req.method() === "POST") {
    try {
      trail.push(...(req.postDataJSON()?.events ?? []));
    } catch {}
    return ok(route, {});
  }
  if (url.pathname === "/runs" && req.method() === "POST")
    return ok(route, { id: "stub-run" });
  if (url.pathname.startsWith("/runs/")) return ok(route, {});
  return ok(route, req.method() === "GET" ? [] : {});
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-handoff-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});
const failures = [];
let shownOnFailure = null;
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures.push(name);
};
const said = () => trail.map((e) => e.message).join(" | ");

try {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.href === COMPANY_URL) return html(route, COMPANY);
    if (url.host === SERVER_HOST) return stubServer(route, url);
    if (url.href.startsWith(WORKDAY_APPLY)) return html(route, WORKDAY);
    if (url.protocol === "chrome-extension:") return route.continue();
    return route.abort();
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() =>
    chrome.storage.local.set({
      serverUrl: "https://apply.hueint.com",
      token: "stub",
      countdownSeconds: 1,
    }),
  );
  const panel = await context.newPage();
  shownOnFailure = () => panel.locator("body").innerText();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  await panel.locator("#queue li", { hasText: "Engineer" }).first().waitFor();

  const tab = await context.newPage();
  await tab.goto(COMPANY_URL);
  await panel.bringToFront();
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  await panel
    .getByText("Check this page, then continue or submit it there yourself", { exact: false })
    .waitFor({ timeout: 60_000 });
  check("the company's page is filled", (await tab.locator("#fn").inputValue()) === "Testy");

  // Apply leads into Workday's application, in the same tab.
  await tab.locator("#apply").click();
  await tab.waitForURL(WORKDAY_APPLY, { timeout: 15_000 });
  for (let i = 0; i < 120 && (await tab.locator("#given").inputValue().catch(() => "")) !== "Testy"; i++)
    await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 40 && !/Now on Workday's application/.test(said()); i++)
    await new Promise((r) => setTimeout(r, 250));
  const workdayPlan = posted.find((p) => p.step === "My Information");
  check(
    "on Workday's application the run goes on with Workday's own filler",
    (await tab.locator("#given").inputValue()) === "Testy" &&
      workdayPlan?.step === "My Information" &&
      /Now on Workday's application \(acme\.wd1\.myworkdayjobs\.com\)/.test(said()),
    `${posted.map((p) => `${p.system}:${p.step}`).join(" ; ")} · ${said().slice(-300)}`,
  );
  check("it never paused for leaving the job's site", !/left the job's site/.test(said()), said().slice(-300));
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ")}`);
  console.log(`Trail: ${said().slice(-1200)}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
